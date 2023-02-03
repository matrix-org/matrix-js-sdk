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
import { RUST_SDK_STORE_PREFIX } from "./constants";
import { IHttpOpts, MatrixHttpApi } from "../http-api";

export async function initRustCrypto(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    userId: string,
    deviceId: string,
): Promise<RustCrypto> {
    // initialise the rust matrix-sdk-crypto-js, if it hasn't already been done
    await RustSdkCryptoJs.initAsync();

    // enable tracing in the rust-sdk
    new RustSdkCryptoJs.Tracing(RustSdkCryptoJs.LoggerLevel.Debug).turnOn();

    const u = new RustSdkCryptoJs.UserId(userId);
    const d = new RustSdkCryptoJs.DeviceId(deviceId);
    logger.info("Init OlmMachine");

    // TODO: use the pickle key for the passphrase
    const olmMachine = await RustSdkCryptoJs.OlmMachine.initialize(u, d, RUST_SDK_STORE_PREFIX, "test pass");
    const rustCrypto = new RustCrypto(olmMachine, http, userId, deviceId);

    logger.info("Completed rust crypto-sdk setup");
    return rustCrypto;
}
