/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import type { IDeviceLists, IToDeviceEvent, ReceivedToDeviceMessage } from "../sync-accumulator.ts";
import { type IClearEvent, type MatrixEvent } from "../models/event.ts";
import { type Room } from "../models/room.ts";
import { type CryptoApi, type DecryptionFailureCode, type ImportRoomKeysOpts } from "../crypto-api/index.ts";
import { type KeyBackupInfo, type KeyBackupSession } from "../crypto-api/keybackup.ts";
import { type IMegolmSessionData } from "../@types/crypto.ts";

/**
 * Common interface for the crypto implementations
 *
 * @internal
 */
export interface CryptoBackend extends SyncCryptoCallbacks, CryptoApi {
    /**
     * Whether sendMessage in a room with unknown and unverified devices
     * should throw an error and not send the message. This has 'Global' for
     * symmetry with setGlobalBlacklistUnverifiedDevices but there is currently
     * no room-level equivalent for this setting.
     *
     * @remarks This has no effect in Rust Crypto; it exists only for the sake of
     * the accessors in MatrixClient.
     */
    globalErrorOnUnknownDevices: boolean;

    /**
     * Shut down any background processes related to crypto
     */
    stop(): void;

    /**
     * Encrypt an event according to the configuration of the room.
     *
     * @param event -  event to be sent
     *
     * @param room - destination room.
     *
     * @returns Promise which resolves when the event has been
     *     encrypted, or null if nothing was needed
     */
    encryptEvent(event: MatrixEvent, room: Room): Promise<void>;

    /**
     * Decrypt a received event
     *
     * @returns a promise which resolves once we have finished decrypting.
     * Rejects with an error if there is a problem decrypting the event.
     */
    decryptEvent(event: MatrixEvent): Promise<EventDecryptionResult>;

    /**
     * Get a backup decryptor capable of decrypting megolm session data encrypted with the given backup information.
     * @param backupInfo - The backup information
     * @param privKey - The private decryption key.
     */
    getBackupDecryptor(backupInfo: KeyBackupInfo, privKey: Uint8Array): Promise<BackupDecryptor>;

    /**
     * Import a list of room keys restored from backup
     *
     * @param keys - a list of session export objects
     * @param backupVersion - the version of the backup these keys came from.
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    importBackedUpRoomKeys(keys: IMegolmSessionData[], backupVersion: string, opts?: ImportRoomKeysOpts): Promise<void>;

    /**
     * Having accepted an invite for the given room from the given user, attempt to
     * find information about a room key bundle and, if found, download the
     * bundle and import the room keys, as per {@link https://github.com/matrix-org/matrix-spec-proposals/pull/4268|MSC4268}.
     *
     * @param roomId - The room we were invited to, for which we want to check if a room
     *   key bundle was received.
     *
     * @param inviter - The user who invited us to the room and is expected to have
     *   sent the room key bundle.
     */
    maybeAcceptKeyBundle(roomId: string, inviter: string): Promise<void>;
}

/** The methods which crypto implementations should expose to the Sync api
 *
 * @internal
 */
export interface SyncCryptoCallbacks {
    /**
     * Called by the /sync loop whenever there are incoming to-device messages.
     *
     * The implementation may preprocess the received messages (eg, decrypt them) and return an
     * updated list of messages for dispatch to the rest of the system.
     *
     * Note that, unlike {@link ClientEvent.ToDeviceEvent} events, this is called on the raw to-device
     * messages, rather than the results of any decryption attempts.
     *
     * @param events - the received to-device messages
     * @returns A list of preprocessed to-device messages. This will not map 1:1 to the input list, as some messages may be invalid or
     * failed to decrypt, and so will be omitted from the output list.
     *
     */
    preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<ReceivedToDeviceMessage[]>;

    /**
     * Called by the /sync loop when one time key counts and unused fallback key details are received.
     *
     * @param oneTimeKeysCounts - the received one time key counts
     * @param unusedFallbackKeys - the received unused fallback keys
     */
    processKeyCounts(oneTimeKeysCounts?: Record<string, number>, unusedFallbackKeys?: string[]): Promise<void>;

    /**
     * Handle the notification from /sync that device lists have
     * been changed.
     *
     * @param deviceLists - device_lists field from /sync
     */
    processDeviceLists(deviceLists: IDeviceLists): Promise<void>;

    /**
     * Called by the /sync loop whenever an m.room.encryption event is received.
     *
     * This is called before RoomStateEvents are emitted for any of the events in the /sync
     * response (even if the other events technically happened first). This works around a problem
     * if the client uses a RoomStateEvent (typically a membership event) as a trigger to send a message
     * in a new room (or one where encryption has been newly enabled): that would otherwise leave the
     * crypto layer confused because it expects crypto to be set up, but it has not yet been.
     *
     * @param room - in which the event was received
     * @param event - encryption event to be processed
     */
    onCryptoEvent(room: Room, event: MatrixEvent): Promise<void>;

    /**
     * Called by the /sync loop after each /sync response is processed.
     *
     * Used to complete batch processing, or to initiate background processes
     *
     * @param syncState - information about the completed sync.
     */
    onSyncCompleted(syncState: OnSyncCompletedData): void;

    /**
     * Mark all tracked users' device lists as dirty.
     *
     * This method will cause additional `/keys/query` requests on the server, so should be used only
     * when the client has desynced tracking device list deltas from the server.
     * In MSC4186: Simplified Sliding Sync, this can happen when the server expires the connection.
     */
    markAllTrackedUsersAsDirty(): Promise<void>;
}

/**
 * @internal
 */
export interface OnSyncCompletedData {
    /**
     * The 'next_batch' result from /sync, which will become the 'since' token for the next call to /sync.
     */
    nextSyncToken?: string;

    /**
     * True if we are working our way through a backlog of events after connecting.
     */
    catchingUp?: boolean;
}

/**
 * The result of a (successful) call to {@link CryptoBackend.decryptEvent}
 */
export interface EventDecryptionResult {
    /**
     * The plaintext payload for the event (typically containing <tt>type</tt> and <tt>content</tt> fields).
     */
    clearEvent: IClearEvent;
    /**
     * List of curve25519 keys involved in telling us about the senderCurve25519Key and claimedEd25519Key.
     * See {@link MatrixEvent#getForwardingCurve25519KeyChain}.
     */
    forwardingCurve25519KeyChain?: string[];
    /**
     * Key owned by the sender of this event.  See {@link MatrixEvent#getSenderKey}.
     */
    senderCurve25519Key?: string;
    /**
     * ed25519 key claimed by the sender of this event. See {@link MatrixEvent#getClaimedEd25519Key}.
     */
    claimedEd25519Key?: string;
    /**
     * Whether the keys for this event have been received via an unauthenticated source (eg via key forwards, or
     * restored from backup)
     */
    untrusted?: boolean;
}

/**
 * Responsible for decrypting megolm session data retrieved from a remote backup.
 * The result of {@link CryptoBackend#getBackupDecryptor}.
 */
export interface BackupDecryptor {
    /**
     * Whether keys retrieved from this backup can be trusted.
     *
     * Depending on the backup algorithm, keys retrieved from the backup can be trusted or not.
     * If false, keys retrieved from the backup  must be considered unsafe (authenticity cannot be guaranteed).
     * It could be by design (deniability) or for some technical reason (eg asymmetric encryption).
     */
    readonly sourceTrusted: boolean;

    /**
     *
     * Decrypt megolm session data retrieved from backup.
     *
     * @param ciphertexts - a Record of sessionId to session data.
     *
     * @returns An array of decrypted `IMegolmSessionData`
     */
    decryptSessions(ciphertexts: Record<string, KeyBackupSession>): Promise<IMegolmSessionData[]>;

    /**
     * Free any resources held by this decryptor.
     *
     * Should be called once the decryptor is no longer needed.
     */
    free(): void;
}

/**
 * Exception thrown when decryption fails
 *
 * @param code - Reason code for the failure.
 *
 * @param msg - user-visible message describing the problem
 *
 * @param details - key/value pairs reported in the logs but not shown
 *   to the user.
 */
export class DecryptionError extends Error {
    public readonly detailedString: string;

    public constructor(
        public readonly code: DecryptionFailureCode,
        msg: string,
        details?: Record<string, string | Error>,
    ) {
        super(msg);
        this.name = "DecryptionError";
        this.detailedString = detailedStringForDecryptionError(this, details);
    }
}

function detailedStringForDecryptionError(err: DecryptionError, details?: Record<string, string | Error>): string {
    let result = err.name + "[msg: " + err.message;

    if (details) {
        result +=
            ", " +
            Object.keys(details)
                .map((k) => k + ": " + details[k])
                .join(", ");
    }

    result += "]";

    return result;
}
