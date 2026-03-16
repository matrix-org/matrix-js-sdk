/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import "fake-indexeddb/auto";
import fetchMock from "@fetch-mock/vitest";
import mkDebug from "debug";

import {
    createClient,
    DebugLogger,
    EventType,
    HistoryVisibility,
    type IContent,
    type ILeftRoom,
    type IRoomEvent,
    KnownMembership,
    type MatrixClient,
    MsgType,
} from "../../../src";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver.ts";
import { SyncResponder } from "../../test-utils/SyncResponder.ts";
import { mockInitialApiRequests, mockSetupCrossSigningRequests } from "../../test-utils/mockEndpoints.ts";
import { getSyncResponse, mkEventCustom, syncPromise, waitFor } from "../../test-utils/test-utils.ts";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";
import { E2EOTKClaimResponder } from "../../test-utils/E2EOTKClaimResponder.ts";
import { escapeRegExp, sleep } from "../../../src/utils.ts";
import { EventShieldColour, EventShieldReason } from "../../../src/crypto-api";
import {
    BACKUP_DECRYPTION_KEY_BASE64,
    CLEAR_EVENT,
    ENCRYPTED_EVENT,
    SIGNED_BACKUP_DATA,
    TEST_ROOM_ID,
    TEST_USER_ID,
    PER_ROOM_CURVE25519_KEY_BACKUP_DATA,
} from "../../test-utils/test-data";

const debug = mkDebug("matrix-js-sdk:history-sharing");

// load the rust library. This can take a few seconds on a slow GH worker.
beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RustSdkCryptoJs = await require("@matrix-org/matrix-sdk-crypto-wasm");
    await RustSdkCryptoJs.initAsync();
}, 10000);

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

const ROOM_ID = "!room:example.com";
const ALICE_HOMESERVER_URL = "https://alice-server.com";
const BOB_HOMESERVER_URL = "https://bob-server.com";

async function createAndInitClient(homeserverUrl: string, userId: string, setupNewCrossSigning = true) {
    mockInitialApiRequests(homeserverUrl, userId);

    const client = createClient({
        baseUrl: homeserverUrl,
        userId: userId,
        accessToken: "akjgkrgjs",
        deviceId: "xzcvb",
        logger: new DebugLogger(mkDebug(`matrix-js-sdk:${userId}`)),
    });

    await client.initRustCrypto({ cryptoDatabasePrefix: userId });
    await client.startClient();
    await client.getCrypto()!.bootstrapCrossSigning({ setupNewCrossSigning });
    return client;
}

describe("History Sharing", () => {
    let aliceClient: MatrixClient;
    let aliceSyncResponder: SyncResponder;
    let bobClient: MatrixClient;
    let bobSyncResponder: SyncResponder;

    beforeEach(async () => {
        // anything that we don't have a specific matcher for silently returns a 404
        fetchMock.catch(404);

        mockSetupCrossSigningRequests();

        const aliceId = TEST_USER_ID;
        const bobId = "@bob:xyz";

        const aliceKeyReceiver = new E2EKeyReceiver(ALICE_HOMESERVER_URL, "alice-");
        const aliceKeyResponder = new E2EKeyResponder(ALICE_HOMESERVER_URL);
        const aliceKeyClaimResponder = new E2EOTKClaimResponder(ALICE_HOMESERVER_URL);
        aliceSyncResponder = new SyncResponder(ALICE_HOMESERVER_URL);

        const bobKeyReceiver = new E2EKeyReceiver(BOB_HOMESERVER_URL, "bob-");
        const bobKeyResponder = new E2EKeyResponder(BOB_HOMESERVER_URL);
        bobSyncResponder = new SyncResponder(BOB_HOMESERVER_URL);

        aliceKeyResponder.addKeyReceiver(aliceId, aliceKeyReceiver);
        aliceKeyResponder.addKeyReceiver(bobId, bobKeyReceiver);
        bobKeyResponder.addKeyReceiver(aliceId, aliceKeyReceiver);
        bobKeyResponder.addKeyReceiver(bobId, bobKeyReceiver);

        aliceClient = await createAndInitClient(ALICE_HOMESERVER_URL, aliceId);
        bobClient = await createAndInitClient(BOB_HOMESERVER_URL, bobId);

        aliceKeyClaimResponder.addKeyReceiver(bobId, bobClient.deviceId!, bobKeyReceiver);

        aliceSyncResponder.sendOrQueueSyncResponse({});
        await syncPromise(aliceClient);

        bobSyncResponder.sendOrQueueSyncResponse({});
        await syncPromise(bobClient);
    });

    test("Room keys are successfully shared on invite", async () => {
        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hi!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Alice invites Bob, and shares the room history with them.
        await assertInviteAndShareHistory(ROOM_ID);

        // Bob receives, should be able to decrypt, the megolm message
        const event = await bobReceivesEvent(
            aliceClient,
            bobClient,
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
                room_id: ROOM_ID,
            }),
            bobSyncResponder,
        );
        expect(event.getId()).toEqual("$event_id");
        await event.getDecryptionPromise();
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual("Hi!");
        expect(event.getKeyForwardingUser()).toEqual(aliceClient.getUserId());
        const encryptionInfo = await bobClient.getCrypto()!.getEncryptionInfoForEvent(event);
        expect(encryptionInfo?.shieldColour).toEqual(EventShieldColour.GREY);
        expect(encryptionInfo?.shieldReason).toEqual(EventShieldReason.AUTHENTICITY_NOT_GUARANTEED);
    });

    test("Room keys are imported correctly if invite is accepted before the bundle arrives", async () => {
        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest();
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });

        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        // Bob receives the room invite, but not the room key bundle
        const inviteEvent = mkInviteEvent(aliceClient, bobClient);
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
        });
        await syncPromise(bobClient);

        // Bob joins the room
        const room = bobClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);
        fetchMock.postOnce(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });
        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Bob receives and attempts to decrypt the megolm message, but should not be able to (yet).
        const event = await bobReceivesEvent(
            aliceClient,
            bobClient,
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
                room_id: ROOM_ID,
            }),
            bobSyncResponder,
        );
        await event.getDecryptionPromise();
        expect(event.isDecryptionFailure()).toBeTruthy();

        // Now the room key bundle message arrives
        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        bobSyncResponder.sendOrQueueSyncResponse({
            to_device: {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: aliceClient.getSafeUserId(),
                        content: bobToDeviceMessage,
                    },
                ],
            },
        });
        await syncPromise(bobClient);

        // Once the room key bundle finishes downloading, we should be able to decrypt the message.
        await waitFor(async () => {
            await event.getDecryptionPromise();
            expect(event.isDecryptionFailure()).toBeFalsy();
        });
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual("Hello!");
        expect(event.getKeyForwardingUser()).toEqual(aliceClient.getUserId());
        const encryptionInfo = await bobClient.getCrypto()!.getEncryptionInfoForEvent(event);
        expect(encryptionInfo?.shieldColour).toEqual(EventShieldColour.GREY);
        expect(encryptionInfo?.shieldReason).toEqual(EventShieldReason.AUTHENTICITY_NOT_GUARANTEED);
    });

    test("Room keys are not imported if the bundle arrives more than 24H after the invite is accepted", async () => {
        vitest.useFakeTimers();

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest();
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });

        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        // Bob receives the room invite, but not the room key bundle
        const inviteEvent = mkInviteEvent(aliceClient, bobClient);
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
        });
        await syncPromise(bobClient);

        // Bob joins the room
        const room = bobClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);
        fetchMock.postOnce(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });
        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Bob receives and attempts to decrypt the megolm message, but should not be able to (yet).
        const event = await bobReceivesEvent(
            aliceClient,
            bobClient,
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
                room_id: ROOM_ID,
            }),
            bobSyncResponder,
        );
        await event.getDecryptionPromise();
        expect(event.isDecryptionFailure()).toBeTruthy();

        // 24 hours elapse before the room key bundle message arrives.
        vitest.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        bobSyncResponder.sendOrQueueSyncResponse({
            to_device: {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: aliceClient.getSafeUserId(),
                        content: bobToDeviceMessage,
                    },
                ],
            },
        });
        await syncPromise(bobClient);

        // Wait a bit to ensure the event is not decrypted.
        for (let i = 0; i < 10; i++) {
            await vitest.advanceTimersByTimeAsync(10);
        }

        expect(event.isDecryptionFailure()).toBeTruthy();
    });

    test("Room keys are not imported if we left and rejoined the room after accepting the invite", async () => {
        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest();
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });

        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        // Bob receives the room invite, but not the room key bundle
        const inviteEvent = mkInviteEvent(aliceClient, bobClient);
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
        });
        await syncPromise(bobClient);

        // Bob joins the room
        const room = bobClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);
        fetchMock.post(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });
        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Bob receives and attempts to decrypt the megolm message, but should not be able to (yet).
        const event = await bobReceivesEvent(
            aliceClient,
            bobClient,
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
                room_id: ROOM_ID,
            }),
            bobSyncResponder,
        );
        await event.getDecryptionPromise();
        expect(event.isDecryptionFailure()).toBeTruthy();

        // Bob is kicked from the room, and rejoins without an invite.
        const roomResponse: ILeftRoom = {
            state: { events: [] },
            timeline: {
                events: [
                    mkEventCustom({
                        content: { membership: KnownMembership.Leave },
                        type: EventType.RoomMember,
                        sender: aliceClient.getSafeUserId(),
                        state_key: bobClient.getSafeUserId(),
                    }),
                ],
                prev_batch: "",
            },
            account_data: { events: [] },
        };
        const bobSyncResponse = {
            next_batch: "1",
            rooms: {
                leave: { [ROOM_ID]: roomResponse },
                invite: {},
                join: {},
                knock: {},
            },
            account_data: { events: [] },
        };

        bobSyncResponder.sendOrQueueSyncResponse(bobSyncResponse);
        await syncPromise(bobClient);
        expect(room?.getMyMembership()).toEqual(KnownMembership.Leave);

        // Bob rejoins
        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Now the bundle arrives
        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        bobSyncResponder.sendOrQueueSyncResponse({
            to_device: {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: aliceClient.getSafeUserId(),
                        content: bobToDeviceMessage,
                    },
                ],
            },
        });
        await syncPromise(bobClient);

        // Wait a bit to ensure the event is not decrypted.
        await sleep(200);

        expect(event.isDecryptionFailure()).toBeTruthy();
    });

    test("Room keys are downloaded from key backup before inviting", async () => {
        // Set up backup, and ignore requests to send room key requests
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", SIGNED_BACKUP_DATA);
        fetchMock.get(
            `express:/_matrix/client/v3/room_keys/keys/${encodeURIComponent(TEST_ROOM_ID)}`,
            PER_ROOM_CURVE25519_KEY_BACKUP_DATA,
        );

        await aliceClient
            .getCrypto()!
            .storeSessionBackupPrivateKey(
                Buffer.from(BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                SIGNED_BACKUP_DATA.version!,
            );

        await aliceClient.getCrypto()!.checkKeyBackupAndEnable();

        // Alice is in an encrypted room.
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, TEST_ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // Alice invites Bob, and shares the room history with them.
        await assertInviteAndShareHistory(TEST_ROOM_ID);

        // Bob receives, and should be able to decrypt, the historical message
        const event = await bobReceivesEvent(aliceClient, bobClient, ENCRYPTED_EVENT as any, bobSyncResponder);
        await event.getDecryptionPromise();
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual(CLEAR_EVENT.content!.body);
        expect(event.getKeyForwardingUser()).toEqual(aliceClient.getUserId());
        const encryptionInfo = await bobClient.getCrypto()!.getEncryptionInfoForEvent(event);
        expect(encryptionInfo?.shieldColour).toEqual(EventShieldColour.GREY);
        expect(encryptionInfo?.shieldReason).toEqual(EventShieldReason.AUTHENTICITY_NOT_GUARANTEED);
    });

    test("Room keys are successfully imported, if the app is shut down while the import is in progress", async () => {
        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hi!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Alice invites Bob, and shares the room history with him.
        const uploadProm = expectUploadRequest();
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });
        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        const inviteEvent = mkInviteEvent(aliceClient, bobClient);
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
            to_device: {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: aliceClient.getSafeUserId(),
                        content: bobToDeviceMessage,
                    },
                ],
            },
        });
        await syncPromise(bobClient);

        const room = bobClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);

        fetchMock.postOnce(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });

        // Have the /download request block indefinitely
        const downloadStarted = Promise.withResolvers<void>();
        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, () => {
            downloadStarted.resolve();
            return new Promise(() => {});
        });
        // meaning the /join request will block
        bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });
        await downloadStarted.promise;

        // Tear down the client, and start again
        bobClient.stopClient();
        bobSyncResponder.sendOrQueueSyncResponse({});
        await flushPromises();

        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        bobClient = await createAndInitClient(BOB_HOMESERVER_URL, bobClient.getSafeUserId(), false);

        // Now, Bob receives the megolm message, and can decrypt it
        const event = await bobReceivesEvent(
            aliceClient,
            bobClient,
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
                room_id: ROOM_ID,
            }),
            bobSyncResponder,
        );
        expect(event.getId()).toEqual("$event_id");
        await event.getDecryptionPromise();
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual("Hi!");
        expect(event.getKeyForwardingUser()).toEqual(aliceClient.getUserId());
        const encryptionInfo = await bobClient.getCrypto()!.getEncryptionInfoForEvent(event);
        expect(encryptionInfo?.shieldColour).toEqual(EventShieldColour.GREY);
        expect(encryptionInfo?.shieldReason).toEqual(EventShieldReason.AUTHENTICITY_NOT_GUARANTEED);
    });

    test("Room keys are not shared if the current history visibility is unshared", async () => {
        // Alice is in an encrypted room
        let syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        let msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, {
            msgtype: MsgType.Text,
            body: "Sent when shared",
        });
        const firstMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(firstMessage)}`);

        // She then sets the history visibility to `invited` ...
        syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Invited, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        /// ... and sends a second message.
        msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, {
            msgtype: MsgType.Text,
            body: "Sent when invited",
        });
        const secondMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(secondMessage)}`);

        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });

        const inviteEvent = mkEventCustom({
            type: "m.room.member",
            sender: aliceClient.getSafeUserId(),
            state_key: bobClient.getSafeUserId(),
            content: { membership: KnownMembership.Invite },
        });
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
            to_device: {
                events: [],
            },
        });
        await syncPromise(bobClient);

        const room = bobClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);

        fetchMock.postOnce(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });

        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Bob receives only the first message.
        const bobSyncResponse = getSyncResponse(
            [aliceClient.getSafeUserId(), bobClient.getSafeUserId()],
            HistoryVisibility.Shared,
            ROOM_ID,
        );
        bobSyncResponse.rooms.join[ROOM_ID].timeline.events.push(
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: firstMessage,
                event_id: "$event_id",
            }) as any,
        );
        bobSyncResponder.sendOrQueueSyncResponse(bobSyncResponse);
        await syncPromise(bobClient);

        const bobRoom = bobClient.getRoom(ROOM_ID);
        const event = bobRoom!.getLastLiveEvent()!;
        expect(event.getId()).toEqual("$event_id");
        await event.getDecryptionPromise();
        expect(event.isDecryptionFailure()).toBeTruthy();

        // Assert alice never uploaded the key bundle ...
        expect(
            fetchMock.callHistory.called(new URL("/_matrix/media/v3/upload", ALICE_HOMESERVER_URL).toString()),
        ).toBeFalsy();
        // ... didn't send Bob the key bundle info ...
        expect(
            fetchMock.callHistory.called(
                new RegExp(
                    `^${escapeRegExp(ALICE_HOMESERVER_URL)}/_matrix/client/v3/sendToDevice/${escapeRegExp("m.room.encrypted")}/`,
                ),
            ),
        ).toBeFalsy();
        // ... and Bob didn't try to download the key bundle.
        expect(
            fetchMock.callHistory.called(
                `begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`,
            ),
        ).toBeFalsy();
    });

    afterEach(async () => {
        vitest.useRealTimers();
        bobClient.stopClient();
        aliceClient.stopClient();
        await flushPromises();
    });

    /**
     * Helper function to automatically test that room history is shared on invite.
     * The function performs the following:
     *
     *  1. Sets up the relevant fetchMock and to-device event listeners for Alice.
     *  2. Alice invites Bob to the room.
     *  3. Checks the key bundle was uploaded and that the `m.room_key_bundle`
     *     to-device message was sent.
     *  4. Sends the invite event to Bob and ensures it is processed correctly.
     *  5. Sets up the relevant fetchMock listeners for Bob.
     *  5. Simulates Bob joining the room and verifies that the room history is shared.
     *
     * @param roomId The ID of the room where the invite and history sharing will be tested.
     */
    async function assertInviteAndShareHistory(roomId: string): Promise<void> {
        const uploadProm = expectUploadRequest();
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {});
        await aliceClient.invite(roomId, bobClient.getSafeUserId(), { shareEncryptedHistory: true });
        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        const inviteEvent = mkInviteEvent(aliceClient, bobClient);
        bobSyncResponder.sendOrQueueSyncResponse({
            rooms: { invite: { [roomId]: { invite_state: { events: [inviteEvent] } } } },
            to_device: {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: aliceClient.getSafeUserId(),
                        content: bobToDeviceMessage,
                    },
                ],
            },
        });
        await syncPromise(bobClient);

        const room = bobClient.getRoom(roomId);
        expect(room).toBeTruthy();
        expect(room?.getMyMembership()).toEqual(KnownMembership.Invite);

        fetchMock.postOnce(`${BOB_HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            room_id: roomId,
        });
        fetchMock.getOnce(`begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        await bobClient.joinRoom(roomId, { acceptSharedHistory: true });
    }
});

function mkInviteEvent(inviter: MatrixClient, recipient: MatrixClient): Partial<IRoomEvent> {
    return mkEventCustom({
        type: "m.room.member",
        sender: inviter.getSafeUserId(),
        state_key: recipient.getSafeUserId(),
        content: { membership: KnownMembership.Invite },
    });
}

function expectSendRoomEvent(homeserverUrl: string, msgtype: string): Promise<IContent> {
    const name = `sendRoomEvent-${homeserverUrl}-${msgtype}`;
    return new Promise<IContent>((resolve) => {
        fetchMock.putOnce(
            new RegExp(`^${escapeRegExp(homeserverUrl)}/_matrix/client/v3/rooms/[^/]*/send/${escapeRegExp(msgtype)}/`),
            (callLog) => {
                const content = JSON.parse(callLog.options.body as string);
                resolve(content);
                fetchMock.removeRoute(name);
                return { event_id: "$event_id" };
            },
            { name },
        );
    });
}

/** Expect an upload to Alice's server. Returns a Promise that resolves when the upload is complete. */
function expectUploadRequest(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve) => {
        fetchMock.postOnce(new URL("/_matrix/media/v3/upload", ALICE_HOMESERVER_URL).toString(), (callLog) => {
            const body = callLog.options.body as Uint8Array;
            debug(`Alice uploaded blob of length ${body.length}`);
            resolve(body);
            return { content_uri: "mxc://alice-server/here" };
        });
    });
}

function expectSendToDeviceMessage(
    homeserverUrl: string,
    msgtype: string,
): Promise<Record<string, Record<string, object>>> {
    return new Promise((resolve) => {
        fetchMock.putOnce(
            new RegExp(`^${escapeRegExp(homeserverUrl)}/_matrix/client/v3/sendToDevice/${escapeRegExp(msgtype)}/`),
            (callLog) => {
                const body = JSON.parse(callLog.options.body as string);
                resolve(body.messages);
                return {};
            },
        );
    });
}

/**
 * Bob receives the encrypted room event from Alice.
 */
async function bobReceivesEvent(
    aliceClient: MatrixClient,
    bobClient: MatrixClient,
    event: IRoomEvent & { room_id: string },
    bobSyncResponder: SyncResponder,
) {
    const roomId = event.room_id;
    const bobSyncResponse = getSyncResponse(
        [aliceClient.getSafeUserId(), bobClient.getSafeUserId()],
        HistoryVisibility.Shared,
        roomId,
    );
    bobSyncResponse.rooms.join[roomId].timeline.events.push(event);
    bobSyncResponder.sendOrQueueSyncResponse(bobSyncResponse);
    await syncPromise(bobClient);
    const bobRoom = bobClient.getRoom(roomId);
    const received = bobRoom!.getLastLiveEvent()!;
    expect(received.getId()).toEqual(event.event_id);
    return received;
}
