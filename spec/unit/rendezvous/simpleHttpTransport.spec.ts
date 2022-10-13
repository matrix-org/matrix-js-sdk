/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import MockHttpBackend from "matrix-mock-request";

import { RendezvousFailureReason } from "../../../src/rendezvous";
import { MSC3886SimpleHttpRendezvousTransport } from "../../../src/rendezvous/transports/simpleHttpTransport";

describe("SimpleHttpRendezvousTransport", function() {
    let httpBackend: MockHttpBackend;
    let fetchFn: typeof global.fetch;

    beforeEach(function() {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
    });

    async function postAndCheckLocation(
        fallbackRzServer: string,
        locationResponse: string,
        expectedFinalLocation: string,
    ) {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({ fallbackRzServer, fetchFn });
        { // initial POST
            const prom = simpleHttpTransport.send("application/json", {});
            httpBackend.when("POST", fallbackRzServer).response = {
                body: null,
                response: {
                    statusCode: 201,
                    headers: {
                        location: locationResponse,
                    },
                },
            };
            await httpBackend.flush('');
            await prom;
        }
        { // first GET without etag
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", expectedFinalLocation).response = {
                body: {},
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toEqual({});
            httpBackend.verifyNoOutstandingRequests();
            httpBackend.verifyNoOutstandingExpectation();
        }
    }
    it("should throw an error when no server available", function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({ fetchFn });
        expect(simpleHttpTransport.send("application/json", {})).rejects.toThrow("Invalid rendezvous URI");
    });

    it("POST to fallback server", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        const prom = simpleHttpTransport.send("application/json", {});
        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            response: {
                statusCode: 201,
                headers: {
                    location: "https://fallbackserver/rz/123",
                },
            },
        };
        await httpBackend.flush('');
        expect(await prom).toStrictEqual(undefined);
    });

    it("POST with absolute path response", async function() {
        await postAndCheckLocation("https://fallbackserver/rz", "/123", "https://fallbackserver/123");
    });

    it("POST with relative path response", async function() {
        await postAndCheckLocation("https://fallbackserver/rz", "123", "https://fallbackserver/rz/123");
    });

    it("POST with relative path response including parent", async function() {
        await postAndCheckLocation("https://fallbackserver/rz/abc", "../xyz/123", "https://fallbackserver/rz/xyz/123");
    });

    it("POST to follow 307 to other server", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        const prom = simpleHttpTransport.send("application/json", {});
        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            response: {
                statusCode: 307,
                headers: {
                    location: "https://redirected.fallbackserver/rz",
                },
            },
        };
        httpBackend.when("POST", "https://redirected.fallbackserver/rz").response = {
            body: null,
            response: {
                statusCode: 201,
                headers: {
                    location: "https://redirected.fallbackserver/rz/123",
                    etag: "aaa",
                },
            },
        };
        await httpBackend.flush('');
        expect(await prom).toStrictEqual(undefined);
    });

    it("POST and GET", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        { // initial POST
            const prom = simpleHttpTransport.send("application/json", JSON.stringify({ foo: "baa" }));
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, data }) => {
                expect(headers["content-type"]).toEqual("application/json");
                expect(data).toEqual({ foo: "baa" });
            }).response = {
                body: null,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toStrictEqual(undefined);
        }
        { // first GET without etag
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://fallbackserver/rz/123").response = {
                body: { foo: "baa" },
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                        "etag": "aaa",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toEqual({ foo: "baa" });
        }
        { // subsequent GET which should have etag from previous request
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://fallbackserver/rz/123").check(({ headers }) => {
                expect(headers["if-none-match"]).toEqual("aaa");
            }).response = {
                body: { foo: "baa" },
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                        "etag": "bbb",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toEqual({ foo: "baa" });
        }
    });

    it("POST and PUTs", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        { // initial POST
            const prom = simpleHttpTransport.send("application/json", JSON.stringify({ foo: "baa" }));
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, data }) => {
                expect(headers["content-type"]).toEqual("application/json");
                expect(data).toEqual({ foo: "baa" });
            }).response = {
                body: null,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush('', 1);
            await prom;
        }
        { // first PUT without etag
            const prom = simpleHttpTransport.send("application/json", JSON.stringify({ a: "b" }));
            httpBackend.when("PUT", "https://fallbackserver/rz/123").check(({ headers, data }) => {
                expect(headers["if-match"]).toBeUndefined();
                expect(data).toEqual({ a: "b" });
            }).response = {
                body: null,
                response: {
                    statusCode: 202,
                    headers: {
                        "etag": "aaa",
                    },
                },
            };
            await httpBackend.flush('', 1);
            await prom;
        }
        { // subsequent PUT which should have etag from previous request
            const prom = simpleHttpTransport.send("application/json", JSON.stringify({ c: "d" }));
            httpBackend.when("PUT", "https://fallbackserver/rz/123").check(({ headers }) => {
                expect(headers["if-match"]).toEqual("aaa");
            }).response = {
                body: null,
                response: {
                    statusCode: 202,
                    headers: {
                        "etag": "bbb",
                    },
                },
            };
            await httpBackend.flush('', 1);
            await prom;
        }
    });

    it("init with URI", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            rendezvousUri: "https://server/rz/123",
            fetchFn,
        });
        {
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://server/rz/123").response = {
                body: { foo: "baa" },
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                        "etag": "aaa",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toEqual({ foo: "baa" });
        }
    });

    it("init from HS", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            rendezvousUri: "https://server/rz/123",
            fetchFn,
        });
        {
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://server/rz/123").response = {
                body: { foo: "baa" },
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                        "etag": "aaa",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toEqual({ foo: "baa" });
        }
    });

    it("POST and DELETE", async function() {
        const simpleHttpTransport = new MSC3886SimpleHttpRendezvousTransport({
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        { // Create
            const prom = simpleHttpTransport.send("application/json", JSON.stringify({ foo: "baa" }));
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, data }) => {
                expect(headers["content-type"]).toEqual("application/json");
                expect(data).toEqual({ foo: "baa" });
            }).response = {
                body: null,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toStrictEqual(undefined);
        }
        { // Cancel
            const prom = simpleHttpTransport.cancel(RendezvousFailureReason.UserDeclined);
            httpBackend.when("DELETE", "https://fallbackserver/rz/123").response = {
                body: null,
                response: {
                    statusCode: 204,
                    headers: {},
                },
            };
            await httpBackend.flush('');
            await prom;
        }
    });
});
