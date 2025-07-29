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
import fetchMock from "fetch-mock-jest";
import mkDebug from "debug";

import {
    createClient,
    DebugLogger,
    EventType,
    type IContent,
    KnownMembership,
    type MatrixClient,
    MsgType,
} from "../../../src";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver.ts";
import { SyncResponder } from "../../test-utils/SyncResponder.ts";
import { mockInitialApiRequests, mockSetupCrossSigningRequests } from "../../test-utils/mockEndpoints.ts";
import { getSyncResponse, mkEventCustom, syncPromise } from "../../test-utils/test-utils.ts";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";
import { E2EOTKClaimResponder } from "../../test-utils/E2EOTKClaimResponder.ts";
import { escapeRegExp } from "../../../src/utils.ts";

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

async function createAndInitClient(homeserverUrl: string, userId: string) {
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
    await client.getCrypto()!.bootstrapCrossSigning({ setupNewCrossSigning: true });
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
        fetchMock.config.warnOnFallback = false;
        mockSetupCrossSigningRequests();

        const aliceId = "@alice:localhost";
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
        const syncResponse = getSyncResponse([aliceClient.getSafeUserId()], ROOM_ID);
        aliceSyncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // ... and she sends an event
        const msgProm = expectSendRoomEvent(ALICE_HOMESERVER_URL, "m.room.encrypted");
        await aliceClient.sendEvent(ROOM_ID, EventType.RoomMessage, { msgtype: MsgType.Text, body: "Hi!" });
        const sentMessage = await msgProm;
        debug(`Alice sent encrypted room event: ${JSON.stringify(sentMessage)}`);

        // Now, Alice invites Bob
        const uploadProm = new Promise<Uint8Array>((resolve) => {
            fetchMock.postOnce(new URL("/_matrix/media/v3/upload", ALICE_HOMESERVER_URL).toString(), (url, request) => {
                const body = request.body as Uint8Array;
                debug(`Alice uploaded blob of length ${body.length}`);
                resolve(body);
                return { content_uri: "mxc://alice-server/here" };
            });
        });
        const toDeviceMessageProm = expectSendToDeviceMessage(ALICE_HOMESERVER_URL, "m.room.encrypted");
        // POST https://alice-server.com/_matrix/client/v3/rooms/!room%3Aexample.com/invite
        fetchMock.postOnce(`${ALICE_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {});
        await aliceClient.invite(ROOM_ID, bobClient.getSafeUserId(), { shareEncryptedHistory: true });
        const uploadedBlob = await uploadProm;
        const sentToDeviceRequest = await toDeviceMessageProm;
        debug(`Alice sent encrypted to-device events: ${JSON.stringify(sentToDeviceRequest)}`);
        const bobToDeviceMessage = sentToDeviceRequest[bobClient.getSafeUserId()][bobClient.deviceId!];
        expect(bobToDeviceMessage).toBeDefined();

        // Bob receives the to-device event and the room invite
        const inviteEvent = mkEventCustom({
            type: "m.room.member",
            sender: aliceClient.getSafeUserId(),
            state_key: bobClient.getSafeUserId(),
            content: { membership: KnownMembership.Invite },
        });
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
        fetchMock.getOnce(
            `begin:${BOB_HOMESERVER_URL}/_matrix/client/v1/media/download/alice-server/here`,
            { body: uploadedBlob },
            { sendAsJson: false },
        );
        await bobClient.joinRoom(ROOM_ID, { acceptSharedHistory: true });

        // Bob receives, should be able to decrypt, the megolm message
        const bobSyncResponse = getSyncResponse([aliceClient.getSafeUserId(), bobClient.getSafeUserId()], ROOM_ID);
        bobSyncResponse.rooms.join[ROOM_ID].timeline.events.push(
            mkEventCustom({
                type: "m.room.encrypted",
                sender: aliceClient.getSafeUserId(),
                content: sentMessage,
                event_id: "$event_id",
            }) as any,
        );
        bobSyncResponder.sendOrQueueSyncResponse(bobSyncResponse);
        await syncPromise(bobClient);

        const bobRoom = bobClient.getRoom(ROOM_ID);
        const event = bobRoom!.getLastLiveEvent()!;
        expect(event.getId()).toEqual("$event_id");
        await event.getDecryptionPromise();
        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent().body).toEqual("Hi!");
    });

    afterEach(async () => {
        bobClient.stopClient();
        aliceClient.stopClient();
        await flushPromises();
    });
});

function expectSendRoomEvent(homeserverUrl: string, msgtype: string): Promise<IContent> {
    return new Promise<IContent>((resolve) => {
        fetchMock.putOnce(
            new RegExp(`^${escapeRegExp(homeserverUrl)}/_matrix/client/v3/rooms/[^/]*/send/${escapeRegExp(msgtype)}/`),
            (url, request) => {
                const content = JSON.parse(request.body as string);
                resolve(content);
                return { event_id: "$event_id" };
            },
            { name: "sendRoomEvent" },
        );
    });
}

function expectSendToDeviceMessage(
    homeserverUrl: string,
    msgtype: string,
): Promise<Record<string, Record<string, object>>> {
    return new Promise((resolve) => {
        fetchMock.putOnce(
            new RegExp(`^${escapeRegExp(homeserverUrl)}/_matrix/client/v3/sendToDevice/${escapeRegExp(msgtype)}/`),
            (url: string, opts: RequestInit) => {
                const body = JSON.parse(opts.body as string);
                resolve(body.messages);
                return {};
            },
        );
    });
}
