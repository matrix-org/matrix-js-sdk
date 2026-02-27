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

import { QrCodeIntent } from "@matrix-org/matrix-sdk-crypto-wasm";

import { type CryptoApi } from "../crypto-api/index.ts";
import {
    MSC4108RendezvousSession,
    MSC4108SecureChannel,
    type RendezvousFailureListener,
    type ClientRendezvousFailureReason,
    type MSC4108FailureReason,
    MSC4388RendezvousSession,
    MSC4388SecureChannel,
} from "./index.ts";
import { MSC4108v2024SignInWithQR } from "./MSC4108v2024SignInWithQR.ts";
import {
    type DeviceAccessTokenResponse,
    OAuthGrantType,
    type IServerVersions,
    type MatrixClient,
    type ValidatedAuthMetadata,
} from "../matrix.ts";
import { MSC4108v2025SignInWithQR } from "./MSC4108v2025SignInWithQR.ts";

type Secrets = Awaited<ReturnType<NonNullable<CryptoApi["exportSecretsBundle"]>>>;

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * sign in with QR + OIDC flow.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export interface IMSC4108SignInWithQR {
    setFailureListener(listener?: RendezvousFailureListener): void;
    /**
     * @deprecated use {@link setFailureListener} instead.
     */
    onFailure?: RendezvousFailureListener;
    checkCode: string | undefined;
    code: Uint8Array | undefined;
    negotiateProtocols(): Promise<{ serverName?: string; baseUrl?: string }>;
    deviceAuthorizationGrant(input?: { metadata: ValidatedAuthMetadata; clientId: string; deviceId: string }): Promise<{
        verificationUri?: string;
        userCode?: string;
    }>;
    shareSecrets(): Promise<{ secrets?: Secrets }>;
    declineLoginOnExistingDevice(): Promise<void>;
    completeLoginOnNewDevice({ clientId }: { clientId: string }): Promise<DeviceAccessTokenResponse | undefined>;
    cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void>;
}

/**
 * @deprecated use {@link linkNewDeviceByGeneratingQR} or {@link signInByGeneratingQR} instead.
 */
export const MSC4108SignInWithQR: typeof MSC4108v2024SignInWithQR = MSC4108v2024SignInWithQR;

// n.b. we only support generating a code never scanning one
export async function signInByGeneratingQR(
    tempClient: MatrixClient,
    onFailure: RendezvousFailureListener,
): Promise<IMSC4108SignInWithQR> {
    // use 2025 version
    const session = new MSC4388RendezvousSession({
        onFailure,
        client: tempClient,
    });
    await session.send("");
    const channel = new MSC4388SecureChannel(session, QrCodeIntent.Login, undefined, onFailure);
    const flow = new MSC4108v2025SignInWithQR(channel, false, tempClient, onFailure);

    await flow.generateCode();

    return flow;
}

export async function linkNewDeviceByGeneratingQR(
    client: MatrixClient,
    onFailure: RendezvousFailureListener,
): Promise<IMSC4108SignInWithQR> {
    if (await client.doesServerSupportUnstableFeature("io.element.msc4388")) {
        // use 2025 version
        const session = new MSC4388RendezvousSession({
            onFailure,
            client,
        });
        await session.send("");
        const channel = new MSC4388SecureChannel(session, QrCodeIntent.Reciprocate, undefined, onFailure);
        const flow = new MSC4108v2025SignInWithQR(channel, false, client, onFailure);

        await flow.generateCode();

        return flow;
    }

    // default to 2024 version
    client.doesServerSupportUnstableFeature("io.element.msc4388");
    const session = new MSC4108RendezvousSession({
        onFailure,
        client,
    });
    await session.send("");
    const channel = new MSC4108SecureChannel(session, undefined, onFailure);
    const flow = new MSC4108v2024SignInWithQR(channel, false, client, onFailure);

    await flow.generateCode();

    return flow;
}

export function doesServerSupportSignInByGeneratingQR(
    authMetadata: ValidatedAuthMetadata,
    versions: IServerVersions,
): boolean {
    const deviceAuthorizationGrantSupported = authMetadata.grant_types_supported.includes(
        OAuthGrantType.DeviceAuthorization,
    );

    if (!deviceAuthorizationGrantSupported) {
        return false;
    }

    // 2025 version
    if (versions.unstable_features["io.element.msc4388"]) {
        return true;
    }

    // our implementation of the 2024 version doesn't support signing in on a new device with QR code
    return false;
}

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

    // 2025 version
    if (versions.unstable_features["io.element.msc4388"]) {
        return true;
    }

    // 2024 version
    if (versions.unstable_features["org.matrix.msc4108"]) {
        return true;
    }

    return false;
}
