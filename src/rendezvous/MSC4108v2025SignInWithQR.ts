/*
Copyright 2024 The Matrix.org Foundation C.I.C.
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

import { QrCodeIntent } from "@matrix-org/matrix-sdk-crypto-wasm";

// import directly rather than via ./index.ts to avoid a circular import: KNOWN_FAILURE_REASONS below is evaluated
// at module load time and needs the enum to already be defined.
import {
    ClientRendezvousFailureReason,
    MSC4108FailureReason,
    type RendezvousFailureListener,
} from "./RendezvousFailureReason.ts";
import { RendezvousError } from "./RendezvousError.ts";
import { type MatrixClient } from "../client.ts";
import { logger } from "../logger.ts";
import { MatrixError } from "../http-api/index.ts";
import { sleep } from "../utils.ts";
import {
    OAuthGrantType,
    type ValidatedAuthMetadata,
    generateScope,
    startDeviceAuthorization,
    waitForDeviceAuthorization,
    type DeviceAccessTokenResponse,
    type DeviceAuthorizationResponse,
} from "../oauth/index.ts";
import { type CryptoApi } from "../crypto-api/index.ts";
import { type SignInWithQR } from "./SignInWithQR.ts";
import { type MSC4388SecureChannel } from "./channels/MSC4388SecureChannel.ts";

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
export interface MSC4108v2025Payload {
    type: PayloadType;
}

interface ProtocolsPayload extends MSC4108v2025Payload {
    type: PayloadType.Protocols;
    protocols: string[];
    base_url: string;
}

interface ProtocolPayload extends MSC4108v2025Payload {
    type: PayloadType.Protocol;
    protocol: string;
    device_id: string;
}

interface DeviceAuthorizationGrantProtocolPayload extends ProtocolPayload {
    protocol: "device_authorization_grant";
    verification_uri: string;
    verification_uri_complete?: string;
}

function isDeviceAuthorizationGrantProtocolPayload(
    payload: ProtocolPayload,
): payload is DeviceAuthorizationGrantProtocolPayload {
    return payload.protocol === "device_authorization_grant";
}

interface FailurePayload extends MSC4108v2025Payload {
    type: PayloadType.Failure;
    reason: MSC4108FailureReason;
    homeserver?: string;
}

const KNOWN_FAILURE_REASONS = new Set<string>(Object.values(MSC4108FailureReason));

/**
 * Converts a received `m.login.failure` message into an error to throw.
 *
 * MSC4108 requires that an unrecognised `reason` is handled generically rather than rejected, so anything that isn't
 * a known {@link MSC4108FailureReason} is mapped to {@link ClientRendezvousFailureReason.Unknown}.
 */
function errorFromFailurePayload(payload: Partial<FailurePayload>): RendezvousError {
    const reason: unknown = payload.reason;
    if (typeof reason === "string" && KNOWN_FAILURE_REASONS.has(reason)) {
        return new RendezvousError("Failed", reason as MSC4108FailureReason);
    }
    logger.warn(`Received m.login.failure with unrecognised reason: ${JSON.stringify(reason)}`);
    return new RendezvousError(`Failed with unrecognised reason ${reason}`, ClientRendezvousFailureReason.Unknown);
}

interface DeclinedPayload extends MSC4108v2025Payload {
    type: PayloadType.Declined;
}

interface SuccessPayload extends MSC4108v2025Payload {
    type: PayloadType.Success;
}

interface AcceptedPayload extends MSC4108v2025Payload {
    type: PayloadType.ProtocolAccepted;
}

interface SecretsPayload
    extends MSC4108v2025Payload, Awaited<ReturnType<NonNullable<CryptoApi["exportSecretsBundle"]>>> {
    type: PayloadType.Secrets;
}

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * sign in with QR + OIDC flow.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4108v2025SignInWithQR implements SignInWithQR {
    private _code?: Uint8Array;
    private expectingNewDeviceId?: string;
    private metadata?: ValidatedAuthMetadata;
    private grantInProgress?: DeviceAuthorizationResponse;

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
        private readonly channel: MSC4388SecureChannel,
        private readonly didScanCode: boolean,
        private readonly client?: MatrixClient,
        public onFailure?: RendezvousFailureListener,
    ) {}

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
        this._code = await this.channel.generateCode();
    }

    /**
     * Returns true if the device is the already logged in device reciprocating a new login on the other side of the channel.
     */
    public get isExistingDevice(): boolean {
        return this.channel.intent === QrCodeIntent.Reciprocate;
    }

    /**
     * Returns true if the device is the new device logging in being reciprocated by the device on the other side of the channel.
     */
    public get isNewDevice(): boolean {
        return !this.isExistingDevice;
    }

    /**
     * Sends the `m.login.protocols` message from the existing device to the new device.
     *
     * Per MSC4108 this is always the first message sent over the secure channel, regardless of which device
     * generated the QR code, and it must only be sent once the existing device trusts the channel.
     */
    private async sendProtocols(): Promise<void> {
        let oidcClientConfig: ValidatedAuthMetadata | undefined;
        try {
            oidcClientConfig = await this.client!.getAuthMetadata();
        } catch (e) {
            logger.error("Failed to discover OIDC metadata", e);
        }

        if (oidcClientConfig?.grant_types_supported.includes(OAuthGrantType.DeviceAuthorization)) {
            logger.info("Sending protocols message");
            await this.send<ProtocolsPayload>({
                type: PayloadType.Protocols,
                protocols: ["device_authorization_grant"],
                base_url: this.client!.baseUrl,
            });
        } else {
            await this.send<FailurePayload>({
                type: PayloadType.Failure,
                reason: MSC4108FailureReason.UnsupportedProtocol,
            });
            throw new RendezvousError("Device code grant unsupported", MSC4108FailureReason.UnsupportedProtocol);
        }
    }

    /**
     * The first step in the OIDC QR login process.
     * To be called after the QR code has been rendered or scanned.
     *
     * The new device always waits to be sent the homeserver details and available protocols via the secure channel,
     * even if it scanned the QR code and so already knows the base URL of the rendezvous server.
     *
     * The existing device sends the homeserver details and available protocols as soon as it trusts the channel:
     * immediately if it scanned the QR code, otherwise (if it generated the QR code) only after the user has
     * confirmed the check code, which happens in {@link deviceAuthorizationGrant}.
     */
    public async negotiateProtocols(): Promise<{ baseUrl?: string }> {
        logger.info(`negotiateProtocols(isNewDevice=${this.isNewDevice} didScanCode=${this.didScanCode})`);
        await this.channel.connect();

        if (this.isNewDevice) {
            // MSC4108-Flow: the new device must wait for the protocols message regardless of who generated the QR
            logger.info("Waiting for protocols message");
            const payload = await this.receive<ProtocolsPayload>();

            if (payload?.type === PayloadType.Failure) {
                throw errorFromFailurePayload(payload);
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

            // MSC4108 step 2: pick a protocol that we support from those offered, ignoring any we don't recognise.
            // If none are supported then we must fail with unsupported_protocol.
            if (!Array.isArray(payload.protocols) || !payload.protocols.includes("device_authorization_grant")) {
                await this.send<FailurePayload>({
                    type: PayloadType.Failure,
                    reason: MSC4108FailureReason.UnsupportedProtocol,
                });
                throw new RendezvousError(
                    "No supported protocol offered by existing device",
                    MSC4108FailureReason.UnsupportedProtocol,
                );
            }

            return { baseUrl: payload.base_url };
        }

        if (this.didScanCode) {
            // MSC4388 step 6 completed by scanning the QR: we trust the channel and can send protocols now
            await this.sendProtocols();
        } else {
            // MSC4108-Flow: we generated the QR so we don't yet trust the channel. The user must first enter the
            // check code (MSC4388 step 7) after which the caller invokes deviceAuthorizationGrant() which sends
            // the protocols message.
        }
        return {};
    }

    /**
     * The second & third step in the OIDC QR login process.
     *
     * For the existing device: to be called after `negotiateProtocols`. If the existing device generated the QR code
     * then this must only be called once the user has entered the correct check code (MSC4388 step 7), as this is
     * the point at which the existing device trusts the channel and sends the `m.login.protocols` message.
     *
     * For the new device: to be called after receiving the homeserver details from `negotiateProtocols` and doing
     * the OIDC metadata discovery and client registration.
     */
    public async deviceAuthorizationGrant(input?: {
        metadata: ValidatedAuthMetadata;
        clientId: string;
        deviceId: string;
    }): Promise<{
        verificationUri?: string;
        userCode?: string;
    }> {
        if (this.isNewDevice) {
            if (!input) {
                throw new Error("Input must be provided for new device");
            }

            const { metadata, clientId, deviceId } = input;

            const scope = generateScope(deviceId);

            // MSC4108-Flow: NewDevice - start device authorization grant
            const dagResponse = await startDeviceAuthorization({
                clientId,
                scope,
                metadata,
            });

            this.metadata = metadata;
            this.grantInProgress = dagResponse;

            const protocol: DeviceAuthorizationGrantProtocolPayload = {
                type: PayloadType.Protocol,
                protocol: "device_authorization_grant",
                device_id: deviceId,
                verification_uri: dagResponse.verification_uri,
                verification_uri_complete: dagResponse.verification_uri_complete,
            };

            await this.send(protocol);

            return {
                verificationUri: dagResponse.verification_uri_complete ?? dagResponse.verification_uri,
                userCode: dagResponse.user_code,
            };
        } else {
            if (!this.didScanCode) {
                // We generated the QR code so the user has now confirmed the check code (MSC4388 step 7) and we
                // trust the channel and can send the protocols message. If we scanned the QR code then this was
                // already sent in negotiateProtocols().
                await this.sendProtocols();
            }

            // Then we receive the protocol chosen by the other device so that the verification_uri is ready to go
            logger.info("Waiting for protocol message");
            const payload = await this.receive<ProtocolPayload | DeviceAuthorizationGrantProtocolPayload>();

            if (payload?.type === PayloadType.Failure) {
                throw errorFromFailurePayload(payload);
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
                const {
                    device_id: expectingNewDeviceId,
                    verification_uri: verificationUri,
                    verification_uri_complete: verificationUriComplete,
                } = payload;

                // MSC4108 step 4: assert that no device with this ID exists yet by expecting a 404
                let deviceAlreadyExists = true;
                try {
                    await this.client!.getDevice(expectingNewDeviceId);
                } catch (err: MatrixError | unknown) {
                    if (err instanceof MatrixError && err.httpStatus === 404) {
                        deviceAlreadyExists = false;
                    } else {
                        // we don't know either way, so don't blame the new device for it
                        throw err;
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

    public async completeLoginOnNewDevice({
        clientId,
    }: {
        clientId: string;
    }): Promise<DeviceAccessTokenResponse | undefined> {
        if (!this.isNewDevice || !this.grantInProgress || !this.metadata) {
            throw new Error("Can only complete login on new device");
        }

        logger.info("Waiting for protocol accepted message");
        // wait for accepted message
        const payload = await this.receive<AcceptedPayload | FailurePayload>();

        if (!payload) {
            throw new RendezvousError(
                "No response from existing device",
                MSC4108FailureReason.UnexpectedMessageReceived,
            );
        }
        if (payload.type === PayloadType.Failure) {
            throw errorFromFailurePayload(payload);
        }
        if (payload.type !== PayloadType.ProtocolAccepted) {
            throw new RendezvousError("Unexpected message received", MSC4108FailureReason.UnexpectedMessageReceived);
        }

        // poll for DAG
        const res = await waitForDeviceAuthorization({
            session: this.grantInProgress,
            metadata: this.metadata,
            clientId,
        });

        if (!res) {
            throw new RendezvousError(
                "No response from device authorization endpoint",
                ClientRendezvousFailureReason.Unknown,
            );
        }

        if ("error" in res) {
            if (res.error === "access_denied") {
                // MSC4108: the user declined the grant on the existing device
                await this.send<DeclinedPayload>({ type: PayloadType.Declined });
                return undefined;
            }

            let reason: MSC4108FailureReason = MSC4108FailureReason.UnexpectedMessageReceived;
            if (res.error === "expired_token") {
                reason = MSC4108FailureReason.AuthorizationExpired;
            }
            await this.send<FailurePayload>({
                type: PayloadType.Failure,
                reason,
            });
            return undefined;
        }

        return res;
    }

    /**
     * The fifth (and final) step in the OIDC QR login process.
     * To be called after the new device has completed authentication.
     */
    public async shareSecrets(): Promise<{
        secrets?: Omit<SecretsPayload, "type">;
    }> {
        if (this.isNewDevice) {
            await this.send<SuccessPayload>({
                type: PayloadType.Success,
            });
            // then wait for secrets
            logger.info("Waiting for secrets message");
            const payload = await this.receive<SecretsPayload>();
            if (payload?.type === PayloadType.Failure) {
                throw errorFromFailurePayload(payload);
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
            return {
                secrets: {
                    cross_signing: payload.cross_signing,
                    backup: payload.backup,
                },
            };
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
                throw errorFromFailurePayload(payload);
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

    private async receive<T extends MSC4108v2025Payload>(): Promise<T | FailurePayload | undefined> {
        return (await this.channel.secureReceive()) as T | undefined;
    }

    private async send<T extends MSC4108v2025Payload>(payload: T): Promise<void> {
        await this.channel.secureSend(payload);
    }

    /**
     * Decline the login on the existing device.
     * @param reason why the login is being declined: `user_cancelled` (the default) if the user declined, or
     * `unable_to_open_verification_uri` if the verification URI could not be opened.
     */
    public async declineLoginOnExistingDevice(
        reason:
            | MSC4108FailureReason.UserCancelled
            | MSC4108FailureReason.UnableToOpenVerificationUri = MSC4108FailureReason.UserCancelled,
    ): Promise<void> {
        if (!this.isExistingDevice) {
            throw new Error("Can only decline login on existing device");
        }
        await this.send<FailurePayload>({
            type: PayloadType.Failure,
            reason,
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
