/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { ClientPrefix, IHttpOpts, MatrixClient, MatrixHttpApi } from "../../../src";
import { ClientRendezvousFailureReason, MSC4108RendezvousSession } from "../../../src/rendezvous";

function makeMockClient(opts: { userId: string; deviceId: string; msc4108Enabled: boolean }): MatrixClient {
    const client = {
        doesServerSupportUnstableFeature(feature: string) {
            return Promise.resolve(opts.msc4108Enabled && feature === "org.matrix.msc4108");
        },
        getUserId() {
            return opts.userId;
        },
        getDeviceId() {
            return opts.deviceId;
        },
        baseUrl: "https://example.com",
    } as unknown as MatrixClient;
    client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
        baseUrl: client.baseUrl,
        prefix: ClientPrefix.Unstable,
        onlyData: true,
    });
    return client;
}

describe("MSC4108RendezvousSession", () => {
    let httpBackend: MockHttpBackend;
    let fetchFn: typeof global.fetch;

    beforeEach(function () {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
    });

    async function postAndCheckLocation(
        msc4108Enabled: boolean,
        fallbackRzServer: string,
        locationResponse: string,
        expectedFinalLocation: string,
    ) {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled });
        const transport = new MSC4108RendezvousSession({ client, fallbackRzServer, fetchFn });
        {
            // initial POST
            const expectedPostLocation = msc4108Enabled
                ? `${client.baseUrl}/_matrix/client/unstable/org.matrix.msc4108/rendezvous`
                : fallbackRzServer;

            const prom = transport.send("data");
            httpBackend.when("POST", expectedPostLocation).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 201,
                    headers: {
                        location: locationResponse,
                    },
                },
            };
            await httpBackend.flush("");
            await prom;
        }

        {
            // first GET without etag
            const prom = transport.receive();
            httpBackend.when("GET", expectedFinalLocation).response = {
                body: "data",
                rawBody: true,
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "text/plain",
                    },
                },
            };
            await httpBackend.flush("");
            expect(await prom).toEqual("data");
            httpBackend.verifyNoOutstandingRequests();
            httpBackend.verifyNoOutstandingExpectation();
        }
    }
    it("should throw an error when no server available", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({ client, fetchFn });
        await expect(simpleHttpTransport.send("data")).rejects.toThrow("Invalid rendezvous URI");
    });

    it("POST to fallback server", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        const prom = simpleHttpTransport.send("data");
        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            rawBody: true,
            response: {
                statusCode: 201,
                headers: {
                    location: "https://fallbackserver/rz/123",
                },
            },
        };
        await httpBackend.flush("");
        expect(await prom).toStrictEqual(undefined);
    });

    it("POST with no location", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        const prom = simpleHttpTransport.send("data");
        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            rawBody: true,
            response: {
                statusCode: 201,
                headers: {},
            },
        };
        await Promise.all([expect(prom).rejects.toThrow(), httpBackend.flush("")]);
    });

    it("POST with absolute path response", async function () {
        await postAndCheckLocation(false, "https://fallbackserver/rz", "/123", "https://fallbackserver/123");
    });

    it("POST to built-in MSC3886 implementation", async function () {
        await postAndCheckLocation(
            true,
            "https://fallbackserver/rz",
            "123",
            "https://example.com/_matrix/client/unstable/org.matrix.msc4108/rendezvous/123",
        );
    });

    it("POST with relative path response including parent", async function () {
        await postAndCheckLocation(
            false,
            "https://fallbackserver/rz/abc",
            "../xyz/123",
            "https://fallbackserver/rz/xyz/123",
        );
    });

    it("POST to follow 307 to other server", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        const prom = simpleHttpTransport.send("data");
        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            rawBody: true,
            response: {
                statusCode: 307,
                headers: {
                    location: "https://redirected.fallbackserver/rz",
                },
            },
        };
        httpBackend.when("POST", "https://redirected.fallbackserver/rz").response = {
            body: null,
            rawBody: true,
            response: {
                statusCode: 201,
                headers: {
                    location: "https://redirected.fallbackserver/rz/123",
                    etag: "aaa",
                },
            },
        };
        await httpBackend.flush("");
        expect(await prom).toStrictEqual(undefined);
    });

    it("POST and GET", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        {
            // initial POST
            const prom = simpleHttpTransport.send("foo=baa");
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, rawData }) => {
                expect(headers["content-type"]).toEqual("text/plain");
                expect(rawData).toEqual("foo=baa");
            }).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush("");
            expect(await prom).toStrictEqual(undefined);
        }
        {
            // first GET without etag
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://fallbackserver/rz/123").response = {
                body: "foo=baa",
                rawBody: true,
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "text/plain",
                        "etag": "aaa",
                    },
                },
            };
            await httpBackend.flush("");
            expect(await prom).toEqual("foo=baa");
        }
        {
            // subsequent GET which should have etag from previous request
            const prom = simpleHttpTransport.receive();
            httpBackend.when("GET", "https://fallbackserver/rz/123").check(({ headers }) => {
                expect(headers["if-none-match"]).toEqual("aaa");
            }).response = {
                body: "foo=baa",
                rawBody: true,
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "text/plain",
                        "etag": "bbb",
                    },
                },
            };
            await httpBackend.flush("");
            expect(await prom).toEqual("foo=baa");
        }
    });

    it("POST and PUTs", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        {
            // initial POST
            const prom = simpleHttpTransport.send("foo=baa");
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, rawData }) => {
                expect(headers["content-type"]).toEqual("text/plain");
                expect(rawData).toEqual("foo=baa");
            }).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush("", 1);
            await prom;
        }
        {
            // first PUT without etag
            const prom = simpleHttpTransport.send("a=b");
            httpBackend.when("PUT", "https://fallbackserver/rz/123").check(({ headers, rawData }) => {
                expect(headers["if-match"]).toBeUndefined();
                expect(rawData).toEqual("a=b");
            }).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 202,
                    headers: {
                        etag: "aaa",
                    },
                },
            };
            await httpBackend.flush("", 1);
            await prom;
        }
        {
            // subsequent PUT which should have etag from previous request
            const prom = simpleHttpTransport.send("c=d");
            httpBackend.when("PUT", "https://fallbackserver/rz/123").check(({ headers }) => {
                expect(headers["if-match"]).toEqual("aaa");
            }).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 202,
                    headers: {
                        etag: "bbb",
                    },
                },
            };
            await httpBackend.flush("", 1);
            await prom;
        }
    });

    it("POST and DELETE", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        {
            // Create
            const prom = simpleHttpTransport.send("foo=baa");
            httpBackend.when("POST", "https://fallbackserver/rz").check(({ headers, rawData }) => {
                expect(headers["content-type"]).toEqual("text/plain");
                expect(rawData).toEqual("foo=baa");
            }).response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            await httpBackend.flush("");
            expect(await prom).toStrictEqual(undefined);
        }
        {
            // Cancel
            const prom = simpleHttpTransport.cancel(ClientRendezvousFailureReason.UserDeclined);
            httpBackend.when("DELETE", "https://fallbackserver/rz/123").response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 204,
                    headers: {},
                },
            };
            await httpBackend.flush("");
            await prom;
        }
    });

    it("send after cancelled", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        await simpleHttpTransport.cancel(ClientRendezvousFailureReason.UserDeclined);
        await expect(simpleHttpTransport.send("data")).resolves.toBeUndefined();
    });

    it("receive before ready", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
        });
        await expect(simpleHttpTransport.receive()).rejects.toThrow();
    });

    it("404 failure callback", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const onFailure = jest.fn();
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
            onFailure,
        });

        httpBackend.when("POST", "https://fallbackserver/rz").response = {
            body: null,
            rawBody: true,
            response: {
                statusCode: 404,
                headers: {},
            },
        };
        await Promise.all([
            expect(simpleHttpTransport.send("foo=baa")).resolves.toBeUndefined(),
            httpBackend.flush("", 1),
        ]);
        expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Unknown);
    });

    it("404 failure callback mapped to expired", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const onFailure = jest.fn();
        const simpleHttpTransport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            fetchFn,
            onFailure,
        });

        {
            // initial POST
            const prom = simpleHttpTransport.send("foo=baa");
            httpBackend.when("POST", "https://fallbackserver/rz").response = {
                body: null,
                rawBody: true,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                        expires: "Thu, 01 Jan 1970 00:00:00 GMT",
                    },
                },
            };
            await httpBackend.flush("");
            await prom;
        }
        {
            // GET with 404 to simulate expiry
            httpBackend.when("GET", "https://fallbackserver/rz/123").response = {
                body: "foo=baa",
                rawBody: true,
                response: {
                    statusCode: 404,
                    headers: {},
                },
            };
            await Promise.all([expect(simpleHttpTransport.receive()).resolves.toBeUndefined(), httpBackend.flush("")]);
            expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Expired);
        }
    });
});
