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

import type { IEventDecryptionResult, IMegolmSessionData } from "../@types/crypto";
import type { IToDeviceEvent } from "../sync-accumulator";
import type { DeviceTrustLevel, UserTrustLevel } from "../crypto/CrossSigning";
import { MatrixEvent } from "../models/event";
import { Room } from "../models/room";
import { IEncryptedEventInfo } from "../crypto/api";

/**
 * Common interface for the crypto implementations
 */
export interface CryptoBackend extends SyncCryptoCallbacks {
    /**
     * Global override for whether the client should ever send encrypted
     * messages to unverified devices. This provides the default for rooms which
     * do not specify a value.
     *
     * If true, all unverified devices will be blacklisted by default
     */
    globalBlacklistUnverifiedDevices: boolean;

    /**
     * Whether sendMessage in a room with unknown and unverified devices
     * should throw an error and not send the message. This has 'Global' for
     * symmetry with setGlobalBlacklistUnverifiedDevices but there is currently
     * no room-level equivalent for this setting.
     */
    globalErrorOnUnknownDevices: boolean;

    /**
     * Shut down any background processes related to crypto
     */
    stop(): void;

    /**
     * Checks if the user has previously published cross-signing keys
     *
     * This means downloading the devicelist for the user and checking if the list includes
     * the cross-signing pseudo-device.

     * @returns true if the user has previously published cross-signing keys
     */
    userHasCrossSigningKeys(): Promise<boolean>;

    /**
     * Get the verification level for a given user
     *
     * TODO: define this better
     *
     * @param userId - user to be checked
     */
    checkUserTrust(userId: string): UserTrustLevel;

    /**
     * Get the verification level for a given device
     *
     * TODO: define this better
     *
     * @param userId - user to be checked
     * @param deviceId - device to be checked
     */
    checkDeviceTrust(userId: string, deviceId: string): DeviceTrustLevel;

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     */
    prepareToEncrypt(room: Room): void;

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
    decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult>;

    /**
     * Get information about the encryption of an event
     *
     * @param event - event to be checked
     */
    getEventEncryptionInfo(event: MatrixEvent): IEncryptedEventInfo;

    /**
     * Get a list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @returns a promise which resolves to a list of
     *    session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;
}

/** The methods which crypto implementations should expose to the Sync api */
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
     * @returns A list of preprocessed to-device messages.
     */
    preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<IToDeviceEvent[]>;

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
}

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
