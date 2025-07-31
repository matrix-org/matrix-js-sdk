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

import anotherjson from "another-json";
import fetchMock from "fetch-mock-jest";
import "fake-indexeddb/auto";
import Olm from "@matrix-org/olm";

import * as testUtils from "../../test-utils/test-utils";
import { getSyncResponse, syncPromise } from "../../test-utils/test-utils";
import { TEST_ROOM_ID as ROOM_ID } from "../../test-utils/test-data";
import { logger } from "../../../src/logger";
import { createClient, PendingEventOrdering, type IStartClientOpts, type MatrixClient } from "../../../src/matrix";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { type ISyncResponder, SyncResponder } from "../../test-utils/SyncResponder";
import {
    createOlmAccount,
    createOlmSession,
    encryptGroupSessionKey,
    encryptMegolmEvent,
    getTestOlmAccountKeys,
    expectSendRoomKey,
    expectSendMegolmStateEvent,
} from "./olm-utils";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";

describe("Encrypted State Events", () => {
    let testOlmAccount = {} as unknown as Olm.Account;
    let testSenderKey = "";

    /** the MatrixClient under test */
    let aliceClient: MatrixClient;

    /** an object which intercepts `/keys/upload` requests from {@link #aliceClient} to catch the uploaded keys */
    let keyReceiver: E2EKeyReceiver;

    /** an object which intercepts `/sync` requests from {@link #aliceClient} */
    let syncResponder: ISyncResponder;

    async function startClientAndAwaitFirstSync(opts: IStartClientOpts = {}): Promise<void> {
        logger.log(aliceClient.getUserId() + ": starting");

        mockInitialApiRequests(aliceClient.getHomeserverUrl());

        // we let the client do a very basic initial sync, which it needs before
        // it will upload one-time keys.
        syncResponder.sendOrQueueSyncResponse({ next_batch: 1 });

        aliceClient.startClient({
            // set this so that we can get hold of failed events
            pendingEventOrdering: PendingEventOrdering.Detached,
            ...opts,
        });

        await syncPromise(aliceClient);
        logger.log(aliceClient.getUserId() + ": started");
    }

    beforeEach(async () => {
        fetchMock.catch(404);
        fetchMock.config.warnOnFallback = false;

        const homeserverUrl = "https://alice-server.com";
        aliceClient = createClient({
            baseUrl: homeserverUrl,
            userId: "@alice:localhost",
            accessToken: "akjgkrgjs",
            deviceId: "xzcvb",
            logger: logger.getChild("aliceClient"),
            enableEncryptedStateEvents: true,
        });

        keyReceiver = new E2EKeyReceiver(homeserverUrl);
        syncResponder = new SyncResponder(homeserverUrl);

        await aliceClient.initRustCrypto();

        // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
        testOlmAccount = await createOlmAccount();
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;
    }, 10000);

    afterEach(async () => {
        await aliceClient.stopClient();
        await jest.runAllTimersAsync();
        fetchMock.mockReset();
    });

    function expectAliceKeyQuery(response: any) {
        fetchMock.postOnce(new RegExp("/keys/query"), (url: string, opts: RequestInit) => response, {
            overwriteRoutes: false,
        });
    }

    function expectAliceKeyClaim(response: any) {
        fetchMock.postOnce(new RegExp("/keys/claim"), response);
    }

    function getTestKeysClaimResponse(userId: string) {
        testOlmAccount.generate_one_time_keys(1);
        const testOneTimeKeys = JSON.parse(testOlmAccount.one_time_keys());
        testOlmAccount.mark_keys_as_published();

        const keyId = Object.keys(testOneTimeKeys.curve25519)[0];
        const oneTimeKey: string = testOneTimeKeys.curve25519[keyId];
        const unsignedKeyResult = { key: oneTimeKey };
        const j = anotherjson.stringify(unsignedKeyResult);
        const sig = testOlmAccount.sign(j);
        const keyResult = {
            ...unsignedKeyResult,
            signatures: { [userId]: { "ed25519:DEVICE_ID": sig } },
        };

        return {
            one_time_keys: { [userId]: { DEVICE_ID: { ["signed_curve25519:" + keyId]: keyResult } } },
            failures: {},
        };
    }

    it("Should receive an encrypted state event", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // encrypt a state event with the group session
        const eventEncrypted = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
            plaintext: {
                type: "m.room.topic",
                state_key: "",
                content: {
                    topic: "Secret!",
                },
            },
        });

        // Alice gets both the events in a single sync
        const syncResponse = {
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted],
            },
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [eventEncrypted] } },
                },
            },
        };

        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.isEncrypted()).toBe(true);

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(decryptedEvent.getContent().topic).toEqual("Secret!");
    });

    it("Should send an encrypted state event", async () => {
        const homeserverUrl = aliceClient.getHomeserverUrl();
        const keyResponder = new E2EKeyResponder(homeserverUrl);
        keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

        const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
        keyResponder.addDeviceKeys(testDeviceKeys);

        await startClientAndAwaitFirstSync();

        // Alice shares a room with Bob
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"], ROOM_ID, true));
        await syncPromise(aliceClient);

        // ... and claim one of Bob's OTKs ...
        expectAliceKeyClaim(getTestKeysClaimResponse("@bob:xyz"));

        // ... and send an m.room.topic message
        const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount);

        // Finally, send the message, and expect to get an `m.room.encrypted` event that we can decrypt.
        await Promise.all([
            aliceClient.setRoomTopic(ROOM_ID, "Secret!"),
            expectSendMegolmStateEvent(inboundGroupSessionPromise),
        ]);
    });
});
