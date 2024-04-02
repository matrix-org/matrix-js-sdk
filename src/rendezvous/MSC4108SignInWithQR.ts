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

import { DeviceAccessTokenResponse, DeviceAuthorizationResponse, OidcClient } from "oidc-client-ts";
import { QrCodeMode } from "@matrix-org/matrix-sdk-crypto-wasm";

import { RendezvousError, RendezvousFailureListener, RendezvousFailureReason } from ".";
import { MatrixClient } from "../client";
import { logger } from "../logger";
import { MSC4108SecureChannel } from "./channels/MSC4108SecureChannel";
import { QRSecretsBundle } from "../crypto-api";
import { MatrixError } from "../http-api";

export enum PayloadType {
    Protocols = "m.login.protocols",
    Protocol = "m.login.protocol",
    Failure = "m.login.failure",
    Success = "m.login.success",
    Secrets = "m.login.secrets",
    ProtocolAccepted = "m.login.protocol_accepted",
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
    device_id: string;
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
}

interface AcceptedPayload extends MSC4108Payload {
    type: PayloadType.ProtocolAccepted;
}

interface SecretsPayload extends MSC4108Payload, QRSecretsBundle {
    type: PayloadType.Secrets;
}

// PROTOTYPE: this should probably sit in a wrapper around OidcClient or be accesible through some other means
function getDeviceId(oidcClient: OidcClient): string | undefined {
    return oidcClient.settings.scope
        .split(" ")
        .find((s) => s.startsWith("urn:matrix:org.matrix.msc2967.client:device:"))
        ?.replace("urn:matrix:org.matrix.msc2967.client:device:", "");
}

export class MSC4108SignInWithQR {
    private ourIntent: QrCodeMode;
    private _code?: Uint8Array;
    public protocol?: string;
    private oidcClient?: OidcClient;
    private deviceAuthorizationResponse?: DeviceAuthorizationResponse;
    private expectingNewDeviceId?: string;

    // PROTOTYPE: this is mocked for now
    public checkCode: string | undefined = "99";

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

        this._code = await this.channel.generateCode(this.ourIntent, this.client?.getHomeserverUrl());
    }

    public get isExistingDevice(): boolean {
        return this.ourIntent === QrCodeMode.Reciprocate;
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
                // MSC4108-Flow: ExistingScanned
                // take homeserver from QR code which should already be set
            } else {
                // MSC4108-Flow: NewScanned
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
                // MSC4108-Flow: ExistingScanned
                // wait for protocols message
                logger.info("Waiting for protocols message");
                const message = await this.receive();
                if (message?.type !== PayloadType.Protocols) {
                    throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
                }
                const protocolsMessage = message as ProtocolsPayload;
                return { homeserverBaseUrl: protocolsMessage.homeserver };
            } else {
                // MSC4108-Flow: NewScanned
                // nothing to do
            }
        }
        return {};
    }

    public async loginStep2And3(oidcClient?: OidcClient): Promise<{
        verificationUri?: string;
        userCode?: string;
    }> {
        logger.info("loginStep2And3()");
        if (this.isNewDevice) {
            if (!oidcClient) {
                throw new Error("No oidc client");
            }
            this.oidcClient = oidcClient;

            const deviceIdFromScope = getDeviceId(oidcClient);

            if (!deviceIdFromScope) {
                throw new Error("No device ID set in oidc client scope");
            }
            // start device grant
            this.deviceAuthorizationResponse = await oidcClient.startDeviceAuthorization({});

            const { user_code: userCode } = this.deviceAuthorizationResponse;
            if (this.didScanCode) {
                // MSC4108-Flow: NewScanned
                // send immediately
                const { verification_uri: verificationUri, verification_uri_complete: verificationUriComplete } =
                    this.deviceAuthorizationResponse;
                const protocol: DeviceAuthorizationGrantProtocolPayload = {
                    type: PayloadType.Protocol,
                    protocol: "device_authorization_grant",
                    device_authorization_grant: {
                        verification_uri: verificationUri,
                        verification_uri_complete: verificationUriComplete,
                    },
                    device_id: deviceIdFromScope,
                };
                await this.send(protocol);
            } else {
                // MSC4108-Flow: ExistingScanned
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
                    const { device_authorization_grant: dag, device_id: expectingNewDeviceId } =
                        protocolMessage as DeviceAuthorizationGrantProtocolPayload;
                    const { verification_uri: verificationUri, verification_uri_complete: verificationUriComplete } =
                        dag;

                    // PROTOTYPE: this is an implementation of option 3c for when to share the secrets:
                    // check if there is already a device online with that device ID

                    let deviceAlreadyExists = true;
                    try {
                        await this.client?.getDevice(expectingNewDeviceId);
                    } catch (err: MatrixError | unknown) {
                        if (err instanceof MatrixError && err.httpStatus === 404) {
                            deviceAlreadyExists = false;
                        }
                    }

                    if (deviceAlreadyExists) {
                        throw new RendezvousError(
                            "Specified device ID already exists",
                            RendezvousFailureReason.DataMismatch,
                        );
                    }

                    this.expectingNewDeviceId = expectingNewDeviceId;

                    return { verificationUri: verificationUriComplete ?? verificationUri };
                }
            }

            throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnsupportedAlgorithm);
        }
    }

    public async loginStep4a(): Promise<void> {
        if (this.isExistingDevice) {
            throw new Error("loginStep4a() is not valid for existing devices");
        }

        logger.info("loginStep4a()");

        if (this.didScanCode) {
            // MSC4108-Flow: NewScanned
            // we already sent the protocol message
        } else {
            // MSC4108-Flow: ExistingScanned
            // send it now
            if (!this.oidcClient) {
                throw new Error("No oidc client");
            }
            if (!this.deviceAuthorizationResponse) {
                throw new Error("No device authorization response");
            }
            const deviceIdFromScope = getDeviceId(this.oidcClient);
            if (!deviceIdFromScope) {
                throw new Error("No device ID set in oidc client scope");
            }
            const protocol: DeviceAuthorizationGrantProtocolPayload = {
                type: PayloadType.Protocol,
                protocol: "device_authorization_grant",
                device_authorization_grant: {
                    verification_uri: this.deviceAuthorizationResponse.verification_uri,
                    verification_uri_complete: this.deviceAuthorizationResponse.verification_uri_complete,
                },
                device_id: deviceIdFromScope,
            };
            await this.send(protocol);
        }

        // wait for accepted message
        const message = await this.receive();

        if (message?.type === PayloadType.Failure) {
            throw new RendezvousError("Failed", (message as FailurePayload).reason);
        }
        if (message?.type !== PayloadType.ProtocolAccepted) {
            throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
        }
    }

    public async loginStep4b(): Promise<DeviceAccessTokenResponse> {
        if (this.isExistingDevice) {
            throw new Error("loginStep4b() is not valid for existing devices");
        }

        logger.info("loginStep4b()");
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

    public async loginStep5(): Promise<{ secrets?: QRSecretsBundle }> {
        logger.info("loginStep5()");

        if (this.isNewDevice) {
            const payload: SuccessPayload = {
                type: PayloadType.Success,
            };
            await this.send(payload);
            // then wait for secrets
            logger.info("Waiting for secrets message");
            const secrets = await this.receive<SecretsPayload>();
            if (secrets?.type !== PayloadType.Secrets) {
                throw new RendezvousError("Unexpected message received", RendezvousFailureReason.UnexpectedMessage);
            }
            return { secrets };
            // then done?
        } else {
            if (!this.expectingNewDeviceId) {
                throw new Error("No new device ID expected");
            }
            const payload: AcceptedPayload = {
                type: PayloadType.ProtocolAccepted,
            };
            await this.send(payload);

            logger.info("Waiting for outcome message");
            const res = await this.receive();

            if (res?.type === PayloadType.Failure) {
                const { reason } = res as FailurePayload;
                throw new RendezvousError("Failed", reason);
            }

            if (res?.type !== PayloadType.Success) {
                throw new RendezvousError("Unexpected message", RendezvousFailureReason.UnexpectedMessage);
            }

            // PROTOTYPE: this is an implementation of option 3c for when to share the secrets:
            const device = await this.client?.getDevice(this.expectingNewDeviceId);

            if (!device) {
                throw new RendezvousError("New device not found", RendezvousFailureReason.DataMismatch);
            }

            const secretsBundle = await this.client!.getCrypto()!.exportSecretsForQRLogin();
            // send secrets
            await this.send({
                type: PayloadType.Secrets,
                ...secretsBundle,
            });
            return {};
            // done?
            // let the other side close the rendezvous session
        }
    }

    private async receive<T extends MSC4108Payload>(): Promise<T | undefined> {
        return (await this.channel.secureReceive()) as T | undefined;
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
