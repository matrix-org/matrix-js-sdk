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

import type { IMegolmSessionData } from "./@types/crypto";
import { Room } from "./models/room";

/**
 * Public interface to the cryptography parts of the js-sdk
 *
 * @remarks Currently, this is a work-in-progress. In time, more methods will be added here.
 */
export interface CryptoApi {
    /**
     * Global override for whether the client should ever send encrypted
     * messages to unverified devices. This provides the default for rooms which
     * do not specify a value.
     *
     * If true, all unverified devices will be blacklisted by default
     */
    globalBlacklistUnverifiedDevices: boolean;

    /**
     * Checks if the user has previously published cross-signing keys
     *
     * This means downloading the devicelist for the user and checking if the list includes
     * the cross-signing pseudo-device.
     *
     * @returns true if the user has previously published cross-signing keys
     */
    userHasCrossSigningKeys(): Promise<boolean>;

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     */
    prepareToEncrypt(room: Room): void;

    /**
     * Discard any existing megolm session for the given room.
     *
     * This will ensure that a new session is created on the next call to {@link prepareToEncrypt},
     * or the next time a message is sent.
     *
     * This should not normally be necessary: it should only be used as a debugging tool if there has been a
     * problem with encryption.
     *
     * @param roomId - the room to discard sessions for
     */
    forceDiscardSession(roomId: string): Promise<void>;

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
