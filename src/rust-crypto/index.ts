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

import { RustCrypto } from "./rust-crypto";
import { logger } from "../logger";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { ServerSideSecretStorage } from "../secret-storage";
import { ICryptoCallbacks } from "../crypto";

/**
 * Create a new `RustCrypto` implementation
 *
 * @param http - Low-level HTTP interface: used to make outgoing requests required by the rust SDK.
 *     We expect it to set the access token, etc.
 * @param userId - The local user's User ID.
 * @param deviceId - The local user's Device ID.
 * @param secretStorage - Interface to server-side secret storage.
 * @param cryptoCallbacks - Crypto callbacks provided by the application
 * @param storePrefix - the prefix to use on the indexeddbs created by rust-crypto.
 *     If unset, a memory store will be used.
 */
export async function initRustCrypto(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    userId: string,
    deviceId: string,
    secretStorage: ServerSideSecretStorage,
    cryptoCallbacks: ICryptoCallbacks,
    storePrefix: string | null,
): Promise<RustCrypto> {
    // initialise the rust matrix-sdk-crypto-js, if it hasn't already been done
    await RustSdkCryptoJs.initAsync();

    // enable tracing in the rust-sdk
    new RustSdkCryptoJs.Tracing(RustSdkCryptoJs.LoggerLevel.Trace).turnOn();

    const u = new RustSdkCryptoJs.UserId(userId);
    const d = new RustSdkCryptoJs.DeviceId(deviceId);
    logger.info("Init OlmMachine");

    // TODO: use the pickle key for the passphrase
    const olmMachine = await RustSdkCryptoJs.OlmMachine.initialize(
        u,
        d,
        storePrefix ?? undefined,
        (storePrefix && "test pass") ?? undefined,
    );
    const rustCrypto = new RustCrypto(olmMachine, http, userId, deviceId, secretStorage, cryptoCallbacks);
    await olmMachine.registerRoomKeyUpdatedCallback((sessions: RustSdkCryptoJs.RoomKeyInfo[]) =>
        rustCrypto.onRoomKeysUpdated(sessions),
    );

    // Tell the OlmMachine to think about its outgoing requests before we hand control back to the application.
    //
    // This is primarily a fudge to get it to correctly populate the `users_for_key_query` list, so that future
    // calls to getIdentity (etc) block until the key queries are performed.
    //
    // Note that we don't actually need to *make* any requests here; it is sufficient to tell the Rust side to think
    // about them.
    //
    // XXX: find a less hacky way to do this.
    await olmMachine.outgoingRequests();

    logger.info("Completed rust crypto-sdk setup");
    return rustCrypto;
}
