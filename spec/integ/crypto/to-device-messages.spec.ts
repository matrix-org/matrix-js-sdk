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
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { getSyncResponse, syncPromise } from "../../test-utils/test-utils";
import {
    ClientEvent,
    createClient,
    EventType,
    type MatrixClient,
    type MatrixEvent,
    MemoryCryptoStore,
    MemoryStore,
} from "../../../src";
import * as testData from "../../test-utils/test-data";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints.ts";
import { defer } from "../../../src/utils.ts";
import { DecryptionFailureCode } from "../../../src/crypto-api";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

/**
 * Integration tests for to-device messages functionality.
 *
 * These tests work by intercepting HTTP requests via fetch-mock rather than mocking out bits of the client, so as
 * to provide the most effective integration tests possible.
 */
describe("to-device-messages", () => {
    describe("Send", () => {
        let aliceClient: MatrixClient;

        /** an object which intercepts `/keys/query` requests on the test homeserver */
        let e2eKeyResponder: E2EKeyResponder;

        beforeEach(
            async () => {
                // anything that we don't have a specific matcher for silently returns a 404
                fetchMock.catch(404);
                fetchMock.config.warnOnFallback = false;

                const homeserverUrl = "https://server.com";
                aliceClient = createClient({
                    baseUrl: homeserverUrl,
                    userId: testData.TEST_USER_ID,
                    accessToken: "akjgkrgjsalice",
                    deviceId: testData.TEST_DEVICE_ID,
                });

                e2eKeyResponder = new E2EKeyResponder(homeserverUrl);
                new E2EKeyReceiver(homeserverUrl);
                const syncResponder = new SyncResponder(homeserverUrl);

                // add bob as known user
                syncResponder.sendOrQueueSyncResponse(getSyncResponse([testData.BOB_TEST_USER_ID]));

                // Silence warnings from the backup manager
                fetchMock.getOnce(new URL("/_matrix/client/v3/room_keys/version", homeserverUrl).toString(), {
                    status: 404,
                    body: { errcode: "M_NOT_FOUND" },
                });

                fetchMock.get(new URL("/_matrix/client/v3/pushrules/", homeserverUrl).toString(), {});
                fetchMock.get(new URL("/_matrix/client/versions/", homeserverUrl).toString(), {});
                fetchMock.post(
                    new URL(
                        `/_matrix/client/v3/user/${encodeURIComponent(testData.TEST_USER_ID)}/filter`,
                        homeserverUrl,
                    ).toString(),
                    { filter_id: "fid" },
                );

                await aliceClient.initRustCrypto();
            },
            /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */
            10000,
        );

        afterEach(async () => {
            aliceClient.stopClient();
            fetchMock.mockReset();
        });

        describe("encryptToDeviceMessages", () => {
            it("returns empty batch for device that is not known", async () => {
                await aliceClient.startClient();

                const toDeviceBatch = await aliceClient
                    .getCrypto()
                    ?.encryptToDeviceMessages(
                        "m.test.event",
                        [{ userId: testData.BOB_TEST_USER_ID, deviceId: testData.BOB_TEST_DEVICE_ID }],
                        {
                            some: "content",
                        },
                    );

                expect(toDeviceBatch).toBeDefined();
                const { batch, eventType } = toDeviceBatch!;
                expect(eventType).toBe("m.room.encrypted");
                expect(batch.length).toBe(0);
            });

            it("returns encrypted batch for known device", async () => {
                await aliceClient.startClient();
                e2eKeyResponder.addDeviceKeys(testData.BOB_SIGNED_TEST_DEVICE_DATA);
                fetchMock.post("express:/_matrix/client/v3/keys/claim", () => ({
                    one_time_keys: testData.BOB_ONE_TIME_KEYS,
                }));
                await syncPromise(aliceClient);

                const toDeviceBatch = await aliceClient
                    .getCrypto()
                    ?.encryptToDeviceMessages(
                        "m.test.event",
                        [{ userId: testData.BOB_TEST_USER_ID, deviceId: testData.BOB_TEST_DEVICE_ID }],
                        {
                            some: "content",
                        },
                    );

                expect(toDeviceBatch?.batch.length).toBe(1);
                expect(toDeviceBatch?.eventType).toBe("m.room.encrypted");
                const { deviceId, payload, userId } = toDeviceBatch!.batch[0];
                expect(deviceId).toBe(testData.BOB_TEST_DEVICE_ID);
                expect(userId).toBe(testData.BOB_TEST_USER_ID);
                expect(payload.algorithm).toBe("m.olm.v1.curve25519-aes-sha2");
                expect(payload.sender_key).toEqual(expect.any(String));
                expect(payload.ciphertext).toEqual(
                    expect.objectContaining({
                        [testData.BOB_SIGNED_TEST_DEVICE_DATA.keys[`curve25519:${testData.BOB_TEST_DEVICE_ID}`]]: {
                            body: expect.any(String),
                            type: 0,
                        },
                    }),
                );

                // for future: check that bob's device can decrypt the ciphertext?
            });
        });
    });

    describe("Receive", () => {
        beforeEach(async () => {
            fetchMock.mockReset();
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;
        });

        it("Receive encrypted", async () => {
            const aliceHomeserverUrl = "https://alice.server.com";
            const aliceCryptoStore = new MemoryCryptoStore();

            const aliceClient = createClient({
                baseUrl: aliceHomeserverUrl,
                userId: "@alice:localhost",
                accessToken: "T11",
                deviceId: "alice_device",
                store: new MemoryStore(),
                cryptoStore: aliceCryptoStore,
            });

            const bobHomeserverUrl = "https://bob.server.com";
            const bobCryptoStore = new MemoryCryptoStore();

            const bobClient = createClient({
                baseUrl: bobHomeserverUrl,
                userId: "@bob:localhost",
                accessToken: "T22",
                deviceId: "bob_device",
                // store: new MemoryStore(),
                cryptoStore: bobCryptoStore,
            });

            mockInitialApiRequests(aliceClient.getHomeserverUrl(), "@alice:localhost");
            mockInitialApiRequests(bobClient.getHomeserverUrl(), "@bob:localhost");

            const aliceSyncResponder = new SyncResponder(aliceHomeserverUrl);
            const bobSyncResponder = new SyncResponder(bobHomeserverUrl);

            const aliceE2eKeyResponder = new E2EKeyResponder(aliceHomeserverUrl);
            const aliceE2eKeyReceiver = new E2EKeyReceiver(aliceHomeserverUrl);

            const bobE2eKeyResponder = new E2EKeyResponder(bobHomeserverUrl);
            const bobE2eKeyReceiver = new E2EKeyReceiver(bobHomeserverUrl);

            aliceE2eKeyResponder.addKeyReceiver("@bob:localhost", bobE2eKeyReceiver);
            bobE2eKeyResponder.addKeyReceiver("@alice:localhost", aliceE2eKeyReceiver);

            await aliceClient.initRustCrypto({ useIndexedDB: false });
            await bobClient.initRustCrypto({ useIndexedDB: false });

            // INITIAL SYNCS
            aliceSyncResponder.sendOrQueueSyncResponse({ next_batch: 1 });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            bobSyncResponder.sendOrQueueSyncResponse({ next_batch: 1 });
            await bobClient.startClient();
            await syncPromise(bobClient);

            // Make alice and bob know each other
            aliceSyncResponder.sendOrQueueSyncResponse(getSyncResponse(["@alice:localhost", "@bob:localhost"]));
            await syncPromise(aliceClient);
            bobSyncResponder.sendOrQueueSyncResponse(getSyncResponse(["@alice:localhost", "@bob:localhost"]));
            await syncPromise(bobClient);

            {
                const aliceBobDevices = await aliceClient.getCrypto()!.getUserDeviceInfo(["@bob:localhost"]);
                const aliceBobDevice = aliceBobDevices.get("@bob:localhost")?.get("bob_device");
                expect(aliceBobDevice).toBeDefined();
            }
            {
                const bobAliceDevices = await bobClient.getCrypto()!.getUserDeviceInfo(["@alice:localhost"]);
                const bobAliceDevice = bobAliceDevices.get("@alice:localhost")?.get("alice_device");
                expect(bobAliceDevice).toBeDefined();
            }

            const keys = await bobE2eKeyReceiver.awaitOneTimeKeyUpload();
            const otkId = Object.keys(keys)[0];
            const otk = keys[otkId];

            fetchMock.post("https://alice.server.com/_matrix/client/v3/keys/claim", () => ({
                one_time_keys: {
                    "@bob:localhost": {
                        bob_device: {
                            [otkId]: otk,
                        },
                    },
                },
            }));

            const toDeviceBatch = await aliceClient
                .getCrypto()
                ?.encryptToDeviceMessages("m.test.event", [{ userId: "@bob:localhost", deviceId: "bob_device" }], {
                    some: "Hello",
                });

            expect(toDeviceBatch!.batch.length).toBe(1);
            const first = toDeviceBatch!.batch[0];

            const decryptedToDeviceDefer = defer<MatrixEvent>();
            bobClient.on(ClientEvent.ToDeviceEvent, (event) => {
                decryptedToDeviceDefer.resolve(event);
            });

            // Feed that back to bob
            const syncedToDeviceEvent = {
                type: EventType.RoomMessageEncrypted,
                content: first.payload,
                sender: "@alice:localhost",
            };

            bobSyncResponder.sendOrQueueSyncResponse({
                next_batch: 2,
                to_device: {
                    events: [syncedToDeviceEvent],
                },
            });

            const event = await decryptedToDeviceDefer.promise;

            expect(event.getType()).toEqual("m.test.event");
            expect(event.getWireType()).toEqual("m.room.encrypted");
            expect(event.getClearContent()?.some).toEqual("Hello");
            expect(event.isEncrypted()).toBe(true);
            expect(event.isDecryptionFailure()).toBe(false);

            aliceClient.stopClient();
            bobClient.stopClient();
        });

        it("Receive a plain text to device", async () => {
            const aliceHomeserverUrl = "https://alice.server.com";
            const aliceCryptoStore = new MemoryCryptoStore();

            const aliceClient = createClient({
                baseUrl: aliceHomeserverUrl,
                userId: "@alice:localhost",
                accessToken: "T11",
                deviceId: "alice_device",
                store: new MemoryStore(),
                cryptoStore: aliceCryptoStore,
            });

            const aliceSyncResponder = new SyncResponder(aliceHomeserverUrl);
            mockInitialApiRequests(aliceClient.getHomeserverUrl(), "@alice:localhost");

            // INITIAL SYNCS
            aliceSyncResponder.sendOrQueueSyncResponse({ next_batch: 1 });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            const receivedToDeviceDefer = defer<MatrixEvent>();
            aliceClient.on(ClientEvent.ToDeviceEvent, (event) => {
                receivedToDeviceDefer.resolve(event);
            });

            const syncedToDeviceEvent = {
                type: "m.test.event",
                content: {
                    some: "Hello",
                },
                sender: "@alice:localhost",
            };

            aliceSyncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                to_device: {
                    events: [syncedToDeviceEvent],
                },
            });

            const receivedEvent = await receivedToDeviceDefer.promise;
            expect(receivedEvent.getType()).toEqual("m.test.event");
            expect(receivedEvent.getWireType()).toEqual("m.test.event");
            expect(receivedEvent.getClearContent()).toBe(null);
            expect(receivedEvent.getContent()?.some).toEqual("Hello");
            expect(receivedEvent.isEncrypted()).toBe(false);
            expect(receivedEvent.isDecryptionFailure()).toBe(false);

            aliceClient.stopClient();
        });

        it("Receive a UTD to device", async () => {
            const aliceHomeserverUrl = "https://alice.server.com";
            const aliceCryptoStore = new MemoryCryptoStore();

            const aliceClient = createClient({
                baseUrl: aliceHomeserverUrl,
                userId: "@alice:localhost",
                accessToken: "T11",
                deviceId: "alice_device",
                store: new MemoryStore(),
                cryptoStore: aliceCryptoStore,
            });

            const aliceE2eKeyReceiver = new E2EKeyReceiver(aliceHomeserverUrl);

            const aliceSyncResponder = new SyncResponder(aliceHomeserverUrl);
            mockInitialApiRequests(aliceClient.getHomeserverUrl(), "@alice:localhost");

            // INITIAL SYNCS
            await aliceClient.initRustCrypto({ useIndexedDB: false });
            aliceSyncResponder.sendOrQueueSyncResponse({ next_batch: 1 });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            const receivedToDeviceDefer = defer<MatrixEvent>();
            aliceClient.once(ClientEvent.ToDeviceEvent, (event) => {
                receivedToDeviceDefer.resolve(event);
            });

            const syncedToDeviceEvent = {
                content: {
                    algorithm: "m.olm.v1.curve25519-aes-sha2",
                    ciphertext: {
                        [aliceE2eKeyReceiver.getDeviceKey()]: {
                            // this payload is just captured from a sync of some other element web with other users
                            body: "Awogjvpx458CGhuo77HX/+tp1sxgRoCi7iAlzMvfrpbWoREQAiKACysX/p+ojr5QitCi9WRXNyamW2v2LTvoyWKtVaA2oHnYGR5s5RYhDfnIgh5MMSqqKlAbfqLvrbLovTYcKagCBbFnbA43f6zYM44buGgy8q70hMVH5WP6aK1E9Z3DVZ+8PnXQGpsrxvz2IsL6w0Nzl/qUyBEQFcgkjoDPawbsZRCllMgq2LQUyqlun6IgDTCozqsfxhDWpdfYGde4z16m34Ang7f5pH+BmPrFs6E1AO5+UbhhhS6NwWlfEtA6/9yfMxWLz1d2OrLh+QG7lYFAU9/CzIoPxaHKKr4JxgL9CjsmUPyDymWOWHP0jLi1NwpOv6hGpx0FgM7jJIMk6gWGgC5rEgEeTIwdrJh3F9OKTNSva5hvD9LomGk6tZgzQG6oap1e3wiOUyTt6S7BlyMppIu3RlIiNihZ9e17JEGiGDXOXzMJ6ISAgvGVgTP7+EvyEt2Wt4du7uBo/UvljRvVNu3I8tfItizPAOlvz460+aBDxk+sflJWt7OnhiyPnOCfopb+1RzqKVCnnPyVaP2f4BPf8qpn/f5YZk+5jJgBrGPiHzzmb3sQ5pC470s6+U3MpVFlFTG/xPBtMRMwPsbKoHfnRPqIqGu5dQ1Sw7T6taDXWjP450TvjxgHK5t2z1rLA2SXzAB1P8xbi6YXqQwxL6PvMNHn/TM0jiIQHYuqg5/RKLyhHybfP8JAjgNBw9z16wfKR/YoYFr7c+S4McQaMNa8v2SxGzhpCC3duAoK2qCWLEkYRO5cMCsGm/9bf8Q+//OykygBU/hdkT1eHUbexgALPLdfhzduutU7pbChg4T7SH7euh/3NLmS/SQvkmPfm3ckbh/Vlcj9CsXws/7MX/VJbhpbyzgBNtMnbG6tAeAofMa6Go/yMgiNBZIhLpAm31iUbUhaGm2IIlF/lsmSYEiBPoSVfFU44tetX2I/PBDGiBlzyU+yC2TOEBwMGxBE3WHbIe5/7sKW8xJF9t+HBfxIyW1QRtY3EKdEcuVOTyMxYzq3L5OKOOtPDHObYiiXg00mAgdQqgfkEAIfoRCOa2NYfTedwwo0S77eQ1sPvW5Hhf+Cm+bLibkWzaYHEZF+vyE9/Tn0tZGtH07RXfUyhp1vtTH49OBZHGkb/r+L8OjYJTST1dDCGqeGXO3uwYjoWHXtezLVHYgL+UOwcLJfMF5s9DQiqcfYXzp2kEWGsaetBFXcUWqq4RMHqlr6QfbxyuYLlQzc/AYA/MrT3J6nDpNLcvozH3RcIs8NcKcjdtjvgL0QGThy3RcecJQEDx3STrkkePL3dlyFCtVsmtQ0vjBBCxUgdySfxiobGGnpezZYi7q+Xz61GOZ9QqYmkcZOPzfNWeqtmzB7gqlH1gkFsK2yMAzKq2XCDFHvA7YAT3yMGiY06FcQ+2jyg7Bk2Q+AvjTG8hlPlmt6BZfW5cz1qx1apQn1qHXHrgfWcI52rApYQlNPOU1Uc8kZ8Ee6XUhhXBGY1rvZiKjKFG0PPuS8xo4/P7/u+gH5gItmEVDFL6giYPFsPpqAQkUN7hFoGiVZEjO4PwrLOmydsEcNOfACqrnUs08FQtvPg0sjHnxh6nh6FUQv93ukKl6+c9d+pCsN2xukrQ7Dog3nrjFZ6PrS5J0k9rDAOwTB55sfGXPZ2rATOK1WS4XcpsCtqwnYm4sGNc8ALMQkQ97zCnw8TcQwLvdUMlfbqQ5ykDQpQD68fITEDDHmBAeTCjpC713E6AhvOMwTJvjhd7hSkeOTRTmn9zXIVGNo1jSr8u0xO9uLGeWsV0+UlRLgp7/nsgfermjwNN8wj6MW3DHGS8UzzYfe9TGCeywqqIUTqgfXY48leGgB7twh4cl4jcOQniLATTvigIAQIvq/Uv8L45BGnkpKTdQ5F73gehXdVA",
                            type: 1,
                        },
                    },
                    sender_key: "WimPd2udAU/1S/+YBpPbmr9L+0H5H+BnAVHSwDxlPGc",
                },
                type: "m.room.encrypted",
                sender: "@bob:example.org",
            };

            aliceSyncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                to_device: {
                    events: [syncedToDeviceEvent],
                },
            });
            await syncPromise(aliceClient);

            const receivedEvent = await receivedToDeviceDefer.promise;
            expect(receivedEvent.isEncrypted()).toBe(true);
            expect(receivedEvent.isDecryptionFailure()).toBe(true);
            expect(receivedEvent.getType()).toEqual("m.room.encrypted");
            expect(receivedEvent.getWireType()).toEqual("m.room.encrypted");
            expect(receivedEvent.decryptionFailureReason).toBe(DecryptionFailureCode.UNKNOWN_ERROR);

            // Test an invalid event (no algorithm)
            {
                const receivedToDeviceDefer = Promise.withResolvers<MatrixEvent>();
                aliceClient.once(ClientEvent.ToDeviceEvent, (event) => {
                    receivedToDeviceDefer.resolve(event);
                });

                const syncedToDeviceEvent = {
                    content: {
                        // algorithm: "m.olm.v1.curve25519-aes-sha2",
                        ciphertext: {
                            [aliceE2eKeyReceiver.getDeviceKey()]: {
                                // this payload is just captured from a sync of some other element web with other users
                                body: "Awogjvpx458CGhuo77HX/+tp1sxgRoCi7iAlzMvfrpbWoREQAiKACysX/p+ojr5QitCi9WRXNyamW2v2LTvoyWKtVaA2oHnYGR5s5RYhDfnIgh5MMSqqKlAbfqLvrbLovTYcKagCBbFnbA43f6zYM44buGgy8q70hMVH5WP6aK1E9Z3DVZ+8PnXQGpsrxvz2IsL6w0Nzl/qUyBEQFcgkjoDPawbsZRCllMgq2LQUyqlun6IgDTCozqsfxhDWpdfYGde4z16m34Ang7f5pH+BmPrFs6E1AO5+UbhhhS6NwWlfEtA6/9yfMxWLz1d2OrLh+QG7lYFAU9/CzIoPxaHKKr4JxgL9CjsmUPyDymWOWHP0jLi1NwpOv6hGpx0FgM7jJIMk6gWGgC5rEgEeTIwdrJh3F9OKTNSva5hvD9LomGk6tZgzQG6oap1e3wiOUyTt6S7BlyMppIu3RlIiNihZ9e17JEGiGDXOXzMJ6ISAgvGVgTP7+EvyEt2Wt4du7uBo/UvljRvVNu3I8tfItizPAOlvz460+aBDxk+sflJWt7OnhiyPnOCfopb+1RzqKVCnnPyVaP2f4BPf8qpn/f5YZk+5jJgBrGPiHzzmb3sQ5pC470s6+U3MpVFlFTG/xPBtMRMwPsbKoHfnRPqIqGu5dQ1Sw7T6taDXWjP450TvjxgHK5t2z1rLA2SXzAB1P8xbi6YXqQwxL6PvMNHn/TM0jiIQHYuqg5/RKLyhHybfP8JAjgNBw9z16wfKR/YoYFr7c+S4McQaMNa8v2SxGzhpCC3duAoK2qCWLEkYRO5cMCsGm/9bf8Q+//OykygBU/hdkT1eHUbexgALPLdfhzduutU7pbChg4T7SH7euh/3NLmS/SQvkmPfm3ckbh/Vlcj9CsXws/7MX/VJbhpbyzgBNtMnbG6tAeAofMa6Go/yMgiNBZIhLpAm31iUbUhaGm2IIlF/lsmSYEiBPoSVfFU44tetX2I/PBDGiBlzyU+yC2TOEBwMGxBE3WHbIe5/7sKW8xJF9t+HBfxIyW1QRtY3EKdEcuVOTyMxYzq3L5OKOOtPDHObYiiXg00mAgdQqgfkEAIfoRCOa2NYfTedwwo0S77eQ1sPvW5Hhf+Cm+bLibkWzaYHEZF+vyE9/Tn0tZGtH07RXfUyhp1vtTH49OBZHGkb/r+L8OjYJTST1dDCGqeGXO3uwYjoWHXtezLVHYgL+UOwcLJfMF5s9DQiqcfYXzp2kEWGsaetBFXcUWqq4RMHqlr6QfbxyuYLlQzc/AYA/MrT3J6nDpNLcvozH3RcIs8NcKcjdtjvgL0QGThy3RcecJQEDx3STrkkePL3dlyFCtVsmtQ0vjBBCxUgdySfxiobGGnpezZYi7q+Xz61GOZ9QqYmkcZOPzfNWeqtmzB7gqlH1gkFsK2yMAzKq2XCDFHvA7YAT3yMGiY06FcQ+2jyg7Bk2Q+AvjTG8hlPlmt6BZfW5cz1qx1apQn1qHXHrgfWcI52rApYQlNPOU1Uc8kZ8Ee6XUhhXBGY1rvZiKjKFG0PPuS8xo4/P7/u+gH5gItmEVDFL6giYPFsPpqAQkUN7hFoGiVZEjO4PwrLOmydsEcNOfACqrnUs08FQtvPg0sjHnxh6nh6FUQv93ukKl6+c9d+pCsN2xukrQ7Dog3nrjFZ6PrS5J0k9rDAOwTB55sfGXPZ2rATOK1WS4XcpsCtqwnYm4sGNc8ALMQkQ97zCnw8TcQwLvdUMlfbqQ5ykDQpQD68fITEDDHmBAeTCjpC713E6AhvOMwTJvjhd7hSkeOTRTmn9zXIVGNo1jSr8u0xO9uLGeWsV0+UlRLgp7/nsgfermjwNN8wj6MW3DHGS8UzzYfe9TGCeywqqIUTqgfXY48leGgB7twh4cl4jcOQniLATTvigIAQIvq/Uv8L45BGnkpKTdQ5F73gehXdVA",
                                type: 1,
                            },
                        },
                        sender_key: "WimPd2udAU/1S/+YBpPbmr9L+0H5H+BnAVHSwDxlPGc",
                    },
                    type: "m.room.encrypted",
                    sender: "@bob:example.org",
                };

                aliceSyncResponder.sendOrQueueSyncResponse({
                    next_batch: 2,
                    to_device: {
                        events: [syncedToDeviceEvent],
                    },
                });
                await syncPromise(aliceClient);

                const receivedEvent = await receivedToDeviceDefer.promise;
                expect(receivedEvent.isEncrypted()).toBe(true);
                expect(receivedEvent.isDecryptionFailure()).toBe(true);
                expect(receivedEvent.decryptionFailureReason).toBe(DecryptionFailureCode.UNKNOWN_ERROR);
            }

            aliceClient.stopClient();
        });
    });
});
