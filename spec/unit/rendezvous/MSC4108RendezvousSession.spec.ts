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

import fetchMock from "fetch-mock-jest";

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

fetchMock.config.overwriteRoutes = true;

describe("MSC4108RendezvousSession", () => {
    beforeEach(() => {
        fetchMock.reset();
    });

    async function postAndCheckLocation(msc4108Enabled: boolean, fallbackRzServer: string, locationResponse: string) {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled });
        const transport = new MSC4108RendezvousSession({ client, fallbackRzServer });
        {
            // initial POST
            const expectedPostLocation = msc4108Enabled
                ? `${client.baseUrl}/_matrix/client/unstable/org.matrix.msc4108/rendezvous`
                : fallbackRzServer;

            fetchMock.postOnce(expectedPostLocation, {
                status: 201,
                body: { url: locationResponse },
            });
            await transport.send("data");
        }

        {
            fetchMock.get(locationResponse, {
                status: 200,
                body: "data",
                headers: {
                    "content-type": "text/plain",
                    "etag": "aaa",
                },
            });
            await expect(transport.receive()).resolves.toEqual("data");
        }
    }

    it("should use custom fetchFn if provided", async () => {
        const sandbox = fetchMock.sandbox();
        const fetchFn = jest.fn().mockImplementation(sandbox);
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fetchFn,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        sandbox.postOnce("https://fallbackserver/rz", {
            status: 201,
            body: {
                url: "https://fallbackserver/rz/123",
            },
        });
        await transport.send("data");
        await sandbox.flush(true);
        expect(fetchFn).toHaveBeenCalledWith("https://fallbackserver/rz", expect.anything());
    });

    it("should throw an error when no server available", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({ client });
        await expect(transport.send("data")).rejects.toThrow("Invalid rendezvous URI");
    });

    it("POST to fallback server", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        fetchMock.postOnce("https://fallbackserver/rz", {
            status: 201,
            body: { url: "https://fallbackserver/rz/123" },
        });
        await fetchMock.flush(true);
        await expect(transport.send("data")).resolves.toStrictEqual(undefined);
    });

    it("POST with no location", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        fetchMock.postOnce("https://fallbackserver/rz", {
            status: 201,
        });
        await Promise.all([expect(transport.send("data")).rejects.toThrow(), fetchMock.flush(true)]);
    });

    it("POST with absolute path response", async function () {
        await postAndCheckLocation(false, "https://fallbackserver/rz", "https://fallbackserver/123");
    });

    it("POST to built-in MSC3886 implementation", async function () {
        await postAndCheckLocation(
            true,
            "https://fallbackserver/rz",
            "https://example.com/_matrix/client/unstable/org.matrix.msc4108/rendezvous/123",
        );
    });

    it("POST with relative path response including parent", async function () {
        await postAndCheckLocation(false, "https://fallbackserver/rz/abc", "https://fallbackserver/rz/xyz/123");
    });

    // fetch-mock doesn't handle redirects properly, so we can't test this
    it.skip("POST to follow 307 to other server", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        fetchMock.postOnce("https://fallbackserver/rz", {
            status: 307,
            redirectUrl: "https://redirected.fallbackserver/rz",
            redirected: true,
        });
        fetchMock.postOnce("https://redirected.fallbackserver/rz", {
            status: 201,
            body: { url: "https://redirected.fallbackserver/rz/123" },
            headers: { etag: "aaa" },
        });
        await fetchMock.flush(true);
        await expect(transport.send("data")).resolves.toStrictEqual(undefined);
    });

    it("POST and GET", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        {
            // initial POST
            fetchMock.postOnce("https://fallbackserver/rz", {
                status: 201,
                body: { url: "https://fallbackserver/rz/123" },
            });
            await expect(transport.send("foo=baa")).resolves.toStrictEqual(undefined);
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched("https://fallbackserver/rz", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                functionMatcher: (_, opts): boolean => {
                    return opts.body === "foo=baa";
                },
            });
        }
        {
            // first GET without etag
            fetchMock.getOnce("https://fallbackserver/rz/123", {
                status: 200,
                body: "foo=baa",
                headers: { "content-type": "text/plain", "etag": "aaa" },
            });
            await expect(transport.receive()).resolves.toEqual("foo=baa");
            await fetchMock.flush(true);
        }
        {
            // subsequent GET which should have etag from previous request
            fetchMock.getOnce("https://fallbackserver/rz/123", {
                status: 200,
                body: "foo=baa",
                headers: { "content-type": "text/plain", "etag": "bbb" },
            });
            await expect(transport.receive()).resolves.toEqual("foo=baa");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched("https://fallbackserver/rz/123", {
                method: "GET",
                headers: { "if-none-match": "aaa" },
            });
        }
    });

    it("POST and PUTs", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        {
            // initial POST
            fetchMock.postOnce("https://fallbackserver/rz", {
                status: 201,
                body: { url: "https://fallbackserver/rz/123" },
                headers: { etag: "aaa" },
            });
            await transport.send("foo=baa");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched("https://fallbackserver/rz", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                functionMatcher: (_, opts): boolean => {
                    return opts.body === "foo=baa";
                },
            });
        }
        {
            // subsequent PUT which should have etag from previous request
            fetchMock.putOnce("https://fallbackserver/rz/123", { status: 202, headers: { etag: "bbb" } });
            await transport.send("c=d");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched("https://fallbackserver/rz/123", {
                method: "PUT",
                headers: { "if-match": "aaa" },
            });
        }
    });

    it("POST and DELETE", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        {
            // Create
            fetchMock.postOnce("https://fallbackserver/rz", {
                status: 201,
                body: { url: "https://fallbackserver/rz/123" },
            });
            await expect(transport.send("foo=baa")).resolves.toStrictEqual(undefined);
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched("https://fallbackserver/rz", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                functionMatcher: (_, opts): boolean => {
                    return opts.body === "foo=baa";
                },
            });
        }
        {
            // Cancel
            fetchMock.deleteOnce("https://fallbackserver/rz/123", { status: 204 });
            await transport.cancel(ClientRendezvousFailureReason.UserDeclined);
            await fetchMock.flush(true);
        }
    });

    it("send after cancelled", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        await transport.cancel(ClientRendezvousFailureReason.UserDeclined);
        await expect(transport.send("data")).resolves.toBeUndefined();
    });

    it("receive before ready", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
        });
        await expect(transport.receive()).rejects.toThrow();
    });

    it("404 failure callback", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const onFailure = jest.fn();
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            onFailure,
        });

        fetchMock.postOnce("https://fallbackserver/rz", { status: 404 });
        await Promise.all([expect(transport.send("foo=baa")).resolves.toBeUndefined(), fetchMock.flush(true)]);
        expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Unknown);
    });

    it("404 failure callback mapped to expired", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const onFailure = jest.fn();
        const transport = new MSC4108RendezvousSession({
            client,
            fallbackRzServer: "https://fallbackserver/rz",
            onFailure,
        });

        {
            // initial POST
            fetchMock.postOnce("https://fallbackserver/rz", {
                status: 201,
                body: { url: "https://fallbackserver/rz/123" },
                headers: { expires: "Thu, 01 Jan 1970 00:00:00 GMT" },
            });

            await transport.send("foo=baa");
            await fetchMock.flush(true);
        }
        {
            // GET with 404 to simulate expiry
            fetchMock.getOnce("https://fallbackserver/rz/123", { status: 404, body: "foo=baa" });
            await Promise.all([expect(transport.receive()).resolves.toBeUndefined(), fetchMock.flush(true)]);
            expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Expired);
        }
    });
});
