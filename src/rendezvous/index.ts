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

import type { QrCodeMode } from "@matrix-org/matrix-sdk-crypto-wasm";
import { MatrixClient } from "../matrix";
import { MSC4108SignInWithQR } from "./MSC4108SignInWithQR";
import { RendezvousError } from "./RendezvousError";
import { ClientRendezvousFailureReason, RendezvousFailureListener } from "./RendezvousFailureReason";
import { MSC4108SecureChannel } from "./channels";
import { MSC4108RendezvousSession } from "./transports";

/**
 * @deprecated in favour of MSC4108-based implementation
 */
export * from "./MSC3906Rendezvous";
export * from "./MSC4108SignInWithQR";
export * from "./RendezvousChannel";
export * from "./RendezvousCode";
export * from "./RendezvousError";
export * from "./RendezvousFailureReason";
export * from "./RendezvousIntent";
export * from "./RendezvousTransport";
export * from "./transports";
export * from "./channels";

export async function buildLoginFromScannedCode(
    client: MatrixClient | undefined,
    code: Buffer,
    onFailure: RendezvousFailureListener,
): Promise<{ signin: MSC4108SignInWithQR; homeserverBaseUrl?: string }> {
    const RustCrypto = await import("@matrix-org/matrix-sdk-crypto-wasm");
    const scannerIntent = client ? RustCrypto.QrCodeMode.Reciprocate : RustCrypto.QrCodeMode.Login;

    const { channel, homeserverBaseUrl } = await buildChannelFromCode(scannerIntent, code, onFailure);

    return { signin: new MSC4108SignInWithQR(channel, true, client, onFailure), homeserverBaseUrl };
}

async function buildChannelFromCode(
    scannerMode: QrCodeMode,
    code: Buffer,
    onFailure: RendezvousFailureListener,
): Promise<{ channel: MSC4108SecureChannel; intent: QrCodeMode; homeserverBaseUrl?: string }> {
    const RustCrypto = await import("@matrix-org/matrix-sdk-crypto-wasm");

    const qrCodeData = RustCrypto.QrCodeData.from_bytes(code);

    if (qrCodeData.mode === scannerMode) {
        throw new RendezvousError(
            "The scanned intent is the same as the scanner intent",
            scannerMode === RustCrypto.QrCodeMode.Login
                ? ClientRendezvousFailureReason.OtherDeviceNotSignedIn
                : ClientRendezvousFailureReason.OtherDeviceAlreadySignedIn,
        );
    }

    // need to validate the values
    const rendezvousSession = new MSC4108RendezvousSession({
        onFailure,
        url: qrCodeData.rendezvous_url,
    });

    return {
        channel: new MSC4108SecureChannel(rendezvousSession, qrCodeData.public_key, onFailure),
        intent: qrCodeData.mode,
        homeserverBaseUrl: qrCodeData.homeserver_url,
    };
}
