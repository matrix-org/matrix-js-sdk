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

import { QRCodeData } from "../crypto/verification/QRCode";
import { MatrixClient } from "../matrix";
import { MSC4108SignInWithQR } from "./MSC4108SignInWithQR";
import { RendezvousError } from "./RendezvousError";
import { RendezvousFailureListener, RendezvousFailureReason } from "./RendezvousFailureReason";
import { RendezvousIntent } from "./RendezvousIntent";
import { MSC4108SecureChannel } from "./channels";
import { MSC4108RendezvousSession } from "./transports";

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
    const scannerIntent = client
        ? RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE
        : RendezvousIntent.LOGIN_ON_NEW_DEVICE;

    const { channel, homeserverBaseUrl } = await buildChannelFromCode(scannerIntent, code, onFailure);

    return { signin: new MSC4108SignInWithQR(channel, true, client, onFailure), homeserverBaseUrl };
}

async function buildChannelFromCode(
    scannerIntent: RendezvousIntent,
    code: Buffer,
    onFailure: RendezvousFailureListener,
): Promise<{ channel: MSC4108SecureChannel; intent: RendezvousIntent; homeserverBaseUrl?: string }> {
    const {
        intent: scannedIntent,
        publicKey,
        rendezvousSessionUrl,
        homeserverBaseUrl,
    } = await QRCodeData.parseForRendezvous(code);

    if (scannedIntent === scannerIntent) {
        throw new RendezvousError(
            "The scanned intent is the same as the scanner intent",
            scannerIntent === RendezvousIntent.LOGIN_ON_NEW_DEVICE
                ? RendezvousFailureReason.OtherDeviceNotSignedIn
                : RendezvousFailureReason.OtherDeviceAlreadySignedIn,
        );
    }

    // need to validate the values
    const rendezvousSession = new MSC4108RendezvousSession({
        onFailure,
        url: rendezvousSessionUrl,
    });

    return {
        channel: new MSC4108SecureChannel(rendezvousSession, publicKey, onFailure),
        intent: scannedIntent,
        homeserverBaseUrl,
    };
}
