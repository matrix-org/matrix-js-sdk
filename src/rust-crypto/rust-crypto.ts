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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";

import { IEventDecryptionResult } from "../@types/crypto";
import { MatrixEvent } from "../models/event";
import { CryptoBackend } from "../common-crypto/CryptoBackend";

// import { logger } from "../logger";

/**
 * An implementation of {@link CryptoBackend} using the Rust matrix-sdk-crypto.
 */
export class RustCrypto implements CryptoBackend {
    public globalBlacklistUnverifiedDevices = false;
    public globalErrorOnUnknownDevices = false;

    /** whether stop() has been called */
    private stopped = false;

    public constructor(private readonly olmMachine: RustSdkCryptoJs.OlmMachine, _userId: string, _deviceId: string) {}

    public stop(): void {
        // stop() may be called multiple times, but attempting to close() the OlmMachine twice
        // will cause an error.
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        // make sure we close() the OlmMachine; doing so means that all the Rust objects will be
        // cleaned up; in particular, the indexeddb connections will be closed, which means they
        // can then be deleted.
        this.olmMachine.close();
    }

    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        await this.olmMachine.decryptRoomEvent("event", new RustSdkCryptoJs.RoomId("room"));
        throw new Error("not implemented");
    }

    public async userHasCrossSigningKeys(): Promise<boolean> {
        // TODO
        return false;
    }
}
