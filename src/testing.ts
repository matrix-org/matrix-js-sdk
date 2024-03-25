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

/**
 * This file is a secondary entrypoint for the js-sdk library, exposing utilities which might be useful for writing tests.
 *
 * In general, it should not be included in runtime applications.
 *
 * @packageDocumentation
 */

import { IContent, IEvent, IUnsigned, MatrixEvent } from "./models/event";
import { RoomMember } from "./models/room-member";
import { EventType } from "./@types/event";
import { DecryptionError } from "./crypto/algorithms";
import { DecryptionFailureCode } from "./crypto-api";
import { EventDecryptionResult } from "./common-crypto/CryptoBackend";

/**
 * Create a {@link MatrixEvent}.
 *
 * @param opts - Values for the event.
 */
export function mkMatrixEvent(opts: {
    /** Room ID of the event. */
    roomId: string;

    /** The sender of the event. */
    sender: string;

    /** The type of the event. */
    type: EventType | string;

    /** Optional `state_key` for the event. If unspecified, a non-state event is created. */
    stateKey?: string;

    /** Optional `origin_server_ts` for the event. If unspecified, the timestamp will be set to 0. */
    ts?: number;

    /** Optional `event_id` for the event. If provided will be used as event ID; else an ID is generated. */
    eventId?: string;

    /** Content of the event. */
    content: IContent;

    /** Optional `unsigned` data for the event. */
    unsigned?: IUnsigned;
}): MatrixEvent {
    const event: Partial<IEvent> = {
        type: opts.type,
        room_id: opts.roomId,
        sender: opts.sender,
        content: opts.content,
        event_id: opts.eventId ?? "$" + Math.random() + "-" + Math.random(),
        origin_server_ts: opts.ts ?? 0,
        unsigned: opts.unsigned,
    };
    if (opts.stateKey !== undefined) {
        event.state_key = opts.stateKey;
    }

    const mxEvent = new MatrixEvent(event);
    mxEvent.sender = {
        userId: opts.sender,
        membership: "join",
        name: opts.sender,
        rawDisplayName: opts.sender,
        roomId: opts.sender,
        getAvatarUrl: () => {},
        getMxcAvatarUrl: () => {},
    } as unknown as RoomMember;
    return mxEvent;
}

/**
 * Create a `MatrixEvent` representing a successfully-decrypted `m.room.encrypted` event.
 *
 * @param opts - Values for the event.
 */
export async function mkEncryptedMatrixEvent(opts: {
    /** Room ID of the event. */
    roomId: string;

    /** The sender of the event. */
    sender: string;

    /** The type the event will have, once it has been decrypted. */
    plainType: EventType | string;

    /** The content the event will have, once it has been decrypted. */
    plainContent: IContent;

    /** Optional `event_id` for the event. If provided will be used as event ID; else an ID is generated. */
    eventId?: string;
}): Promise<MatrixEvent> {
    const mxEvent = mkMatrixEvent({
        type: EventType.RoomMessageEncrypted,
        roomId: opts.roomId,
        sender: opts.sender,
        content: { algorithm: "m.megolm.v1.aes-sha2" },
        eventId: opts.eventId,
    });

    await decryptExistingEvent(mxEvent, { plainType: opts.plainType, plainContent: opts.plainContent });
    return mxEvent;
}

/**
 * Create a `MatrixEvent` representing a `m.room.encrypted` event which could not be decrypted.
 *
 * @param opts - Values for the event.
 */
export async function mkDecryptionFailureMatrixEvent(opts: {
    /** Room ID of the event. */
    roomId: string;

    /** The sender of the event. */
    sender: string;

    /** The reason code for the failure */
    code: DecryptionFailureCode;

    /** A textual reason for the failure */
    msg: string;

    /** Optional `event_id` for the event. If provided will be used as event ID; else an ID is generated. */
    eventId?: string;
}): Promise<MatrixEvent> {
    const mxEvent = mkMatrixEvent({
        type: EventType.RoomMessageEncrypted,
        roomId: opts.roomId,
        sender: opts.sender,
        content: { algorithm: "m.megolm.v1.aes-sha2" },
        eventId: opts.eventId,
    });

    const mockCrypto = {
        decryptEvent: async (_ev): Promise<EventDecryptionResult> => {
            throw new DecryptionError(opts.code, opts.msg);
        },
    } as Parameters<MatrixEvent["attemptDecryption"]>[0];
    await mxEvent.attemptDecryption(mockCrypto);
    return mxEvent;
}

/**
 * Given an event previously returned by {@link mkDecryptionFailureMatrixEvent}, simulate a successful re-decryption
 * attempt.
 *
 * @param mxEvent - The event that will be decrypted.
 * @param opts - New data for the successful decryption.
 */
export async function decryptExistingEvent(
    mxEvent: MatrixEvent,
    opts: {
        /** The type the event will have, once it has been decrypted. */
        plainType: EventType | string;

        /** The content the event will have, once it has been decrypted. */
        plainContent: IContent;
    },
): Promise<void> {
    const decryptionResult: EventDecryptionResult = {
        claimedEd25519Key: "",
        clearEvent: {
            type: opts.plainType,
            content: opts.plainContent,
        },
        forwardingCurve25519KeyChain: [],
        senderCurve25519Key: "",
        untrusted: false,
    };

    const mockCrypto = {
        decryptEvent: async (_ev): Promise<EventDecryptionResult> => decryptionResult,
    } as Parameters<MatrixEvent["attemptDecryption"]>[0];
    await mxEvent.attemptDecryption(mockCrypto);
}
