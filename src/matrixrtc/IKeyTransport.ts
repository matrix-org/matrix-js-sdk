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

import { type MatrixEvent } from "../models/event.ts";
import { type Statistics } from "./EncryptionManager.ts";

/**
 * Generic interface for the transport used to share room keys.
 * Keys can be shared using different transports, e.g. to-device messages or room messages.
 */
export interface IKeyTransport {
    /**
     * Sends the current user media key.
     * @param keyBase64Encoded
     * @param index
     */
    sendKey(keyBase64Encoded: string, index: number): Promise<void>;

    /**
     * Takes an incoming event from the transport and extracts the key information.
     * @param event
     * @param statistics
     * @param callback
     */
    receiveRoomEvent(
        event: MatrixEvent,
        statistics: Statistics,
        callback: (
            userId: string,
            deviceId: string,
            encryptionKeyIndex: number,
            encryptionKeyString: string,
            timestamp: number,
        ) => void,
    ): void;
}
