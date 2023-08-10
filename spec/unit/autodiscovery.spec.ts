/*
Copyright 2018 New Vector Ltd
Copyright 2019, 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import fetchMock from "fetch-mock-jest";
import MockHttpBackend from "matrix-mock-request";

import { AutoDiscoveryAction, M_AUTHENTICATION } from "../../src";
import { AutoDiscovery } from "../../src/autodiscovery";
import { OidcError } from "../../src/oidc/error";
import { makeDelegatedAuthConfig } from "../test-utils/oidc";

// keep to reset the fetch function after using MockHttpBackend
// @ts-ignore private property
const realAutoDiscoveryFetch: typeof global.fetch = AutoDiscovery.fetchFn;

describe("AutoDiscovery", function () {
    const getHttpBackend = (): MockHttpBackend => {
        const httpBackend = new MockHttpBackend();
        AutoDiscovery.setFetchFn(httpBackend.fetchFn as typeof global.fetch);
        return httpBackend;
    };

    afterAll(() => {
        AutoDiscovery.setFetchFn(realAutoDiscoveryFetch);
    });

    it("should throw an error when no domain is specified", function () {
        getHttpBackend();
        return Promise.all([
            // @ts-ignore testing no args
            AutoDiscovery.findClientConfig(/* no args */).then(
                () => {
                    throw new Error("Expected a failure, not success with no args");
                },
                () => {
                    return true;
                },
            ),

            AutoDiscovery.findClientConfig("").then(
                () => {
                    throw new Error("Expected a failure, not success with an empty string");
                },
                () => {
                    return true;
                },
            ),

            AutoDiscovery.findClientConfig(null as any).then(
                () => {
                    throw new Error("Expected a failure, not success with null");
                },
                () => {
                    return true;
                },
            ),

            AutoDiscovery.findClientConfig(true as any).then(
                () => {
                    throw new Error("Expected a failure, not success with a non-string");
                },
                () => {
                    return true;
                },
            ),
        ]);
    });

    it("should return PROMPT when .well-known 404s", function () {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(404, {});
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known returns a 500 error", function () {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(500, {});
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known returns a 400 error", function () {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(400, {});
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known returns an empty body", function () {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, "");
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known returns not-JSON", async () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, "abc", true);
        const expected = {
            "m.homeserver": {
                state: "FAIL_PROMPT",
                error: AutoDiscovery.ERROR_INVALID,
                base_url: null,
            },
            "m.identity_server": {
                state: "PROMPT",
                error: null,
                base_url: null,
            },
        };
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then(expect(expected).toEqual),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known does not have a base_url for m.homeserver (empty string)", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                base_url: "",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID_HS_BASE_URL,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT when .well-known does not have a base_url for m.homeserver (no property)", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {},
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID_HS_BASE_URL,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_ERROR when .well-known has an invalid base_url for m.homeserver (disallowed scheme)", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                base_url: "mxc://example.org",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_ERROR",
                        error: AutoDiscovery.ERROR_INVALID_HS_BASE_URL,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it(
        "should return FAIL_ERROR when .well-known has an invalid base_url for " +
            "m.homeserver (verification failure: 404)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend.when("GET", "/_matrix/client/versions").respond(404, {});
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    base_url: "https://example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "FAIL_ERROR",
                            error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                            base_url: "https://example.org",
                        },
                        "m.identity_server": {
                            state: "PROMPT",
                            error: null,
                            base_url: null,
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it(
        "should return FAIL_ERROR when .well-known has an invalid base_url for " +
            "m.homeserver (verification failure: 500)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend.when("GET", "/_matrix/client/versions").respond(500, {});
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    base_url: "https://example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "FAIL_ERROR",
                            error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                            base_url: "https://example.org",
                        },
                        "m.identity_server": {
                            state: "PROMPT",
                            error: null,
                            base_url: null,
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it(
        "should return FAIL_ERROR when .well-known has an invalid base_url for " +
            "m.homeserver (verification failure: 200 but wrong content)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
                not_matrix_versions: ["v1.1"],
            });
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    base_url: "https://example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "FAIL_ERROR",
                            error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                            base_url: "https://example.org",
                        },
                        "m.identity_server": {
                            state: "PROMPT",
                            error: null,
                            base_url: null,
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it("should return SUCCESS when .well-known has a verifiably accurate base_url for m.homeserver", function () {
        const httpBackend = getHttpBackend();
        httpBackend
            .when("GET", "/_matrix/client/versions")
            .check((req) => {
                expect(req.path).toEqual("https://example.org/_matrix/client/versions");
            })
            .respond(200, {
                versions: ["v1.1"],
            });
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                base_url: "https://example.org",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://example.org",
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                    "m.authentication": {
                        state: "IGNORE",
                        error: OidcError.NotSupported,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS with the right homeserver URL", function () {
        const httpBackend = getHttpBackend();
        httpBackend
            .when("GET", "/_matrix/client/versions")
            .check((req) => {
                expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
            })
            .respond(200, {
                versions: ["v1.1"],
            });
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                // Note: we also expect this test to trim the trailing slash
                base_url: "https://chat.example.org/",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                    "m.authentication": {
                        state: "IGNORE",
                        error: OidcError.NotSupported,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS with authentication error when authentication config is invalid", function () {
        const httpBackend = getHttpBackend();
        httpBackend
            .when("GET", "/_matrix/client/versions")
            .check((req) => {
                expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
            })
            .respond(200, {
                versions: ["v1.1"],
            });
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                // Note: we also expect this test to trim the trailing slash
                base_url: "https://chat.example.org/",
            },
            "m.authentication": {
                invalid: true,
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                    "m.authentication": {
                        state: "FAIL_ERROR",
                        error: OidcError.Misconfigured,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it(
        "should return SUCCESS / FAIL_PROMPT when the identity server configuration " + "is wrong (missing base_url)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend
                .when("GET", "/_matrix/client/versions")
                .check((req) => {
                    expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
                })
                .respond(200, {
                    versions: ["v1.1"],
                });
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    // Note: we also expect this test to trim the trailing slash
                    base_url: "https://chat.example.org/",
                },
                "m.identity_server": {
                    not_base_url: "https://identity.example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "SUCCESS",
                            error: null,

                            // We still expect the base_url to be here for debugging purposes.
                            base_url: "https://chat.example.org",
                        },
                        "m.identity_server": {
                            state: "FAIL_PROMPT",
                            error: AutoDiscovery.ERROR_INVALID_IS_BASE_URL,
                            base_url: null,
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it(
        "should return SUCCESS / FAIL_PROMPT when the identity server configuration " + "is wrong (empty base_url)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend
                .when("GET", "/_matrix/client/versions")
                .check((req) => {
                    expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
                })
                .respond(200, {
                    versions: ["v1.1"],
                });
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    // Note: we also expect this test to trim the trailing slash
                    base_url: "https://chat.example.org/",
                },
                "m.identity_server": {
                    base_url: "",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "SUCCESS",
                            error: null,

                            // We still expect the base_url to be here for debugging purposes.
                            base_url: "https://chat.example.org",
                        },
                        "m.identity_server": {
                            state: "FAIL_PROMPT",
                            error: AutoDiscovery.ERROR_INVALID_IS_BASE_URL,
                            base_url: null,
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it(
        "should return SUCCESS / FAIL_PROMPT when the identity server configuration " +
            "is wrong (validation error: 404)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend
                .when("GET", "/_matrix/client/versions")
                .check((req) => {
                    expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
                })
                .respond(200, {
                    versions: ["v1.1"],
                });
            httpBackend.when("GET", "/_matrix/identity/v2").respond(404, {});
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    // Note: we also expect this test to trim the trailing slash
                    base_url: "https://chat.example.org/",
                },
                "m.identity_server": {
                    base_url: "https://identity.example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "SUCCESS",
                            error: null,

                            // We still expect the base_url to be here for debugging purposes.
                            base_url: "https://chat.example.org",
                        },
                        "m.identity_server": {
                            state: "FAIL_PROMPT",
                            error: AutoDiscovery.ERROR_INVALID_IDENTITY_SERVER,
                            base_url: "https://identity.example.org",
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it(
        "should return SUCCESS / FAIL_PROMPT when the identity server configuration " +
            "is wrong (validation error: 500)",
        function () {
            const httpBackend = getHttpBackend();
            httpBackend
                .when("GET", "/_matrix/client/versions")
                .check((req) => {
                    expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
                })
                .respond(200, {
                    versions: ["v1.1"],
                });
            httpBackend.when("GET", "/_matrix/identity/v2").respond(500, {});
            httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
                "m.homeserver": {
                    // Note: we also expect this test to trim the trailing slash
                    base_url: "https://chat.example.org/",
                },
                "m.identity_server": {
                    base_url: "https://identity.example.org",
                },
            });
            return Promise.all([
                httpBackend.flushAllExpected(),
                AutoDiscovery.findClientConfig("example.org").then((conf) => {
                    const expected = {
                        "m.homeserver": {
                            state: "SUCCESS",
                            error: null,

                            // We still expect the base_url to be here for debugging purposes
                            base_url: "https://chat.example.org",
                        },
                        "m.identity_server": {
                            state: "FAIL_PROMPT",
                            error: AutoDiscovery.ERROR_INVALID_IDENTITY_SERVER,
                            base_url: "https://identity.example.org",
                        },
                    };

                    expect(conf).toEqual(expected);
                }),
            ]);
        },
    );

    it("should return SUCCESS when the identity server configuration is verifiably accurate", function () {
        const httpBackend = getHttpBackend();
        httpBackend
            .when("GET", "/_matrix/client/versions")
            .check((req) => {
                expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
            })
            .respond(200, {
                versions: ["v1.1"],
            });
        httpBackend
            .when("GET", "/_matrix/identity/v2")
            .check((req) => {
                expect(req.path).toEqual("https://identity.example.org/_matrix/identity/v2");
            })
            .respond(200, {});
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                // Note: we also expect this test to trim the trailing slash
                base_url: "https://chat.example.org/",
            },
            "m.identity_server": {
                base_url: "https://identity.example.org",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://identity.example.org",
                    },
                    "m.authentication": {
                        state: "IGNORE",
                        error: OidcError.NotSupported,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS and preserve non-standard keys from the .well-known response", function () {
        const httpBackend = getHttpBackend();
        httpBackend
            .when("GET", "/_matrix/client/versions")
            .check((req) => {
                expect(req.path).toEqual("https://chat.example.org/_matrix/client/versions");
            })
            .respond(200, {
                versions: ["v1.1"],
            });
        httpBackend
            .when("GET", "/_matrix/identity/v2")
            .check((req) => {
                expect(req.path).toEqual("https://identity.example.org/_matrix/identity/v2");
            })
            .respond(200, {});
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                // Note: we also expect this test to trim the trailing slash
                base_url: "https://chat.example.org/",
            },
            "m.identity_server": {
                base_url: "https://identity.example.org",
            },
            "org.example.custom.property": {
                cupcakes: "yes",
            },
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "SUCCESS",
                        error: null,
                        base_url: "https://identity.example.org",
                    },
                    "org.example.custom.property": {
                        cupcakes: "yes",
                    },
                    "m.authentication": {
                        state: "IGNORE",
                        error: OidcError.NotSupported,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT for connection errors", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").fail(0, undefined!);
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT for fetch errors", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").fail(0, new Error("CORS or something"));
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_PROMPT for invalid JSON", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, "<html>", true);
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: AutoDiscovery.ERROR_INVALID,
                        base_url: null,
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should FAIL_ERROR for unsupported Matrix version", () => {
        const httpBackend = getHttpBackend();
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {
                base_url: "https://example.org",
            },
        });
        httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
            versions: ["r0.6.0"],
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: AutoDiscoveryAction.FAIL_ERROR,
                        error: AutoDiscovery.ERROR_HOMESERVER_TOO_OLD,
                        base_url: "https://example.org",
                    },
                    "m.identity_server": {
                        state: "PROMPT",
                        error: null,
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    describe("m.authentication", () => {
        const homeserverName = "example.org";
        const homeserverUrl = "https://chat.example.org/";
        const issuer = "https://auth.org/";

        beforeAll(() => {
            // make these tests independent from fetch mocking above
            AutoDiscovery.setFetchFn(realAutoDiscoveryFetch);
        });

        beforeEach(() => {
            fetchMock.resetBehavior();
            fetchMock.get(`${homeserverUrl}_matrix/client/versions`, { versions: ["v1.1"] });

            fetchMock.get("https://example.org/.well-known/matrix/client", {
                "m.homeserver": {
                    // Note: we also expect this test to trim the trailing slash
                    base_url: "https://chat.example.org/",
                },
                "m.authentication": {
                    issuer,
                },
            });
        });

        it("should return valid authentication configuration", async () => {
            const config = makeDelegatedAuthConfig(issuer);

            fetchMock.get(`${config.metadata.issuer}.well-known/openid-configuration`, config.metadata);
            fetchMock.get(`${config.metadata.issuer}jwks`, {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                keys: [],
            });

            const result = await AutoDiscovery.findClientConfig(homeserverName);

            expect(result[M_AUTHENTICATION.stable!]).toEqual({
                state: AutoDiscovery.SUCCESS,
                ...config,
                signingKeys: [],
                account: undefined,
                error: null,
            });
        });

        it("should set state to error for invalid authentication configuration", async () => {
            const config = makeDelegatedAuthConfig(issuer);
            // authorization_code is required
            config.metadata.grant_types_supported = ["openid"];

            fetchMock.get(`${config.metadata.issuer}.well-known/openid-configuration`, config.metadata);
            fetchMock.get(`${config.metadata.issuer}jwks`, {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                keys: [],
            });

            const result = await AutoDiscovery.findClientConfig(homeserverName);

            expect(result[M_AUTHENTICATION.stable!]).toEqual({
                state: AutoDiscovery.FAIL_ERROR,
                error: OidcError.OpSupport,
            });
        });
    });
});
