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

import { OAuthGrantType, type MatrixClient } from "../matrix.ts";
import type { RendezvousFailureListener } from "./RendezvousFailureReason.ts";
import { MSC4108SignInWithQR } from "./MSC4108SignInWithQR.ts";
import { MSC4108RendezvousSession } from "./transports/MSC4108RendezvousSession.ts";
import { MSC4108SecureChannel } from "./channels/MSC4108SecureChannel.ts";

export * from "./MSC4108SignInWithQR.ts";
export type * from "./RendezvousChannel.ts";
export type * from "./RendezvousCode.ts";
export * from "./RendezvousError.ts";
export * from "./RendezvousFailureReason.ts";
export * from "./RendezvousIntent.ts";
export type * from "./RendezvousTransport.ts";
export * from "./transports/index.ts";
export * from "./channels/index.ts";

/**
 * Check if the homeserver that the client is connected to supports a variant of sign-in with QR that we can use.
 *
 * @param client the client to check for sign-in with QR support
 * @returns true if the homeserver that the client is connected to supports a variant of sign-in with QR that we can use, false otherwise.
 */
export async function isSignInWithQRAvailable(client: MatrixClient): Promise<boolean> {
    // check for support of device authorization grant
    const metadata = await client.getAuthMetadata();
    if (!metadata.grant_types_supported.includes(OAuthGrantType.DeviceAuthorization)) {
        return false;
    }

    // check for unstable support for MSC4108 2024 version
    return client.doesServerSupportUnstableFeature("org.matrix.msc4108");
}

/**
 * Start a linking flow from an existing authenticated client by generating a QR code that can be scanned by the new device.
 * The new device will then authenticate with the server and link itself to the same account as the existing client and
 * share the end-to-end encryption keys.
 *
 * @param client the existing client
 * @param onFailure callback for when the linking process fails
 * @returns a promise that resolves to an instance of the linking flow
 */
export async function linkNewDeviceByGeneratingQR(
    client: MatrixClient,
    onFailure: RendezvousFailureListener,
): Promise<MSC4108SignInWithQR> {
    // we assume rust crypto is already initialised
    const session = new MSC4108RendezvousSession({
        onFailure,
        client,
    });
    await session.send("");
    const channel = new MSC4108SecureChannel(session, undefined, onFailure);
    const flow = new MSC4108SignInWithQR(channel, false, client, onFailure);

    await flow.generateCode();

    return flow;
}

/**
 * Start a sign-in flow by generating a QR code that can be scanned by an existing authenticated client.
 * The existing client will then help complete the authentication of the new device and link it to the same account,
 * sharing the end-to-end encryption keys.
 *
 * @param tempClient temporary client used during the flow for the rendezvous channel
 * @param onFailure callback for when the sign-in process fails
 * @returns a promise that resolves to an instance of the sign-in flow
 */
export async function signInByGeneratingQR(
    tempClient: MatrixClient,
    onFailure: RendezvousFailureListener,
): Promise<MSC4108SignInWithQR> {
    // ensure rust crypto is initialized as needed for the secure channel
    const RustSdkCryptoJs = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await RustSdkCryptoJs.initAsync();

    const session = new MSC4108RendezvousSession({
        onFailure,
        client: tempClient,
    });
    await session.send("");
    const channel = new MSC4108SecureChannel(session, undefined, onFailure);
    const flow = new MSC4108SignInWithQR(channel, false, undefined, onFailure);

    await flow.generateCode();

    return flow;
}
