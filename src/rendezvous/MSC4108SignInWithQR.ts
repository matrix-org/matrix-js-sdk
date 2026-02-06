/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import {
    MSC4108RendezvousSession,
    MSC4108SecureChannel,
    type RendezvousFailureListener,
    type ClientRendezvousFailureReason,
    type MSC4108FailureReason,
} from "./index.ts";
import { MSC4108v2024SignInWithQR } from "./MSC4108v2024SignInWithQR.ts";
import { type IServerVersions, OAuthGrantType, type MatrixClient, type ValidatedAuthMetadata } from "../matrix.ts";
import { type CryptoApi } from "../crypto-api/index.ts";

type Secrets = Awaited<ReturnType<NonNullable<CryptoApi["exportSecretsBundle"]>>>;

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * sign in with QR + OIDC flow.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export interface IMSC4108SignInWithQR {
    /**
     * The generated QR code, as a byte array. This can be rendered into an actual QR code using a library such as `qrcode`.
     */
    code: Uint8Array | undefined;

    /**
     * The check code to display to the user during the flow. This is used to protect against MITM attacks.
     */
    checkCode: string | undefined;

    // TODO: the names for these will need tidying and documenting up during stabilisation
    negotiateProtocols(): Promise<{ serverName?: string; baseUrl?: string }>;
    deviceAuthorizationGrant(input?: { metadata: ValidatedAuthMetadata; clientId: string; deviceId: string }): Promise<{
        verificationUri?: string;
        userCode?: string;
    }>;
    shareSecrets(): Promise<{ secrets?: Secrets }>;
    declineLoginOnExistingDevice(): Promise<void>;

    /**
     * Cancel the flow.
     * @param reason the reason for the cancellation
     */
    cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void>;

    /**
     * @deprecated use {@link setFailureListener} instead.
     */
    onFailure?: RendezvousFailureListener;
    /**
     * Set a listener to be called if the flow fails. The listener will be passed a {@link RendezvousError} with more details on the failure.
     *
     * @param listener the new failure listener or undefined to clear
     */
    setFailureListener(listener?: RendezvousFailureListener): void;
}

export {
    /**
     * @deprecated use {@link linkNewDeviceByGeneratingQR} instead.
     */
    MSC4108v2024SignInWithQR as MSC4108SignInWithQR,
};

/**
 * Checks if the server advertises the necessary capabilities to support linking a new device by generating a QR code.
 *
 * n.b. we might want to move this to the MatrixClient when the MSC is stabilised.
 *
 * @param client MatrixClient instance to check server capabilities with
 * @returns true if the server has necessary capabilities to support linking a new device by generating a QR code, false otherwise
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export function doesServerSupportLinkNewDeviceByGeneratingQR(
    authMetadata: ValidatedAuthMetadata,
    versions: IServerVersions,
): boolean {
    const deviceAuthorizationGrantSupported = authMetadata.grant_types_supported.includes(
        OAuthGrantType.DeviceAuthorization,
    );

    if (!deviceAuthorizationGrantSupported) {
        return false;
    }

    const unstableMSC4108Supporred = versions.unstable_features?.["org.matrix.msc4108"] === true;

    // 2024 version
    if (unstableMSC4108Supporred) {
        return true;
    }

    return false;
}

/**
 * Initiates the flow to link a new device by generating a QR code for the user to scan from a new device.
 *
 * @param client the client instance
 * @param onFailure the listener to call if the flow fails, will be passed a {@link RendezvousError} with more details on the failure
 * @returns an instance of {@link IMSC4108SignInWithQR} to manage the flow.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export async function linkNewDeviceByGeneratingQR(
    client: MatrixClient,
    onFailure: RendezvousFailureListener,
): Promise<IMSC4108SignInWithQR> {
    // Currently only supports the 2024 version of MSC4108

    // create the rendezvous session
    const session = new MSC4108RendezvousSession({
        onFailure,
        client,
    });
    // send an empty payload
    await session.send("");

    // initialise the secure channel
    const channel = new MSC4108SecureChannel(session, undefined, onFailure);

    // wrap the channel in the protocol flow
    const flow = new MSC4108v2024SignInWithQR(channel, false, client, onFailure);

    // generate the QR so it is ready for use
    await flow.generateCode();

    return flow;
}
