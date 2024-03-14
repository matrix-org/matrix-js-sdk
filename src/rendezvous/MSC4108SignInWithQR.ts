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

import { DeviceAuthorizationResponse, OidcClient, DeviceAccessTokenResponse } from "oidc-client-ts";

import { RendezvousError, RendezvousFailureListener, RendezvousFailureReason, RendezvousIntent } from ".";
import { MatrixClient } from "../client";
import { logger } from "../logger";
import { MSC4108SecureChannel } from "./channels/MSC4108SecureChannel";
import { QRSecretsBundle } from "../crypto-api";

export enum PayloadType {
    Protocols = "m.login.protocols",
    Protocol = "m.login.protocol",
    Failure = "m.login.failure",
    Success = "m.login.success",
    Secrets = "m.login.secrets",
    Accepted = "m.login.accepted",
}

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
    protocol: string;
}

interface DeviceAuthorizationGrantProtocolPayload extends ProtocolPayload {
    protocol: "device_authorization_grant";
    device_authorization_grant: {
        verification_uri: string;
        verification_uri_complete?: string;
    };
}

interface FailurePayload extends MSC4108Payload {
    type: PayloadType.Failure;
    reason: RendezvousFailureReason;
    homeserver?: string;
}

interface SuccessPayload extends MSC4108Payload {
    type: PayloadType.Success;
    device_id: string;
}

interface AcceptedPayload extends MSC4108Payload {
    type: PayloadType.Accepted;
}

interface SecretsPayload extends MSC4108Payload {
    type: PayloadType.Secrets;
    cross_signing?: {
        master_key: string;
        self_signing_key: string;
        user_signing_key: string;
    };
    backup?: {
        algorithm: string;
        key: string;
        backup_version: string;
    };
}

export class MSC4108SignInWithQR {
    private ourIntent: RendezvousIntent;
    private _code?: Buffer;
    public protocol?: string;
    private oidcClient?: OidcClient;
    private deviceAuthorizationResponse?: DeviceAuthorizationResponse;

    /**
     * @param channel - The secure channel used for communication
     * @param client - The Matrix client in used on the device already logged in
     * @param onFailure - Callback for when the rendezvous fails
     */
    public constructor(
        private channel: MSC4108SecureChannel,
        private didScanCode: boolean,
        private client?: MatrixClient,
        public onFailure?: RendezvousFailureListener,
    ) {
        this.ourIntent = client
            ? RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE
            : RendezvousIntent.LOGIN_ON_NEW_DEVICE;
    }

    /**
     * Returns the code representing the rendezvous suitable for rendering in a QR code or undefined if not generated yet.
     */
    public get code(): Buffer | undefined {
        return this._code;
    }

    /**
     * Generate the code including doing partial set up of the channel where required.
     */
    public async generateCode(): Promise<void> {
        if (this._code) {
            return;
        }

        this._code = await this.channel.generateCode(this.ourIntent, this.client?.getHomeserverUrl());
    }

    public get isExistingDevice(): boolean {
        return this.ourIntent === RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE;
    }

    public get isNewDevice(): boolean {
        return !this.isExistingDevice;
    }

    public async loginStep1(): Promise<{ homeserverBaseUrl?: string }> {
        logger.info(`loginStep1(isNewDevice=${this.isNewDevice} didScanCode=${this.didScanCode})`);
        await this.channel.connect();

        if (this.didScanCode) {
            // Secure Channel step 6 completed, we trust the channel

            if (this.isNewDevice) {
                // take homeserver from QR code which should already be set
            } else {
                // send protocols message
                // PROTOTYPE: we should be checking that the advertised protocol is available
                const protocols: ProtocolsPayload = {
                    type: PayloadType.Protocols,
                    protocols: ["device_authorization_grant"],
                    homeserver: this.client?.getHomeserverUrl() ?? "",
                };
                await this.send(protocols);
            }
        } else {
            if (this.isNewDevice) {
                // wait for protocols message
                logger.info("Waiting for protocols message");
                const message = await this.receive();
                if (message?.type !== PayloadType.Protocols) {
                    throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
                }
                const protocolsMessage = message as ProtocolsPayload;
                return { homeserverBaseUrl: protocolsMessage.homeserver };
            } else {
                // nothing to do
            }
        }
        return {};
    }

    public async loginStep2(oidcClient: OidcClient): Promise<void> {
        if (this.isExistingDevice) {
            throw new Error("loginStep2OnNewDevice() is not valid for existing devices");
        }
        logger.info("loginStep2()");

        this.oidcClient = oidcClient;
        // do device grant
        this.deviceAuthorizationResponse = await oidcClient.startDeviceAuthorization({});
    }

    public async loginStep3(): Promise<{
        verificationUri?: string;
        userCode?: string;
    }> {
        if (this.isNewDevice) {
            if (!this.deviceAuthorizationResponse) {
                throw new Error("No device authorization response");
            }

            const {
                verification_uri: verificationUri,
                verification_uri_complete: verificationUriComplete,
                user_code: userCode,
            } = this.deviceAuthorizationResponse;
            // send mock for now, should be using values from step 2:
            const protocol: DeviceAuthorizationGrantProtocolPayload = {
                type: PayloadType.Protocol,
                protocol: "device_authorization_grant",
                device_authorization_grant: {
                    verification_uri: verificationUri,
                    verification_uri_complete: verificationUriComplete,
                },
            };
            if (this.didScanCode) {
                // send immediately
                await this.send(protocol);
            } else {
                // we will send it later
            }

            return { userCode: userCode };
        } else {
            // The user needs to do step 7 for the out of band confirmation
            // but, first we receive the protocol chosen by the other device so that
            // the confirmation_uri is ready to go
            logger.info("Waiting for protocol message");
            const message = await this.receive();

            if (message && message.type === PayloadType.Protocol) {
                const protocolMessage = message as ProtocolPayload;
                if (protocolMessage.protocol === "device_authorization_grant") {
                    const { device_authorization_grant: dag } =
                        protocolMessage as DeviceAuthorizationGrantProtocolPayload;
                    const { verification_uri: verificationUri, verification_uri_complete: verificationUriComplete } =
                        dag;
                    return { verificationUri: verificationUriComplete ?? verificationUri };
                }
            }

            throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnsupportedAlgorithm);
        }
    }

    public async loginStep4(): Promise<DeviceAccessTokenResponse> {
        if (this.isExistingDevice) {
            throw new Error("loginStep4() is not valid for existing devices");
        }

        logger.info("loginStep4()");

        if (this.didScanCode) {
            // we already sent the protocol message
        } else {
            // send it now
            if (!this.deviceAuthorizationResponse) {
                throw new Error("No device authorization response");
            }
            const protocol: DeviceAuthorizationGrantProtocolPayload = {
                type: PayloadType.Protocol,
                protocol: "device_authorization_grant",
                device_authorization_grant: {
                    verification_uri: this.deviceAuthorizationResponse.verification_uri,
                    verification_uri_complete: this.deviceAuthorizationResponse.verification_uri_complete,
                },
            };
            await this.send(protocol);
        }

        // wait for accepted message
        const message = await this.receive();

        if (message.type === PayloadType.Failure) {
            throw new RendezvousError("Failed", (message as FailurePayload).reason);
        }
        if (message.type !== PayloadType.Accepted) {
            throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
        }

        if (!this.deviceAuthorizationResponse) {
            throw new Error("No device authorization response");
        }
        if (!this.oidcClient) {
            throw new Error("No oidc client");
        }
        // poll for DAG
        const res = await this.oidcClient.waitForDeviceAuthorization(this.deviceAuthorizationResponse);

        if (!res) {
            throw new RendezvousError(
                "No response from device authorization endpoint",
                RendezvousFailureReason.UnexpectedMessage,
            );
        }

        if ("error" in res) {
            let reason = RendezvousFailureReason.Unknown;
            if (res.error === "expired_token") {
                reason = RendezvousFailureReason.Expired;
            } else if (res.error === "access_denied") {
                reason = RendezvousFailureReason.UserDeclined;
            }
            const payload: FailurePayload = {
                type: PayloadType.Failure,
                reason,
            };
            await this.send(payload);
        }

        return res as DeviceAccessTokenResponse;
    }

    public async loginStep5(deviceId?: string): Promise<{ secrets?: QRSecretsBundle }> {
        logger.info("loginStep5()");

        if (this.isNewDevice) {
            if (!deviceId) {
                throw new Error("No new device id");
            }
            const payload: SuccessPayload = {
                type: PayloadType.Success,
                device_id: deviceId,
            };
            await this.send(payload);
            // then wait for secrets
            logger.info("Waiting for secrets message");
            const secrets = (await this.receive()) as SecretsPayload;
            if (secrets.type !== PayloadType.Secrets) {
                throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
            }
            return { secrets };
            // then done?
        } else {
            const payload: AcceptedPayload = {
                type: PayloadType.Accepted,
            };
            await this.send(payload);

            logger.info("Waiting for outcome message");
            const res = await this.receive();

            if (res.type === PayloadType.Failure) {
                const { reason } = res as FailurePayload;
                throw new RendezvousError("Failed", reason);
            }

            if (res.type != PayloadType.Success) {
                throw new RendezvousError("Unexpected message", RendezvousFailureReason.UnexpectedMessage);
            }

            // PROTOTYPE: we should be validating that the device on the other end of the rendezvous did actually successfully authenticate as this device once we decide how that should be done
            // const { device_id: deviceId } = res as SuccessPayload;

            const availableSecrets = (await this.client?.getCrypto()?.exportSecretsForQRLogin()) ?? {};
            // send secrets
            const secrets: SecretsPayload = {
                type: PayloadType.Secrets,
                ...availableSecrets,
            };
            await this.send(secrets);
            return {};
            // done?
            // let the other side close the rendezvous session
        }
    }

    private async receive(): Promise<MSC4108Payload> {
        return (await this.channel.secureReceive()) as MSC4108Payload;
    }

    private async send(payload: MSC4108Payload): Promise<void> {
        await this.channel.secureSend(payload);
    }

    public async declineLoginOnExistingDevice(): Promise<void> {
        // logger.info("User declined sign in");
        const payload: FailurePayload = {
            type: PayloadType.Failure,
            reason: RendezvousFailureReason.UserDeclined,
        };
        await this.send(payload);
    }

    public async cancel(reason: RendezvousFailureReason): Promise<void> {
        this.onFailure?.(reason);
        await this.channel.cancel(reason);
    }

    public async close(): Promise<void> {
        await this.channel.close();
    }
}
