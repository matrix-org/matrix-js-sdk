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

import { ClientPrefix, type IHttpOpts, type MatrixClient, MatrixHttpApi } from "../../../src";
import { ClientRendezvousFailureReason, MSC4108RendezvousSession } from "../../../src/rendezvous";

function makeMockClient(opts: { userId: string; deviceId: string; msc4108Enabled: boolean }): MatrixClient {
    const domain = opts.userId.split(":")[1];
    const client = {
        doesServerSupportUnstableFeature(feature: string) {
            return Promise.resolve(opts.msc4108Enabled && feature === "io.element.msc4108");
        },
        getUserId() {
            return opts.userId;
        },
        getDeviceId() {
            return opts.deviceId;
        },
        baseUrl: `https://${domain}`,
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

    it("should throw an error when no server available", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: false });
        const transport = new MSC4108RendezvousSession({ client });
        await expect(transport.send("data")).rejects.toThrow("Invalid rendezvous URI");
    });

    it("POST to create rendezvous", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        fetchMock.postOnce(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
            status: 200,
            body: { id: "123", expires_ts: 0, sequence_token: "1" },
        });
        await fetchMock.flush(true);
        await expect(transport.send("data")).resolves.toStrictEqual(undefined);
    });

    it("POST with no id in response errors", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        fetchMock.postOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous", {
            status: 200,
        });
        await Promise.all([expect(transport.send("data")).rejects.toThrow(), fetchMock.flush(true)]);
    });

    it("POST and GET", async function () {
        const alice = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const sender = new MSC4108RendezvousSession({
            client: alice,
        });

        const mockId = "123";
        {
            // initial POST
            fetchMock.postOnce(`${alice.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                status: 200,
                body: { id: mockId, expires_ts: 0, sequence_token: "1" },
            });
            await expect(sender.send("foo=baa")).resolves.toStrictEqual(undefined);
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(`${alice.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                functionMatcher: (_, opts): boolean => {
                    const body = JSON.parse(opts.body as string);
                    return body.data === "foo=baa" && body.sequence_token === undefined;
                },
            });
            expect(sender.id).toBe(mockId);
        }

        const receiver = new MSC4108RendezvousSession({ id: mockId, baseUrl: alice.baseUrl });

        {
            // GET should have sequence_token from previous request
            fetchMock.getOnce(`${alice.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous/${mockId}`, {
                status: 200,
                body: { data: "foo=baa", sequence_token: "1" },
            });
            await expect(receiver.receive()).resolves.toEqual("foo=baa");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(
                `${alice.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous/${mockId}`,
                {
                    method: "GET",
                },
            );
        }
    });

    it("PUT should call GET on first use", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        const mockId = "123";

        {
            // initial POST should not have a sequence_token
            fetchMock.postOnce(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                status: 200,
                body: { id: mockId, expires_ts: 0, sequence_token: "aaa" },
            });
            await transport.send("foo=baa");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                functionMatcher: (_, opts): boolean => {
                    const body = JSON.parse(opts.body as string);
                    return body.data === "foo=baa" && body.sequence_token === undefined;
                },
            });
            expect(transport.id).toBe(mockId);
        }
        {
            // subsequent PUT which should have sequence_token from previous request
            fetchMock.putOnce(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous/${mockId}`, {
                status: 200,
                body: { sequence_token: "bbb" },
            });
            await transport.send("c=d");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(
                `${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous/${mockId}`,
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    functionMatcher: (_, opts): boolean => {
                        const body = JSON.parse(opts.body as string);
                        return body.data === "c=d" && body.sequence_token === "aaa";
                    },
                },
            );
        }
    });

    it("POST and PUT clash", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const alice = new MSC4108RendezvousSession({
            client,
        });

        const mockId = "123";

        {
            // initial POST should not have a sequence_token
            fetchMock.postOnce(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                status: 200,
                body: { id: mockId, expires_ts: 0, sequence_token: "aaa" },
            });
            await alice.send("foo=baa");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(`${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                functionMatcher: (_, opts): boolean => {
                    const body = JSON.parse(opts.body as string);
                    return body.data === "foo=baa" && body.sequence_token === undefined;
                },
            });
            expect(alice.id).toBe(mockId);
        }

        const rendezvousUrl = `${client.baseUrl}/_matrix/client/unstable/io.element.msc4108/rendezvous/${mockId}`;

        const onFailure = jest.fn();
        const bob = new MSC4108RendezvousSession({
            id: mockId,
            baseUrl: client.baseUrl,
            onFailure,
        });

        {
            // subsequent PUT which should have sequence_token from previous request
            fetchMock.getOnce(rendezvousUrl, {
                status: 200,
                body: { data: "foo=baa", sequence_token: "aaa" },
            });
            fetchMock.putOnce(rendezvousUrl, { status: 409, body: { errcode: "IO_ELEMENT_MSC4108_CONCURRENT_WRITE" } });
            await bob.send("c=d");
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(rendezvousUrl, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                functionMatcher: (_, opts): boolean => {
                    const body = JSON.parse(opts.body as string);
                    return body.data === "c=d" && body.sequence_token === "aaa";
                },
            });
            expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Unknown);
        }
    });

    it("POST and DELETE", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        {
            // Create
            fetchMock.postOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous", {
                status: 200,
                body: { id: "123", expires_ts: 0, sequence_token: "1" },
            });
            await expect(transport.send("foo=baa")).resolves.toStrictEqual(undefined);
            await fetchMock.flush(true);
            expect(fetchMock).toHaveFetched(
                "https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    functionMatcher: (_, opts): boolean => {
                        const body = JSON.parse(opts.body as string);
                        return body.data === "foo=baa" && body.sequence_token === undefined;
                    },
                },
            );
        }
        {
            // Cancel
            fetchMock.deleteOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous/123", {
                status: 200,
            });
            await transport.cancel(ClientRendezvousFailureReason.UserDeclined);
            await fetchMock.flush(true);
        }
    });

    it("send after cancelled", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        await transport.cancel(ClientRendezvousFailureReason.UserDeclined);
        await expect(transport.send("data")).resolves.toBeUndefined();
    });

    it("receive before ready", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const transport = new MSC4108RendezvousSession({
            client,
        });
        await expect(transport.receive()).rejects.toThrow();
    });

    it("404 failure callback", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const onFailure = jest.fn();
        const transport = new MSC4108RendezvousSession({
            client,
            onFailure,
        });

        fetchMock.postOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous", {
            status: 404,
        });
        await Promise.all([expect(transport.send("foo=baa")).resolves.toBeUndefined(), fetchMock.flush(true)]);
        expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Unknown);
    });

    it("404 failure callback mapped to expired", async function () {
        const client = makeMockClient({ userId: "@alice:example.com", deviceId: "DEVICEID", msc4108Enabled: true });
        const onFailure = jest.fn();
        const transport = new MSC4108RendezvousSession({
            client,
            onFailure,
        });

        {
            // initial POST
            fetchMock.postOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous", {
                status: 200,
                body: { id: "123", expires_ts: 0, sequence_token: "1" },
            });

            await transport.send("foo=baa");
            await fetchMock.flush(true);
        }
        {
            // GET with 404 to simulate expiry
            fetchMock.getOnce("https://example.com/_matrix/client/unstable/io.element.msc4108/rendezvous/123", {
                status: 404,
                body: "foo=baa",
            });
            await Promise.all([expect(transport.receive()).resolves.toBeUndefined(), fetchMock.flush(true)]);
            expect(onFailure).toHaveBeenCalledWith(ClientRendezvousFailureReason.Expired);
        }
    });
});
