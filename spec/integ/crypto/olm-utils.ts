/*
Copyright 2016-2023 The Matrix.org Foundation C.I.C.

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

import Olm from "@matrix-org/olm";
import anotherjson from "another-json";

import { IContent, IDeviceKeys, IEvent, MatrixClient } from "../../../src";
import { IE2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { ISyncResponder } from "../../test-utils/SyncResponder";
import { syncPromise } from "../../test-utils/test-utils";

/**
 * @module
 *
 * A set of utilities for creating Olm accounts and sessions, and encrypting/decrypting with Olm/Megolm.
 */

/** Create an Olm Account object */
export async function createOlmAccount(): Promise<Olm.Account> {
    await Olm.init();
    const testOlmAccount = new Olm.Account();
    testOlmAccount.create();
    return testOlmAccount;
}

/**
 * Get the device keys for the test Olm Account
 *
 * @param olmAccount - Test olm account
 * @param userId - The user ID to present the keys as belonging to
 */
export function getTestOlmAccountKeys(olmAccount: Olm.Account, userId: string, deviceId: string): IDeviceKeys {
    const testE2eKeys = JSON.parse(olmAccount.identity_keys());
    const testDeviceKeys: IDeviceKeys = {
        algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
        device_id: deviceId,
        keys: {
            [`curve25519:${deviceId}`]: testE2eKeys.curve25519,
            [`ed25519:${deviceId}`]: testE2eKeys.ed25519,
        },
        user_id: userId,
    };

    const j = anotherjson.stringify(testDeviceKeys);
    const sig = olmAccount.sign(j);
    testDeviceKeys.signatures = { [userId]: { [`ed25519:${deviceId}`]: sig } };
    return testDeviceKeys;
}

/** start an Olm session with a given recipient */
export async function createOlmSession(
    olmAccount: Olm.Account,
    recipientTestClient: IE2EKeyReceiver,
): Promise<Olm.Session> {
    const keys = await recipientTestClient.awaitOneTimeKeyUpload();
    const otkId = Object.keys(keys)[0];
    const otk = keys[otkId];

    const session = new global.Olm.Session();
    session.create_outbound(olmAccount, recipientTestClient.getDeviceKey(), otk.key);
    return session;
}

// IToDeviceEvent isn't exported by src/sync-accumulator.ts
export interface ToDeviceEvent {
    content: IContent;
    sender: string;
    type: string;
}

/** encrypt an event with an existing olm session */
export function encryptOlmEvent(opts: {
    /** the sender's user id */
    sender?: string;
    /** the sender's curve25519 key */
    senderKey: string;
    /** the sender's ed25519 key */
    senderSigningKey: string;
    /** the olm session to use for encryption */
    p2pSession: Olm.Session;
    /** the recipient's user id */
    recipient: string;
    /** the recipient's curve25519 key */
    recipientCurve25519Key: string;
    /** the recipient's ed25519 key */
    recipientEd25519Key: string;
    /** the payload of the message */
    plaincontent?: object;
    /** the event type of the payload */
    plaintype?: string;
}): ToDeviceEvent {
    expect(opts.senderKey).toBeTruthy();
    expect(opts.p2pSession).toBeTruthy();
    expect(opts.recipient).toBeTruthy();

    const plaintext = {
        content: opts.plaincontent || {},
        recipient: opts.recipient,
        recipient_keys: {
            ed25519: opts.recipientEd25519Key,
        },
        keys: {
            ed25519: opts.senderSigningKey,
        },
        sender: opts.sender || "@bob:xyz",
        type: opts.plaintype || "m.test",
    };

    return {
        content: {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            ciphertext: {
                [opts.recipientCurve25519Key]: opts.p2pSession.encrypt(JSON.stringify(plaintext)),
            },
            sender_key: opts.senderKey,
        },
        sender: opts.sender || "@bob:xyz",
        type: "m.room.encrypted",
    };
}

// encrypt an event with megolm
export function encryptMegolmEvent(opts: {
    senderKey: string;
    groupSession: Olm.OutboundGroupSession;
    plaintext?: Partial<IEvent>;
    room_id?: string;
}): IEvent {
    expect(opts.senderKey).toBeTruthy();
    expect(opts.groupSession).toBeTruthy();

    const plaintext = opts.plaintext || {};
    if (!plaintext.content) {
        plaintext.content = {
            body: "42",
            msgtype: "m.text",
        };
    }
    if (!plaintext.type) {
        plaintext.type = "m.room.message";
    }
    if (!plaintext.room_id) {
        expect(opts.room_id).toBeTruthy();
        plaintext.room_id = opts.room_id;
    }
    return encryptMegolmEventRawPlainText({
        senderKey: opts.senderKey,
        groupSession: opts.groupSession,
        plaintext,
    });
}

export function encryptMegolmEventRawPlainText(opts: {
    senderKey: string;
    groupSession: Olm.OutboundGroupSession;
    plaintext: Partial<IEvent>;
    origin_server_ts?: number;
}): IEvent {
    return {
        event_id: "$test_megolm_event_" + Math.random(),
        sender: opts.plaintext.sender ?? "@not_the_real_sender:example.com",
        origin_server_ts: opts.plaintext.origin_server_ts ?? 1672944778000,
        content: {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: opts.groupSession.encrypt(JSON.stringify(opts.plaintext)),
            device_id: "testDevice",
            sender_key: opts.senderKey,
            session_id: opts.groupSession.session_id(),
        },
        type: "m.room.encrypted",
        unsigned: {},
    };
}

/** build an encrypted room_key event to share a group session, using an existing olm session */
export function encryptGroupSessionKey(opts: {
    /** recipient's user id */
    recipient: string;
    /** the recipient's curve25519 key */
    recipientCurve25519Key: string;
    /** the recipient's ed25519 key */
    recipientEd25519Key: string;
    /** sender's olm account */
    olmAccount: Olm.Account;
    /** sender's olm session with the recipient */
    p2pSession: Olm.Session;
    groupSession: Olm.OutboundGroupSession;
    room_id?: string;
}): ToDeviceEvent {
    const senderKeys = JSON.parse(opts.olmAccount.identity_keys());
    return encryptOlmEvent({
        senderKey: senderKeys.curve25519,
        senderSigningKey: senderKeys.ed25519,
        recipient: opts.recipient,
        recipientCurve25519Key: opts.recipientCurve25519Key,
        recipientEd25519Key: opts.recipientEd25519Key,
        p2pSession: opts.p2pSession,
        plaincontent: {
            algorithm: "m.megolm.v1.aes-sha2",
            room_id: opts.room_id,
            session_id: opts.groupSession.session_id(),
            session_key: opts.groupSession.session_key(),
        },
        plaintype: "m.room_key",
    });
}

/**
 * Establish an Olm Session with the test user
 *
 * Waits for the test user to upload their keys, then sends a /sync response with a to-device message which will
 * establish an Olm session.
 *
 * @param testClient - the MatrixClient under test, which we expect to upload account keys, and to make a
 *    /sync request which we will respond to.
 * @param keyReceiver - an IE2EKeyReceiver which will intercept the /keys/upload request from the client under test
 * @param syncResponder - an ISyncResponder which will intercept /sync requests from the client under test
 * @param peerOlmAccount: an OlmAccount which will be used to initiate the Olm session.
 */
export async function establishOlmSession(
    testClient: MatrixClient,
    keyReceiver: IE2EKeyReceiver,
    syncResponder: ISyncResponder,
    peerOlmAccount: Olm.Account,
): Promise<Olm.Session> {
    const peerE2EKeys = JSON.parse(peerOlmAccount.identity_keys());
    const p2pSession = await createOlmSession(peerOlmAccount, keyReceiver);
    const olmEvent = encryptOlmEvent({
        senderKey: peerE2EKeys.curve25519,
        senderSigningKey: peerE2EKeys.ed25519,
        recipient: testClient.getUserId()!,
        recipientCurve25519Key: keyReceiver.getDeviceKey(),
        recipientEd25519Key: keyReceiver.getSigningKey(),
        p2pSession: p2pSession,
    });
    syncResponder.sendOrQueueSyncResponse({
        next_batch: 1,
        to_device: { events: [olmEvent] },
    });
    await syncPromise(testClient);
    return p2pSession;
}
