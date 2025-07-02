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
import Olm from "@matrix-org/olm";

import { getSyncResponse, syncPromise } from "../../test-utils/test-utils";
import {
    ClientEvent,
    createClient,
    type IToDeviceEvent,
    type MatrixClient,
    type MatrixEvent,
    type ReceivedToDeviceMessage,
} from "../../../src";
import * as testData from "../../test-utils/test-data";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { encryptOlmEvent, establishOlmSession, getTestOlmAccountKeys } from "./olm-utils.ts";

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
    let aliceClient: MatrixClient;

    /** an object which intercepts `/keys/query` requests on the test homeserver */
    let e2eKeyResponder: E2EKeyResponder;
    let e2eKeyReceiver: E2EKeyReceiver;
    let syncResponder: SyncResponder;

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
            e2eKeyReceiver = new E2EKeyReceiver(homeserverUrl);
            syncResponder = new SyncResponder(homeserverUrl);

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

    describe("receive to-device-messages", () => {
        it("Should receive decrypted to-device message via ClientEvent", async () => {
            // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
            await Olm.init();
            const testOlmAccount = new Olm.Account();
            testOlmAccount.create();

            const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
            e2eKeyResponder.addDeviceKeys(testDeviceKeys);

            await aliceClient.startClient();
            await syncPromise(aliceClient);

            syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
            await syncPromise(aliceClient);

            const p2pSession = await establishOlmSession(aliceClient, e2eKeyReceiver, syncResponder, testOlmAccount);

            const toDeviceEvent = encryptOlmEvent({
                sender: "@bob:xyz",
                senderKey: testDeviceKeys.keys[`curve25519:DEVICE_ID`],
                senderSigningKey: testDeviceKeys.keys[`ed25519:DEVICE_ID`],
                p2pSession: p2pSession,
                recipient: aliceClient.getUserId()!,
                recipientCurve25519Key: e2eKeyReceiver.getDeviceKey(),
                recipientEd25519Key: e2eKeyReceiver.getSigningKey(),
                plaincontent: {
                    body: "foo",
                },
                plaintype: "m.test.type",
            });

            const processedToDeviceResolver: PromiseWithResolvers<ReceivedToDeviceMessage> = Promise.withResolvers();

            aliceClient.on(ClientEvent.ReceivedToDeviceMessage, (payload) => {
                processedToDeviceResolver.resolve(payload);
            });

            const oldToDeviceResolver: PromiseWithResolvers<MatrixEvent> = Promise.withResolvers();

            aliceClient.on(ClientEvent.ToDeviceEvent, (event) => {
                oldToDeviceResolver.resolve(event);
            });

            expect(toDeviceEvent.type).toBe("m.room.encrypted");

            syncResponder.sendOrQueueSyncResponse({ to_device: { events: [toDeviceEvent] } });
            await syncPromise(aliceClient);

            const { message, encryptionInfo } = await processedToDeviceResolver.promise;

            expect(message.type).toBe("m.test.type");
            expect(message.content["body"]).toBe("foo");

            expect(encryptionInfo).not.toBeNull();
            expect(encryptionInfo!.senderVerified).toBe(false);
            expect(encryptionInfo!.sender).toBe("@bob:xyz");
            expect(encryptionInfo!.senderDevice).toBe("DEVICE_ID");

            const oldFormat = await oldToDeviceResolver.promise;
            expect(oldFormat.isEncrypted()).toBe(true);
            expect(oldFormat.getType()).toBe("m.test.type");
            expect(oldFormat.getContent()["body"]).toBe("foo");
        });

        it("Should receive clear to-device message via ClientEvent", async () => {
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            const toDeviceEvent: IToDeviceEvent = {
                sender: "@bob:xyz",
                type: "m.test.type",
                content: {
                    body: "foo",
                },
            };

            const processedToDeviceResolver: PromiseWithResolvers<ReceivedToDeviceMessage> = Promise.withResolvers();

            aliceClient.on(ClientEvent.ReceivedToDeviceMessage, (payload) => {
                processedToDeviceResolver.resolve(payload);
            });

            const oldToDeviceResolver: PromiseWithResolvers<MatrixEvent> = Promise.withResolvers();

            aliceClient.on(ClientEvent.ToDeviceEvent, (event) => {
                oldToDeviceResolver.resolve(event);
            });

            syncResponder.sendOrQueueSyncResponse({ to_device: { events: [toDeviceEvent] } });
            await syncPromise(aliceClient);

            const { message, encryptionInfo } = await processedToDeviceResolver.promise;

            expect(message.type).toBe("m.test.type");
            expect(message.content["body"]).toBe("foo");

            // When the message is not encrypted, we don't have the encryptionInfo.
            expect(encryptionInfo).toBeNull();

            const oldFormat = await oldToDeviceResolver.promise;
            expect(oldFormat.isEncrypted()).toBe(false);
            expect(oldFormat.getType()).toBe("m.test.type");
            expect(oldFormat.getContent()["body"]).toBe("foo");
        });
    });
});
