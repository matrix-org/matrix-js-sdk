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

import { RendezvousCode, RendezvousTransport } from ".";

export interface RendezvousChannel {
    transport: RendezvousTransport;
    /**
     * @returns the checksum/confirmation digits to be shown to the user
     */
    connect(): Promise<string>;
    /**
     * Send a payload via the channel.
     * @param data payload to send
     */
    send(data: any): Promise<void>;
    /**
     * Receive a payload from the channel.
     * @returns the received payload
     */
    receive(): Promise<any>;
    /**
     * @returns a representation of the channel that can be encoded in a QR or similar
     */
    generateCode(): Promise<RendezvousCode>;
}
