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

import { QrCodeMode } from "@matrix-org/matrix-sdk-crypto-wasm";

import { ClientRendezvousFailureReason, MSC4108FailureReason, RendezvousError, RendezvousFailureListener } from ".";
import { MatrixClient } from "../client";
import { logger } from "../logger";
import { MSC4108SecureChannel } from "./channels/MSC4108SecureChannel";
import { MatrixError } from "../http-api";
import { sleep } from "../utils";
import { DEVICE_CODE_SCOPE, discoverAndValidateOIDCIssuerWellKnown, OidcClientConfig } from "../oidc";
import { CryptoApi } from "../crypto-api";

/**
 * Enum representing the payload types transmissible over [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * secure channels.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export enum PayloadType {
    Protocols = "m.login.protocols",
    Protocol = "m.login.protocol",
    Failure = "m.login.failure",
    Success = "m.login.success",
    Secrets = "m.login.secrets",
    ProtocolAccepted = "m.login.protocol_accepted",
    Declined = "m.login.declined",
}

/**
 * Type representing the base payload format for [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * messages sent over the secure channel.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export interface MSC4108Payload {
    type: PayloadType;
}

interface ProtocolsPayload extends MSC4108Payload {
    type: PayloadType.Protocols;
    protocols: string[];
    homeserver: string;
}

interface ProtocolPayload extends MSC4108Payload {
    type: PayloadType.Protocol;
    protocol: Exclude<string, "device_authorization_grant">;
    device_id: string;
}

interface DeviceAuthorizationGrantProtocolPayload extends ProtocolPayload {
    protocol: "device_authorization_grant";
    device_authorization_grant: {
        verification_uri: string;
        verification_uri_complete?: string;
    };
}

function isDeviceAuthorizationGrantProtocolPayload(
    payload: ProtocolPayload,
): payload is DeviceAuthorizationGrantProtocolPayload {
    return payload.protocol === "device_authorization_grant";
}

interface FailurePayload extends MSC4108Payload {
    type: PayloadType.Failure;
    reason: MSC4108FailureReason;
    homeserver?: string;
}

interface DeclinedPayload extends MSC4108Payload {
    type: PayloadType.Declined;
}

interface SuccessPayload extends MSC4108Payload {
    type: PayloadType.Success;
}

interface AcceptedPayload extends MSC4108Payload {
    type: PayloadType.ProtocolAccepted;
}

interface SecretsPayload extends MSC4108Payload, Awaited<ReturnType<NonNullable<CryptoApi["exportSecretsBundle"]>>> {
    type: PayloadType.Secrets;
}

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * sign in with QR + OIDC flow.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4108SignInWithQR {
    private readonly ourIntent: QrCodeMode;
    private _code?: Uint8Array;
    private expectingNewDeviceId?: string;

    /**
     * Returns the check code for the secure channel or undefined if not generated yet.
     */
    public get checkCode(): string | undefined {
        return this.channel?.getCheckCode();
    }

    /**
     * @param channel - The secure channel used for communication
     * @param client - The Matrix client in used on the device already logged in
     * @param didScanCode - Whether this side of the channel scanned the QR code from the other party
     * @param onFailure - Callback for when the rendezvous fails
     */
    public constructor(
        private readonly channel: MSC4108SecureChannel,
        private readonly didScanCode: boolean,
        private readonly client?: MatrixClient,
        public onFailure?: RendezvousFailureListener,
    ) {
        this.ourIntent = client ? QrCodeMode.Reciprocate : QrCodeMode.Login;
    }

    /**
     * Returns the code representing the rendezvous suitable for rendering in a QR code or undefined if not generated yet.
     */
    public get code(): Uint8Array | undefined {
        return this._code;
    }

    /**
     * Generate the code including doing partial set up of the channel where required.
     */
    public async generateCode(): Promise<void> {
        if (this._code) {
            return;
        }

        if (this.ourIntent === QrCodeMode.Reciprocate && this.client) {
            this._code = await this.channel.generateCode(this.ourIntent, this.client.getDomain()!);
        } else if (this.ourIntent === QrCodeMode.Login) {
            this._code = await this.channel.generateCode(this.ourIntent);
        }
    }

    /**
     * Returns true if the device is the already logged in device reciprocating a new login on the other side of the channel.
     */
    public get isExistingDevice(): boolean {
        return this.ourIntent === QrCodeMode.Reciprocate;
    }

    /**
     * Returns true if the device is the new device logging in being reciprocated by the device on the other side of the channel.
     */
    public get isNewDevice(): boolean {
        return !this.isExistingDevice;
    }

    /**
     * The first step in the OIDC QR login process.
     * To be called after the QR code has been rendered or scanned.
     * The scanning device has to discover the homeserver details, if they scanned the code then they already have it.
     * If the new device is the one rendering the QR code then it has to wait be sent the homeserver details via the rendezvous channel.
     */
    public async negotiateProtocols(): Promise<{ serverName?: string }> {
        logger.info(`negotiateProtocols(isNewDevice=${this.isNewDevice} didScanCode=${this.didScanCode})`);
        await this.channel.connect();

        if (this.didScanCode) {
            // Secure Channel step 6 completed, we trust the channel

            if (this.isNewDevice) {
                // MSC4108-Flow: ExistingScanned - take homeserver from QR code which should already be set
            } else {
                // MSC4108-Flow: NewScanned -send protocols message
                let oidcClientConfig: OidcClientConfig | undefined;
                try {
                    const { issuer } = await this.client!.getAuthIssuer();
                    oidcClientConfig = await discoverAndValidateOIDCIssuerWellKnown(issuer);
                } catch (e) {
                    logger.error("Failed to discover OIDC metadata", e);
                }

                if (oidcClientConfig?.metadata.grant_types_supported.includes(DEVICE_CODE_SCOPE)) {
                    await this.send<ProtocolsPayload>({
                        type: PayloadType.Protocols,
                        protocols: ["device_authorization_grant"],
                        homeserver: this.client!.getDomain()!,
                    });
                } else {
                    await this.send<FailurePayload>({
                        type: PayloadType.Failure,
                        reason: MSC4108FailureReason.UnsupportedProtocol,
                    });
                    throw new RendezvousError(
                        "Device code grant unsupported",
                        MSC4108FailureReason.UnsupportedProtocol,
                    );
                }
            }
        } else if (this.isNewDevice) {
            // MSC4108-Flow: ExistingScanned - wait for protocols message
            logger.info("Waiting for protocols message");
            const payload = await this.receive<ProtocolsPayload>();

            if (payload?.type === PayloadType.Failure) {
                throw new RendezvousError("Failed", payload.reason);
            }

            if (payload?.type !== PayloadType.Protocols) {
                await this.send<FailurePayload>({
                    type: PayloadType.Failure,
                    reason: MSC4108FailureReason.UnexpectedMessageReceived,
                });
                throw new RendezvousError(
                    "Unexpected message received",
                    MSC4108FailureReason.UnexpectedMessageReceived,
                );
            }

            return { serverName: payload.homeserver };
        } else {
            // MSC4108-Flow: NewScanned - nothing to do
        }
        return {};
    }

    /**
     * The second & third step in the OIDC QR login process.
     * To be called after `negotiateProtocols` for the existing device.
     * To be called after OIDC negotiation for the new device. (Currently unsupported)
     */
    public async deviceAuthorizationGrant(): Promise<{
        verificationUri?: string;
        userCode?: string;
    }> {
        if (this.isNewDevice) {
            throw new Error("New device flows around OIDC are not yet implemented");
        } else {
            // The user needs to do step 7 for the out-of-band confirmation
            // but, first we receive the protocol chosen by the other device so that
            // the confirmation_uri is ready to go
            logger.info("Waiting for protocol message");
            const payload = await this.receive<ProtocolPayload | DeviceAuthorizationGrantProtocolPayload>();

            if (payload?.type === PayloadType.Failure) {
                throw new RendezvousError("Failed", payload.reason);
            }

            if (payload?.type !== PayloadType.Protocol) {
                await this.send<FailurePayload>({
                    type: PayloadType.Failure,
                    reason: MSC4108FailureReason.UnexpectedMessageReceived,
                });
                throw new RendezvousError(
                    "Unexpected message received",
                    MSC4108FailureReason.UnexpectedMessageReceived,
                );
            }

            if (isDeviceAuthorizationGrantProtocolPayload(payload)) {
                const { device_authorization_grant: dag, device_id: expectingNewDeviceId } = payload;
                const { verification_uri: verificationUri, verification_uri_complete: verificationUriComplete } = dag;

                let deviceAlreadyExists = true;
                try {
                    await this.client?.getDevice(expectingNewDeviceId);
                } catch (err: MatrixError | unknown) {
                    if (err instanceof MatrixError && err.httpStatus === 404) {
                        deviceAlreadyExists = false;
                    }
                }

                if (deviceAlreadyExists) {
                    await this.send<FailurePayload>({
                        type: PayloadType.Failure,
                        reason: MSC4108FailureReason.DeviceAlreadyExists,
                    });
                    throw new RendezvousError(
                        "Specified device ID already exists",
                        MSC4108FailureReason.DeviceAlreadyExists,
                    );
                }

                this.expectingNewDeviceId = expectingNewDeviceId;

                return { verificationUri: verificationUriComplete ?? verificationUri };
            }

            await this.send<FailurePayload>({
                type: PayloadType.Failure,
                reason: MSC4108FailureReason.UnsupportedProtocol,
            });
            throw new RendezvousError(
                "Received a request for an unsupported protocol",
                MSC4108FailureReason.UnsupportedProtocol,
            );
        }
    }

    /**
     * The fifth (and final) step in the OIDC QR login process.
     * To be called after the new device has completed authentication.
     */
    public async shareSecrets(): Promise<{ secrets?: Omit<SecretsPayload, "type"> }> {
        if (this.isNewDevice) {
            await this.send<SuccessPayload>({
                type: PayloadType.Success,
            });
            // then wait for secrets
            logger.info("Waiting for secrets message");
            const payload = await this.receive<SecretsPayload>();
            if (payload?.type === PayloadType.Failure) {
                throw new RendezvousError("Failed", payload.reason);
            }

            if (payload?.type !== PayloadType.Secrets) {
                await this.send<FailurePayload>({
                    type: PayloadType.Failure,
                    reason: MSC4108FailureReason.UnexpectedMessageReceived,
                });
                throw new RendezvousError(
                    "Unexpected message received",
                    MSC4108FailureReason.UnexpectedMessageReceived,
                );
            }
            return { secrets: payload };
            // then done?
        } else {
            if (!this.expectingNewDeviceId) {
                throw new Error("No new device ID expected");
            }
            await this.send<AcceptedPayload>({
                type: PayloadType.ProtocolAccepted,
            });

            logger.info("Waiting for outcome message");
            const payload = await this.receive<SuccessPayload | DeclinedPayload>();

            if (payload?.type === PayloadType.Failure) {
                throw new RendezvousError("Failed", payload.reason);
            }

            if (payload?.type === PayloadType.Declined) {
                throw new RendezvousError("User declined", ClientRendezvousFailureReason.UserDeclined);
            }

            if (payload?.type !== PayloadType.Success) {
                await this.send<FailurePayload>({
                    type: PayloadType.Failure,
                    reason: MSC4108FailureReason.UnexpectedMessageReceived,
                });
                throw new RendezvousError("Unexpected message", MSC4108FailureReason.UnexpectedMessageReceived);
            }

            const timeout = Date.now() + 10000; // wait up to 10 seconds
            do {
                // is the device visible via the Homeserver?
                try {
                    const device = await this.client?.getDevice(this.expectingNewDeviceId);

                    if (device) {
                        // if so, return the secrets
                        const secretsBundle = await this.client!.getCrypto()!.exportSecretsBundle!();
                        if (this.channel.cancelled) {
                            throw new RendezvousError("User cancelled", MSC4108FailureReason.UserCancelled);
                        }
                        // send secrets
                        await this.send<SecretsPayload>({
                            type: PayloadType.Secrets,
                            ...secretsBundle,
                        });
                        return { secrets: secretsBundle };
                        // let the other side close the rendezvous session
                    }
                } catch (err: MatrixError | unknown) {
                    if (err instanceof MatrixError && err.httpStatus === 404) {
                        // not found, so keep waiting until timeout
                    } else {
                        throw err;
                    }
                }
                await sleep(1000);
            } while (Date.now() < timeout);

            await this.send<FailurePayload>({
                type: PayloadType.Failure,
                reason: MSC4108FailureReason.DeviceNotFound,
            });
            throw new RendezvousError("New device not found", MSC4108FailureReason.DeviceNotFound);
        }
    }

    private async receive<T extends MSC4108Payload>(): Promise<T | FailurePayload | undefined> {
        return (await this.channel.secureReceive()) as T | undefined;
    }

    private async send<T extends MSC4108Payload>(payload: T): Promise<void> {
        await this.channel.secureSend(payload);
    }

    /**
     * Decline the login on the existing device.
     */
    public async declineLoginOnExistingDevice(): Promise<void> {
        if (!this.isExistingDevice) {
            throw new Error("Can only decline login on existing device");
        }
        await this.send<FailurePayload>({
            type: PayloadType.Failure,
            reason: MSC4108FailureReason.UserCancelled,
        });
    }

    /**
     * Cancels the rendezvous session.
     * @param reason the reason for the cancellation
     */
    public async cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void> {
        this.onFailure?.(reason);
        await this.channel.cancel(reason);
    }

    /**
     * Closes the rendezvous session.
     */
    public async close(): Promise<void> {
        await this.channel.close();
    }
}
