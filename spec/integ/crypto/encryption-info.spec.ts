/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { awaitDecryption, CRYPTO_BACKENDS, emitPromise, InitCrypto, mkEvent } from "../../test-utils/test-utils";
import { logger } from "../../../src/logger";
import { ClientEvent, createClient, MatrixClient, MsgType, Room } from "../../../src";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { createCryptoCallbacks } from "../../test-utils/crypto-stubs";
import {
    DeviceId,
    EncryptionSettings,
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    OlmMachine,
    RoomId,
    RoomMessageRequest,
    SignatureUploadRequest,
    SigningKeysUploadRequest,
    ToDeviceRequest,
    UserId,
} from "../../../../matrix-rust-sdk-crypto-wasm";
import {
    BOB_TEST_DEVICE_ID,
    BOB_TEST_USER_ID,
    TEST_DEVICE_ID,
    TEST_ROOM_ID,
    TEST_USER_ID,
} from "../../test-utils/test-data";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { OutgoingRequest } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import { EventShieldColour } from "../../../src/crypto-api";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();

    fetchMock.mockReset();
});

/** get the given room from the client, or wait for it to arrive */
async function getRoomOrAwait(aliceClient: MatrixClient, roomId: string): Promise<Room> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const room = aliceClient.getRoom(roomId);
        if (room) {
            return room;
        }
        await emitPromise(aliceClient, ClientEvent.Room);
    }
}

describe.each(Object.entries(CRYPTO_BACKENDS))("encryption-info (%s)", (backend: string, initCrypto: InitCrypto) => {
    let aliceClient: MatrixClient;
    let aliceKeyReceiver: E2EKeyReceiver;
    let aliceKeyResponder: E2EKeyResponder;
    let aliceSyncResponder: SyncResponder;

    let bobOlmMachine: OlmMachine;

    beforeEach(
        async () => {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;

            const homeserverUrl = "https://alice-server.com";

            mockInitialApiRequests(homeserverUrl);

            aliceClient = createClient({
                baseUrl: homeserverUrl,
                userId: TEST_USER_ID,
                accessToken: "akjgkrgjs",
                deviceId: TEST_DEVICE_ID,
                cryptoCallbacks: createCryptoCallbacks(),
            });

            /* set up listeners for /keys/upload, /keys/query, and /sync */
            aliceKeyReceiver = new E2EKeyReceiver(homeserverUrl);
            aliceKeyResponder = new E2EKeyResponder(homeserverUrl);
            aliceKeyResponder.addKeyReceiver(TEST_USER_ID, aliceKeyReceiver);
            aliceSyncResponder = new SyncResponder(homeserverUrl);

            await initCrypto(aliceClient);
            await aliceClient.startClient();

            // we let the client do a very basic initial sync, which it needs before
            // it will upload one-time keys.
            aliceSyncResponder.sendOrQueueSyncResponse({ next_batch: 1 });

            // instantiate a rust-crypto-sdk OlmMachine which we will use to communicate with alice.
            bobOlmMachine = await createTestOlmMachine(BOB_TEST_USER_ID, BOB_TEST_DEVICE_ID);
        },
        /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */
        10000,
    );

    afterEach(() => {
        aliceClient.stopClient();
    });

    test("there should be no padlock for a message from an unverified user", async () => {
        const outgoingRequestProcessor = createTestOutgoingRequestProcessor(
            bobOlmMachine,
            aliceSyncResponder,
            aliceKeyReceiver,
        );

        await shareRoomKey(bobOlmMachine, outgoingRequestProcessor, TEST_ROOM_ID, [TEST_USER_ID]);
        const plainEventContent = { msgtype: MsgType.Text, body: "test" };
        await sendEncryptedMessage(bobOlmMachine, plainEventContent, aliceSyncResponder);

        // wait for alice to receive the message
        const room = await getRoomOrAwait(aliceClient, TEST_ROOM_ID);
        const events = room.getLiveTimeline().getEvents();
        const lastEvent = events[events.length - 1];
        await awaitDecryption(lastEvent, { waitOnDecryptionFailure: true });
        expect(lastEvent.getContent()).toEqual(plainEventContent);

        const encryptionInfo = await aliceClient.getCrypto()!.getEncryptionInfoForEvent(lastEvent);
        expect(encryptionInfo).toEqual({ shieldColour: EventShieldColour.NONE, shieldReason: null });
    });
});

async function createTestOlmMachine(userId: string, deviceId: string): Promise<OlmMachine> {
    return await OlmMachine.initialize(new UserId(userId), new DeviceId(deviceId));
}

/**
 * Build a function which takes outgoing requests from an olm machine, and feeds them into another client
 *
 * @param olmMachine
 * @param otherSyncResponder
 * @param otherKeyReceiver
 */
function createTestOutgoingRequestProcessor(
    olmMachine: OlmMachine,
    otherSyncResponder: SyncResponder,
    otherKeyReceiver: E2EKeyReceiver,
): (request: OutgoingRequest) => Promise<void> {
    const otherUserID = TEST_USER_ID;
    const otherDeviceID = TEST_DEVICE_ID;
    const ourUserID = olmMachine.userId.toString();

    const ourKeyReceiver = new E2EKeyReceiver();
    const ourKeyResponder = new E2EKeyResponder();
    ourKeyResponder.addKeyReceiver(ourUserID, ourKeyReceiver);
    ourKeyResponder.addKeyReceiver(otherUserID, otherKeyReceiver);

    async function processOutgoingRequest(request: OutgoingRequest) {
        logger.debug("TestOutgoingRequestProcessor: Processing outgoing request", request.constructor.name);

        let resp = "";

        if (request instanceof KeysUploadRequest) {
            resp = JSON.stringify(ourKeyReceiver.onKeyUploadRequest(JSON.parse(request.body)));
            resp = JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } });
        } else if (request instanceof KeysQueryRequest) {
            await otherKeyReceiver.awaitDeviceKeyUpload();
            resp = JSON.stringify(ourKeyResponder.onKeyQueryRequest(JSON.parse(request.body)));
        } else if (request instanceof KeysClaimRequest) {
            const oneTimeKeys = await otherKeyReceiver.awaitOneTimeKeyUpload();
            const keyId = Object.keys(oneTimeKeys)[0];
            resp = JSON.stringify({
                one_time_keys: {
                    [otherUserID]: {
                        [otherDeviceID]: {
                            [keyId]: oneTimeKeys[keyId],
                        },
                    },
                },
                failures: {},
            });
        } else if (request instanceof SignatureUploadRequest) {
            //resp = await this.rawJsonRequest(Method.Post, "/_matrix/client/v3/keys/signatures/upload", {}, request.body);
        } else if (request instanceof KeysBackupRequest) {
            /*resp = await this.rawJsonRequest(
                Method.Put,
                "/_matrix/client/v3/room_keys/keys",
                { version: request.version },
                request.body,
            );*/
        } else if (request instanceof ToDeviceRequest) {
            const requestBody: { messages: Record<string, any> } = JSON.parse(request.body);
            const messages = requestBody.messages;
            if (messages[otherUserID][otherDeviceID]) {
                const toDevice = {
                    type: request.event_type,
                    sender: ourUserID,
                    content: messages[otherUserID][otherDeviceID],
                };
                otherSyncResponder.sendOrQueueSyncResponse({
                    next_batch: 1,
                    to_device: { events: [toDevice] },
                });
                await otherSyncResponder.flushPendingResponse();
            }
            resp = "{}";
        } else if (request instanceof RoomMessageRequest) {
            /*
            const path =
                `/_matrix/client/v3/rooms/${encodeURIComponent(request.room_id)}/send/` +
                `${encodeURIComponent(request.event_type)}/${encodeURIComponent(request.txn_id)}`;
            resp = await this.rawJsonRequest(Method.Put, path, {}, request.body);
*/
        } else if (request instanceof SigningKeysUploadRequest) {
            /*
            resp = await this.makeRequestWithUIA(
                Method.Post,
                "/_matrix/client/v3/keys/device_signing/upload",
                {},
                request.body,
                uiaCallback,
            );
*/
        } else {
            logger.warn("Unsupported outgoing request", request.constructor.name);
            resp = "";
        }

        if (request.id) {
            await olmMachine.markRequestAsSent(request.id, request.type, resp);
        }
    }
    return processOutgoingRequest;
}

async function checkOutgoingRequests(
    olmMachine: OlmMachine,
    outgoingRequestProcessor: (request: OutgoingRequest) => Promise<void>,
): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const outgoingRequests: OutgoingRequest[] = await olmMachine.outgoingRequests();
        if (outgoingRequests.length === 0) {
            return;
        }
        for (const msg of outgoingRequests) {
            await outgoingRequestProcessor(msg);
        }
    }
}

async function shareRoomKey(
    olmMachine: OlmMachine,
    outgoingRequestProcessor: (request: OutgoingRequest) => Promise<void>,
    roomId: string,
    userIds: Array<string>,
) {
    const userIdList = userIds.map((u) => new UserId(u));
    await olmMachine.updateTrackedUsers(userIdList);
    await checkOutgoingRequests(olmMachine, outgoingRequestProcessor);

    const claimRequest: KeysClaimRequest | null = await olmMachine.getMissingSessions(userIdList);
    if (claimRequest) {
        await outgoingRequestProcessor(claimRequest);
    }

    const shareMessages: Array<ToDeviceRequest> = await olmMachine.shareRoomKey(
        new RoomId(roomId),
        userIdList,
        new EncryptionSettings(),
    );

    for (const message of shareMessages) {
        await outgoingRequestProcessor(message);
    }
}

async function sendEncryptedMessage(
    bobOlmMachine: OlmMachine,
    content: {
        body: string;
        msgtype: MsgType;
    },
    aliceSyncResponder: SyncResponder,
) {
    const encryptedContent = JSON.parse(
        await bobOlmMachine.encryptRoomEvent(new RoomId(TEST_ROOM_ID), "m.room.message", JSON.stringify(content)),
    );
    const event = mkEvent({
        room: TEST_ROOM_ID,
        type: "m.room.encrypted",
        sender: bobOlmMachine.userId.toString(),
        content: encryptedContent,
    });
    aliceSyncResponder.sendOrQueueSyncResponse({
        next_batch: 1,
        rooms: { join: { [TEST_ROOM_ID]: { timeline: { events: [event] } } } },
    });
    await aliceSyncResponder.flushPendingResponse();
    return event.event_id!;
}
