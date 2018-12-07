/*
Copyright 2018 New Vector Ltd

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
"use strict";

import 'source-map-support/register';
import Promise from 'bluebird';
const sdk = require("../..");
const utils = require("../test-utils");

const AutoDiscovery = sdk.AutoDiscovery;

import expect from 'expect';
import MockHttpBackend from "matrix-mock-request";


describe("AutoDiscovery", function() {
    let httpBackend = null;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        httpBackend = new MockHttpBackend();
        sdk.request(httpBackend.requestFn);
    });

    it("should throw an error when no domain is specified", function() {
        return Promise.all([
            AutoDiscovery.findClientConfig(/* no args */).then(() => {
                throw new Error("Expected a failure, not success with no args");
            }, () => {
                return true;
            }),

            AutoDiscovery.findClientConfig("").then(() => {
                throw new Error("Expected a failure, not success with an empty string");
            }, () => {
                return true;
            }),

            AutoDiscovery.findClientConfig(null).then(() => {
                throw new Error("Expected a failure, not success with null");
            }, () => {
                return true;
            }),

            AutoDiscovery.findClientConfig(true).then(() => {
                throw new Error("Expected a failure, not success with a non-string");
            }, () => {
                return true;
            }),
        ]);
    });

    it("should return PROMPT when .well-known 404s", function() {
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

    it("should return FAIL_PROMPT when .well-known returns a 500 error", function() {
        httpBackend.when("GET", "/.well-known/matrix/client").respond(500, {});
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_PROMPT when .well-known returns a 400 error", function() {
        httpBackend.when("GET", "/.well-known/matrix/client").respond(400, {});
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_PROMPT when .well-known returns an empty body", function() {
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, "");
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_PROMPT when .well-known returns not-JSON", function() {
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, "abc");
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_PROMPT when .well-known does not have a base_url for " +
        "m.homeserver (empty string)", function() {
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
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_PROMPT when .well-known does not have a base_url for " +
        "m.homeserver (no property)", function() {
        httpBackend.when("GET", "/.well-known/matrix/client").respond(200, {
            "m.homeserver": {},
        });
        return Promise.all([
            httpBackend.flushAllExpected(),
            AutoDiscovery.findClientConfig("example.org").then((conf) => {
                const expected = {
                    "m.homeserver": {
                        state: "FAIL_PROMPT",
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_ERROR when .well-known has an invalid base_url for " +
        "m.homeserver (disallowed scheme)", function() {
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
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_ERROR when .well-known has an invalid base_url for " +
        "m.homeserver (verification failure: 404)", function() {
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
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_ERROR when .well-known has an invalid base_url for " +
        "m.homeserver (verification failure: 500)", function() {
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
                        error: "Invalid homeserver discovery response",
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

    it("should return FAIL_ERROR when .well-known has an invalid base_url for " +
        "m.homeserver (verification failure: 200 but wrong content)", function() {
        httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
            not_matrix_versions: ["r0.0.1"],
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
                        error: "Invalid homeserver discovery response",
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

    it("should return SUCCESS when .well-known has a verifiably accurate base_url for " +
        "m.homeserver", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri).toEqual("https://example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
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
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS with the right homeserver URL", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
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
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_ERROR when the identity server configuration is wrong " +
        "(missing base_url)", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
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
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",

                        // We still expect the base_url to be here for debugging purposes.
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_ERROR when the identity server configuration is wrong " +
        "(empty base_url)", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
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
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",

                        // We still expect the base_url to be here for debugging purposes.
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_ERROR when the identity server configuration is wrong " +
        "(validation error: 404)", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
        });
        httpBackend.when("GET", "/_matrix/identity/api/v1").respond(404, {});
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
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",

                        // We still expect the base_url to be here for debugging purposes.
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return FAIL_ERROR when the identity server configuration is wrong " +
        "(validation error: 500)", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
        });
        httpBackend.when("GET", "/_matrix/identity/api/v1").respond(500, {});
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
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",

                        // We still expect the base_url to be here for debugging purposes
                        base_url: "https://chat.example.org",
                    },
                    "m.identity_server": {
                        state: "FAIL_ERROR",
                        error: "Invalid identity server discovery response",
                        base_url: null,
                    },
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS when the identity server configuration is " +
        "verifiably accurate", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
        });
        httpBackend.when("GET", "/_matrix/identity/api/v1").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://identity.example.org/_matrix/identity/api/v1");
        }).respond(200, {});
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
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });

    it("should return SUCCESS and preserve non-standard keys from the " +
        ".well-known response", function() {
        httpBackend.when("GET", "/_matrix/client/versions").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://chat.example.org/_matrix/client/versions");
        }).respond(200, {
            versions: ["r0.0.1"],
        });
        httpBackend.when("GET", "/_matrix/identity/api/v1").check((req) => {
            expect(req.opts.uri)
                .toEqual("https://identity.example.org/_matrix/identity/api/v1");
        }).respond(200, {});
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
                };

                expect(conf).toEqual(expected);
            }),
        ]);
    });
});
