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

interface TestClient {
    client: MatrixClient;
    userId: string;
    homeserverUrl: string;
    keyResponder: E2EKeyResponder;
    keyReceiver: E2EKeyReceiver;
    keyClaimResponder: E2EOTKClaimResponder;
    syncResponder: SyncResponder;
}

// Add to this array to allow for more testing clients.
const TEST_USER_IDS = [TEST_USER_ID, "@bob:xyz", "@charlie:zyx"];
let activeClients: TestClient[] = [];

/**
 * Sets up a number of test clients.
 * @param n - The total number of clients.
 * @param options
 * @returns
 */
async function setupClients(n: number, options = { setupNewCrossSigning: true }): Promise<TestClient[]> {
    if (n > TEST_USER_IDS.length) {
        throw new Error("Requested more clients than configured - add to TEST_USER_IDS");
    }

    mockSetupCrossSigningRequests();

    const clients = Array.from({ length: n }).map((_, i) => {
        const userId = TEST_USER_IDS[i];
        const routePrefix = `${userId.split(":")[0].slice(1)}-`; // e.g. @alice:example.com -> alice-
        const homeserverUrl = `https://${routePrefix}server.com`; // e.g. @alice:example.com -> https://alice-homeserver.com

        return {
            client: createClient({
                baseUrl: homeserverUrl,
                userId: userId,
                accessToken: "akjgkrgjs",
                deviceId: "xzcvb",
                logger: new DebugLogger(mkDebug(`matrix-js-sdk:${userId}`)),
            }),
            userId,
            homeserverUrl,
            keyReceiver: new E2EKeyReceiver(homeserverUrl, routePrefix),
            keyResponder: new E2EKeyResponder(homeserverUrl),
            keyClaimResponder: new E2EOTKClaimResponder(homeserverUrl),
            syncResponder: new SyncResponder(homeserverUrl),
        };
    });

    // Add all combinations of key receivers to key (claim) responders.
    for (const { keyResponder: lhsKeyResponder, keyClaimResponder: lhsKeyClaimResponder } of clients) {
        for (const { userId: lhsUserId, keyReceiver: rhsKeyReceiver, client: lhsClient } of clients) {
            lhsKeyResponder.addKeyReceiver(lhsUserId, rhsKeyReceiver);
            lhsKeyClaimResponder.addKeyReceiver(lhsUserId, lhsClient.deviceId!, rhsKeyReceiver);
        }
    }

    // Start all the clients.
    for (const { userId, homeserverUrl, client, syncResponder } of clients) {
        mockInitialApiRequests(homeserverUrl, userId);
        await client.initRustCrypto({ cryptoDatabasePrefix: userId });
        await client.startClient();
        await client.getCrypto()!.bootstrapCrossSigning({ setupNewCrossSigning: options.setupNewCrossSigning });

        syncResponder.sendOrQueueSyncResponse({});
        await syncPromise(client);
    }

    activeClients = clients;
    return activeClients;
}

// load the rust library. This can take a few seconds on a slow GH worker.
beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RustSdkCryptoJs = await require("@matrix-org/matrix-sdk-crypto-wasm");
    await RustSdkCryptoJs.initAsync();
}, 10000);

afterEach(async () => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();

    // Stop and clear the active clients
    activeClients.forEach(({ client }) => client.stopClient());
    await flushPromises();
    activeClients = [];
});

const ROOM_ID = "!room:example.com";

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
    test("Room keys are successfully shared on invite", async () => {
        const [alice, bob] = await setupClients(2);
        const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;
        const { client: bobClient, syncResponder: bobSyncResponder } = bob;

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hi!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Alice invites Bob, and shares the room history with them.
        await assertInviteAndShareHistory(alice, bob, ROOM_ID);

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
        const [alice, { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder }] =
            await setupClients(2);
        const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest(alice);
        const toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
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
        fetchMock.postOnce(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
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
        fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
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

        const [alice, { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder }] =
            await setupClients(2);
        const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest(alice);
        const toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
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
        fetchMock.postOnce(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
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

        fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
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
        const [alice, { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder }] =
            await setupClients(2);
        const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hello!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = expectUploadRequest(alice);
        const toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
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
        fetchMock.post(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
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
        fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
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
        const [alice, bob] = await setupClients(2);
        const { client: aliceClient, syncResponder: aliceSyncResponder } = alice;
        const { client: bobClient, syncResponder: bobSyncResponder } = bob;

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
        await assertInviteAndShareHistory(alice, bob, TEST_ROOM_ID);

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
        const [alice, { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder }] =
            await setupClients(2);
        const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;

        // Alice is in an encrypted room
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hi!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Alice invites Bob, and shares the room history with him.
        const uploadProm = expectUploadRequest(alice);
        const toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
        fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
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

        fetchMock.postOnce(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
            room_id: ROOM_ID,
        });

        // Have the /download request block indefinitely
        const downloadStarted = Promise.withResolvers<void>();
        fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, () => {
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

        fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
            body: uploadedBlob,
        });
        const bobNewClient = await createAndInitClient(bobHomeserverUrl, bobClient.getSafeUserId(), false);

        // Now, Bob receives the megolm message, and can decrypt it
        const event = await bobReceivesEvent(
            aliceClient,
            bobNewClient,
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
        expect(event.getId()).toEqual("$event_id");
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual("Hi!");
        expect(event.getKeyForwardingUser()).toEqual(aliceClient.getUserId());
        const encryptionInfo = await bobNewClient.getCrypto()!.getEncryptionInfoForEvent(event);
        expect(encryptionInfo?.shieldColour).toEqual(EventShieldColour.GREY);
        expect(encryptionInfo?.shieldReason).toEqual(EventShieldReason.AUTHENTICITY_NOT_GUARANTEED);

        // We need to stop Bob's new client manually, since it isn't tracked by `setupClients`.
        bobNewClient.stopClient();
    });

    test("Room keys are not shared if the current history visibility is unshared", async () => {
        const [
            { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder },
            { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder },
        ] = await setupClients(2);

        // Alice is in an encrypted room
        let syncResponse = getSyncResponse([aliceClient.getSafeUserId()], HistoryVisibility.Shared, ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        let msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
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
        msgProm = expectSendRoomEvent(aliceHomeserverUrl, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, {
            msgtype: MsgType.Text,
            body: "Sent when invited",
        });
        const secondMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(secondMessage)}`);

        fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
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

        fetchMock.postOnce(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
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
            fetchMock.callHistory.called(new URL("/_matrix/media/v3/upload", aliceHomeserverUrl).toString()),
        ).toBeFalsy();
        // ... didn't send Bob the key bundle info ...
        expect(
            fetchMock.callHistory.called(
                new RegExp(
                    `^${escapeRegExp(aliceHomeserverUrl)}/_matrix/client/v3/sendToDevice/${escapeRegExp("m.room.encrypted")}/`,
                ),
            ),
        ).toBeFalsy();
        // ... and Bob didn't try to download the key bundle.
        expect(
            fetchMock.callHistory.called(
                `begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`,
            ),
        ).toBeFalsy();
    });

    test.each([false, true])(
        "Room key is rotated after a member joins and leaves the room (gappy sync = %s)",
        async (gappySync) => {
            const [
                alice,
                { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder },
                { homeserverUrl: charlieHomeserverUrl, client: charlieClient, syncResponder: charlieSyncResponder },
            ] = await setupClients(3);
            const { homeserverUrl: aliceHomeserverUrl, client: aliceClient, syncResponder: aliceSyncResponder } = alice;

            // Alice and Bob are in an encrypted room
            let syncResponse = getSyncResponse(
                [aliceClient.getSafeUserId(), bobClient.getSafeUserId()],
                HistoryVisibility.Shared,
                ROOM_ID,
            );
            aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
            bobSyncResponder.sendOrQueueSyncResponse(syncResponse);

            await syncPromise(aliceClient);
            await syncPromise(bobClient);

            // Bob sends a message M1, which both he and Alice receive.
            let msgProm = expectSendRoomEvent(bobHomeserverUrl, "m.room.encrypted");
            let toDeviceMessageProm = expectSendToDeviceMessage(bobHomeserverUrl, "m.room.encrypted");
            await bobClient.sendEvent(ROOM_ID, EventType.RoomMessage, {
                msgtype: MsgType.Text,
                body: "Charlie should be able to read",
            });
            const bobEventM1Content = await msgProm;
            let sentToDeviceRequest = await toDeviceMessageProm;
            expect(sentToDeviceRequest).toBeDefined();
            let aliceToDeviceMessage = sentToDeviceRequest[aliceClient.getSafeUserId()][aliceClient.deviceId!];

            // Alice receives the message down sync.
            syncResponse = getSyncResponse(
                [aliceClient.getSafeUserId(), bobClient.getSafeUserId()],
                HistoryVisibility.Shared,
                ROOM_ID,
            );
            syncResponse.rooms.join[ROOM_ID].timeline.events.push(
                mkEventCustom({
                    type: "m.room.encrypted",
                    sender: bobClient.getSafeUserId(),
                    content: bobEventM1Content,
                    event_id: "$event_id_m1",
                }) as any,
            );
            syncResponse.to_device = {
                events: [
                    {
                        type: "m.room.encrypted",
                        sender: bobClient.getSafeUserId(),
                        content: aliceToDeviceMessage,
                    },
                ],
            };
            aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            // Alice checks she can read M1.
            const aliceRoom = aliceClient.getRoom(ROOM_ID);
            const aliceM1 = aliceRoom!.getLastLiveEvent()!;
            await aliceM1.getDecryptionPromise();
            expect(aliceM1.getType()).toEqual("m.room.message");
            expect(aliceM1.getContent().body).toEqual("Charlie should be able to read");

            // Alice invites and sends a key bundle to Charlie
            const uploadProm = expectUploadRequest(alice);
            toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
            fetchMock.postOnce(
                `${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`,
                {},
            );
            await aliceClient.invite(ROOM_ID, charlieClient.getSafeUserId(), { shareEncryptedHistory: true });
            const uploadedBlob = await uploadProm;
            sentToDeviceRequest = await toDeviceMessageProm;
            debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
            const charlieToDeviceMessage = sentToDeviceRequest[charlieClient.getSafeUserId()][charlieClient.deviceId!];
            expect(charlieToDeviceMessage).toBeDefined();

            /// Charlie receives the invite ...
            const inviteEvent = mkInviteEvent(aliceClient, charlieClient);
            charlieSyncResponder.sendOrQueueSyncResponse({
                rooms: { invite: { [ROOM_ID]: { invite_state: { events: [inviteEvent] } } } },
                to_device: {
                    events: [
                        {
                            type: "m.room.encrypted",
                            sender: aliceClient.getSafeUserId(),
                            content: charlieToDeviceMessage,
                        },
                    ],
                },
            });
            await syncPromise(charlieClient);

            const charlieRoom = charlieClient.getRoom(ROOM_ID);
            expect(charlieRoom).toBeTruthy();
            expect(charlieRoom?.getMyMembership()).toEqual(KnownMembership.Invite);

            // ... and subsequently joins.
            fetchMock.postOnce(`${charlieHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
                room_id: ROOM_ID,
            });
            fetchMock.getOnce(`begin:${charlieHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
                body: uploadedBlob,
            });
            await charlieClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

            // Charlie syncs to receive M1 and ensure he can read it.
            syncResponse = getSyncResponse(
                [aliceClient.getSafeUserId(), bobClient.getSafeUserId(), charlieClient.getSafeUserId()],
                HistoryVisibility.Shared,
                ROOM_ID,
            );
            syncResponse.rooms.join[ROOM_ID].timeline.events.push(
                mkEventCustom({
                    type: "m.room.encrypted",
                    sender: bobClient.getSafeUserId(),
                    content: bobEventM1Content,
                    event_id: "$event_id_m1",
                }) as any,
            );
            charlieSyncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(charlieClient);

            const charlieEventM1 = charlieRoom!
                .getLiveTimeline()
                .getEvents()
                .find((e) => e.getId() === "$event_id_m1");

            await charlieEventM1!.getDecryptionPromise();
            expect(charlieEventM1!.getType()).toEqual("m.room.message");
            expect(charlieEventM1!.getContent().body).toEqual("Charlie should be able to read");

            // Charlie then immediately leaves.
            const charlieSyncResponse = {
                next_batch: "1",
                rooms: {
                    leave: {
                        [ROOM_ID]: {
                            state: { events: [] },
                            timeline: {
                                events: [
                                    mkEventCustom({
                                        content: { membership: KnownMembership.Leave },
                                        type: EventType.RoomMember,
                                        sender: charlieClient.getSafeUserId(),
                                        state_key: charlieClient.getSafeUserId(),
                                    }),
                                ],
                                prev_batch: "",
                            },
                            account_data: { events: [] },
                        },
                    },
                    invite: {},
                    join: {},
                    knock: {},
                },
                account_data: { events: [] },
            };
            charlieSyncResponder.sendOrQueueSyncResponse(charlieSyncResponse);
            await syncPromise(charlieClient);

            syncResponse = {
                next_batch: "2",
                rooms: {
                    join: {
                        [ROOM_ID]: {
                            timeline: {
                                events: [],
                            },
                        },
                    },
                },
            } as any;
            if (gappySync) {
                // In case of a gappy sync, the timeline is limited and we only see the leave event.
                syncResponse.rooms.join[ROOM_ID].timeline.limited = true;
                syncResponse.rooms.join[ROOM_ID].state = {
                    events: [
                        mkEventCustom({
                            content: { membership: KnownMembership.Leave },
                            type: EventType.RoomMember,
                            sender: charlieClient.getSafeUserId(),
                            state_key: charlieClient.getSafeUserId(),
                        }) as any,
                    ],
                };
            } else {
                syncResponse.rooms.join[ROOM_ID].timeline.events.push(
                    mkEventCustom({
                        content: { membership: KnownMembership.Join },
                        type: EventType.RoomMember,
                        sender: charlieClient.getSafeUserId(),
                        state_key: charlieClient.getSafeUserId(),
                    }) as any,
                    mkEventCustom({
                        content: { membership: KnownMembership.Leave },
                        type: EventType.RoomMember,
                        sender: charlieClient.getSafeUserId(),
                        state_key: charlieClient.getSafeUserId(),
                    }) as any,
                );
            }
            // Bob syncs to learn about Charlie's leaving (and joining if non-gappy).
            bobSyncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(bobClient);

            // Bob then sends M2, sharing a new room key with Alice.
            msgProm = expectSendRoomEvent(bobHomeserverUrl, "m.room.encrypted");
            toDeviceMessageProm = expectSendToDeviceMessage(bobHomeserverUrl, "m.room.encrypted");
            await bobClient.sendEvent(ROOM_ID, EventType.RoomMessage, {
                msgtype: MsgType.Text,
                body: "Charlie should not be able to read",
            });
            const bobEventM2Content = await msgProm;
            sentToDeviceRequest = await toDeviceMessageProm;
            expect(sentToDeviceRequest).toBeDefined();
            aliceToDeviceMessage = sentToDeviceRequest[aliceClient.getSafeUserId()][aliceClient.deviceId!];

            // Charlie should not receive the room key
            expect(sentToDeviceRequest[charlieClient.getSafeUserId()]).toBeUndefined();

            debug(`Bob sent encrypted room event: ${JSON.stringify(bobEventM2Content)}`);

            // Sync the message to Alice along with the to-device message, and check she can decrypt it.
            syncResponse = {
                next_batch: "3",
                rooms: {
                    join: {
                        [ROOM_ID]: {
                            timeline: {
                                events: [
                                    mkEventCustom({
                                        type: "m.room.encrypted",
                                        sender: bobClient.getSafeUserId(),
                                        content: bobEventM2Content,
                                        event_id: "$event_id_m2",
                                    }) as any,
                                ],
                            },
                        },
                    },
                },
                to_device: {
                    events: [
                        {
                            type: "m.room.encrypted",
                            sender: bobClient.getSafeUserId(),
                            content: aliceToDeviceMessage,
                        },
                    ],
                },
            } as any;
            aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            const aliceEventM2 = aliceRoom!.getLastLiveEvent()!;
            await aliceEventM2.getDecryptionPromise();
            expect(aliceEventM2.getType()).toEqual("m.room.message");
            expect(aliceEventM2.getContent().body).toEqual("Charlie should not be able to read");

            // Charlie rejoins the room by ID, receives M2, which he should not be able to decrypt.
            fetchMock.postOnce(`${charlieHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
                room_id: ROOM_ID,
            });
            await charlieClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });
            syncResponse = {
                next_batch: "4",
                rooms: {
                    join: {
                        [ROOM_ID]: {
                            timeline: {
                                events: [
                                    mkEventCustom({
                                        type: "m.room.encrypted",
                                        sender: bobClient.getSafeUserId(),
                                        content: bobEventM2Content,
                                        event_id: "$event_id_m2",
                                    }) as any,
                                ],
                            },
                        },
                    },
                },
            } as any;
            charlieSyncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(charlieClient);

            const events = charlieRoom!.getLiveTimeline().getEvents();
            expect(events.length).toBeGreaterThanOrEqual(2);

            const charlieM2 = charlieRoom!
                .getLiveTimeline()
                .getEvents()
                .find((e) => e.getId() === "$event_id_m2");

            await charlieM2!.getDecryptionPromise();
            expect(charlieM2!.isDecryptionFailure()).toBeTruthy();
        },
        60e3,
    );

    afterEach(async () => {
        vitest.useRealTimers();
    });
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
async function assertInviteAndShareHistory(
    alice: TestClient,
    { homeserverUrl: bobHomeserverUrl, client: bobClient, syncResponder: bobSyncResponder }: TestClient,
    roomId: string,
): Promise<void> {
    const { homeserverUrl: aliceHomeserverUrl, client: aliceClient } = alice;

    const uploadProm = expectUploadRequest(alice);
    const toDeviceMessageProm = expectSendToDeviceMessage(aliceHomeserverUrl, "m.room.encrypted");
    fetchMock.postOnce(`${aliceHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {});
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

    fetchMock.postOnce(`${bobHomeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        room_id: roomId,
    });
    fetchMock.getOnce(`begin:${bobHomeserverUrl}/_matrix/client/v1/media/download/alice-server/here`, {
        body: uploadedBlob,
    });
    await bobClient.joinRoom(roomId, { acceptSharedHistory: true });
}

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
function expectUploadRequest({ userId, homeserverUrl }: TestClient): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve) => {
        fetchMock.postOnce(new URL("/_matrix/media/v3/upload", homeserverUrl).toString(), (callLog) => {
            const body = callLog.options.body as Uint8Array;
            debug(`${userId} uploaded blob of length ${body.length}`);
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
