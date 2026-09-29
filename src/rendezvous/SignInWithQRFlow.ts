/*
Copyright 2026 Element Creations Ltd.

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
    type ClientRendezvousFailureReason,
    type MSC4108FailureReason,
    type RendezvousFailureListener,
} from "./RendezvousFailureReason.ts";
import { type DeviceAccessTokenResponse, type ValidatedAuthMetadata } from "../oauth/index.ts";
import type { SecretsBundleJson } from "../@types/matrix-sdk-crypto-wasm.d.ts";

/**
 * Common interface for the sign in with QR + OAuth2 flows, e.g. the 2024 and 2025 versions of
 * [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108).
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export interface SignInWithQRFlow {
    /**
     * Callback for when the rendezvous fails.
     */
    onFailure?: RendezvousFailureListener;

    /**
     * Returns the check code for the secure channel or undefined if not generated yet.
     */
    readonly checkCode: string | undefined;

    /**
     * Returns the code representing the rendezvous suitable for rendering in a QR code or undefined if not generated yet.
     */
    readonly code: Uint8Array | undefined;

    /**
     * Returns true if the device is the already logged in device reciprocating a new login on the other side of the channel.
     */
    readonly isExistingDevice: boolean;

    /**
     * Returns true if the device is the new device logging in being reciprocated by the device on the other side of the channel.
     */
    readonly isNewDevice: boolean;

    /**
     * Generate the code including doing partial set up of the channel where required.
     */
    generateCode(): Promise<void>;

    /**
     * The first step in the OAuth2 QR login process.
     * To be called after the QR code has been rendered or scanned.
     * The scanning device has to discover the homeserver details, if they scanned the code then they already have it.
     * If the new device is the one rendering the QR code then it has to wait be sent the homeserver details via the rendezvous channel.
     *
     * Depending on the version of the flow, the homeserver is identified either by `serverName` or `baseUrl`.
     */
    negotiateProtocols(): Promise<{ serverName?: string; baseUrl?: string }>;

    /**
     * The second & third step in the OAuth2 QR login process.
     * To be called after `negotiateProtocols` for the existing device.
     * To be called after OAuth2 negotiation for the new device.
     *
     * @param input - Required for the new device to start the device authorization grant, not required for the existing device reciprocating the login
     */
    deviceAuthorizationGrant(input?: { metadata: ValidatedAuthMetadata; clientId: string; deviceId: string }): Promise<{
        verificationUri?: string;
        userCode?: string;
    }>;

    /**
     * The fourth step in the OAuth2 QR login process.
     * The reciprocating device must perform step 5 for this method to resolve.
     * To be called after {@link deviceAuthorizationGrant} only on the new device.
     */
    completeLoginOnNewDevice(input: { clientId: string }): Promise<DeviceAccessTokenResponse | undefined>;

    /**
     * The fifth (and final) step in the OAuth2 QR login process.
     * To be called after the new device has completed authentication.
     */
    shareSecrets(): Promise<{ secrets?: SecretsBundleJson }>;

    /**
     * Decline the login on the existing device.
     */
    declineLoginOnExistingDevice(): Promise<void>;

    /**
     * Cancels the rendezvous session.
     * @param reason the reason for the cancellation
     */
    cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void>;

    /**
     * Closes the rendezvous session.
     */
    close(): Promise<void>;
}
