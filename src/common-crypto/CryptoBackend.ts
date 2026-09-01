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

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Room key history sharing (MSC4268)
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Share any shareable E2EE history in the given room with the given recipient,
     * as per [MSC4268](https://github.com/matrix-org/matrix-spec-proposals/pull/4268)
     */
    shareRoomHistoryWithUser(roomId: string, userId: string): Promise<void>;

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
     *
     * @returns `true` if the key bundle was successfuly downloaded and imported.
     */
    maybeAcceptKeyBundle(roomId: string, inviter: string): Promise<boolean>;

    /**
     * Mark a room as pending a key bundle under MSC4268. The backend will listen for room key bundle messages, and if
     * it sees one matching the room specified, it will automatically import it as long as the message author's ID matches
     * the inviter's ID.
     *
     * @param roomId - The room we were invited to, for which we did not receive a key bundle before accepting the invite.
     * @param inviterId - The user who invited us to the room and is expected to send the room key bundle.
     */
    markRoomAsPendingKeyBundle(roomId: string, inviterId: string): Promise<void>;
}

/**
 * The parts of a sync response which are relevant to encryption, as passed to
 * {@link SyncCryptoCallbacks.processSyncChanges}.
 *
 * @internal
 */
export interface SyncCryptoChanges {
    /** The to-device events from the sync response (`to_device.events`), or an empty list if there were none. */
    toDeviceEvents: IToDeviceEvent[];

    /** The `device_lists` field from the sync response, if any. */
    deviceLists?: IDeviceLists;

    /**
     * The `device_one_time_keys_count` field from the sync response, if any.
     *
     * The meaning of an algorithm missing from the map (or of an absent field) depends on {@link useMsc4186}: in
     * sync v2 it means that there are no one-time keys of that algorithm on the server; in sliding sync it means that
     * the count is unchanged since the previous response.
     */
    oneTimeKeysCounts?: Record<string, number>;

    /**
     * The `device_unused_fallback_key_types` field from the sync response, or `undefined` if the response did not
     * include it (which means that the server does not support fallback keys).
     */
    unusedFallbackKeys?: string[];

    /**
     * Whether to interpret the response with MSC4186 (simplified sliding sync) semantics rather than sync v2. This
     * selects the meaning of missing one-time key counts: see {@link oneTimeKeysCounts}. Defaults to `false`.
     */
    useMsc4186?: boolean;
}

/** The methods which crypto implementations should expose to the Sync api
 *
 * @internal
 */
export interface SyncCryptoCallbacks {
    /**
     * Called by the sync loop once per sync response, with the parts of the response which are relevant to
     * encryption: to-device messages, device list changes, one-time key counts and unused fallback key types.
     *
     * All of this data must be passed together, in a single call per sync response, because the OlmMachine
     * interprets it as the complete E2EE state from a sync response. In particular, per the sync v2 specification,
     * an absent `device_one_time_keys_count` means that there are no one-time keys on the server, so calling this
     * without the counts from the response would trigger a spurious one-time key upload. (Sliding sync responses
     * omit the count when it is unchanged; {@link SyncCryptoChanges.useMsc4186} selects that interpretation.)
     *
     * This must be called before the room events in the sync response are processed, so that any room keys received
     * in to-device messages are available when decrypting room events.
     *
     * @param changes - the E2EE-relevant parts of the sync response
     * @returns A list of processed to-device messages. This will not map 1:1 to the input list, as some messages may
     *    be invalid or fail to decrypt, and so will be omitted from the output list.
     */
    processSyncChanges(changes: SyncCryptoChanges): Promise<ReceivedToDeviceMessage[]>;

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
     * No longer used.
     * See {@link MatrixEvent#getForwardingCurve25519KeyChain}.
     * @deprecated
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
     * If another user forwarded the key to this message
     * (eg via [MSC4268](https://github.com/matrix-org/matrix-spec-proposals/pull/4268)),
     * the ID of that user.
     */
    keyForwardedBy?: string;
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
