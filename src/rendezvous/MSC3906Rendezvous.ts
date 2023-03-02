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

import { UnstableValue } from "matrix-events-sdk";

import {
    RendezvousChannel,
    RendezvousFailureListener,
    RendezvousFailureReason,
    RendezvousFlow,
    RendezvousIntent,
    SETUP_ADDITIONAL_DEVICE_FLOW_V2,
} from ".";
import { MatrixClient } from "../client";
import { CrossSigningInfo } from "../crypto/CrossSigning";
import { DeviceInfo } from "../crypto/deviceinfo";
import { buildFeatureSupportMap, Feature, ServerSupport } from "../feature";
import { logger } from "../logger";
import { sleep } from "../utils";

enum PayloadType {
    /**
     * @deprecated Only used in MSC3906 v1
     */
    Finish = "m.login.finish",
    Progress = "m.login.progress",
    Protocol = "m.login.protocol",
    Protocols = "m.login.protocols",
    Approved = "m.login.approved",
    Success = "m.login.success",
    Verified = "m.login.verified",
    Failure = "m.login.failure",
    Declined = "m.login.declined",
}

/**
 * @deprecated Only used in MSC3906 v1
 */
enum Outcome {
    Success = "success",
    Failure = "failure",
    Verified = "verified",
    Declined = "declined",
    Unsupported = "unsupported",
}

enum FailureReason {
    Cancelled = "cancelled",
    Unsupported = "unsupported",
    E2EESecurityError = "e2ee_security_error",
    IncompatibleIntent = "incompatible_intent",
}

export interface MSC3906RendezvousPayload {
    type: PayloadType;
    intent?: RendezvousIntent;
    /**
     * @deprecated Only used in MSC3906 v1. Instead the type field should be used in future
     */
    outcome?: Outcome;
    reason?: FailureReason;
    device_id?: string;
    device_key?: string;
    verifying_device_id?: string;
    verifying_device_key?: string;
    master_key?: string;
    protocols?: string[];
    protocol?: string;
    login_token?: string;
    homeserver?: string;
}

const LOGIN_TOKEN_PROTOCOL = new UnstableValue("login_token", "org.matrix.msc3906.login_token");

/**
 * Implements MSC3906 to allow a user to sign in on a new device using QR code.
 * This implementation only supports generating a QR code on a device that is already signed in.
 * Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC3906Rendezvous {
    private newDeviceId?: string;
    private newDeviceKey?: string;
    private ourIntent: RendezvousIntent = RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE;
    private flow: RendezvousFlow = SETUP_ADDITIONAL_DEVICE_FLOW_V2.name;
    private v1FallbackEnabled: boolean;
    private _code?: string;

    /**
     * @param channel - The secure channel used for communication
     * @param client - The Matrix client in used on the device already logged in
     * @param onFailure - Callback for when the rendezvous fails
     * @param startInV1FallbackMode - Whether to start in v1 fallback mode
     */
    public constructor(
        private channel: RendezvousChannel<MSC3906RendezvousPayload>,
        private client: MatrixClient,
        public onFailure?: RendezvousFailureListener,
        startInV1FallbackMode = false,
    ) {
        this.v1FallbackEnabled = startInV1FallbackMode ?? false;
    }

    /**
     * Returns the code representing the rendezvous suitable for rendering in a QR code or undefined if not generated yet.
     */
    public get code(): string | undefined {
        return this._code;
    }

    /**
     * Generate the code including doing partial set up of the channel where required.
     */
    public async generateCode(): Promise<void> {
        if (this._code) {
            return;
        }

        const raw = this.v1FallbackEnabled
            ? await this.channel.generateCode(this.ourIntent)
            : await this.channel.generateCode(this.ourIntent, this.flow);
        this._code = JSON.stringify(raw);
    }

    public async startAfterShowingCode(): Promise<string | undefined> {
        const checksum = await this.channel.connect();

        logger.info(`Connected to secure channel with checksum: ${checksum} our intent is ${this.ourIntent}`);

        const features = await buildFeatureSupportMap(await this.client.getVersions());
        // determine available protocols
        if (features.get(Feature.LoginTokenRequest) === ServerSupport.Unsupported) {
            logger.info("Server doesn't support MSC3882");
            await this.send(
                this.v1FallbackEnabled
                    ? { type: PayloadType.Finish, outcome: Outcome.Unsupported }
                    : { type: PayloadType.Failure, reason: FailureReason.Unsupported },
            );
            await this.cancel(RendezvousFailureReason.HomeserverLacksSupport);
            return undefined;
        }

        await this.send({
            type: this.v1FallbackEnabled ? PayloadType.Progress : PayloadType.Protocols,
            protocols: [LOGIN_TOKEN_PROTOCOL.name],
        });

        logger.info("Waiting for other device to chose protocol");
        const { type, protocol, outcome, reason, intent } = await this.receive();

        // even if we didn't start in v1 fallback we might detect that the other device is v1
        if (type === PayloadType.Finish || type === PayloadType.Progress) {
            // this is a PDU from a v1 flow so use fallback mode
            this.v1FallbackEnabled = true;
        }

        // fallback for v1 flow
        if (type === PayloadType.Finish) {
            this.v1FallbackEnabled = true;
            // new device decided not to complete
            let reason: RendezvousFailureReason;
            if (intent) {
                reason =
                    this.ourIntent === RendezvousIntent.LOGIN_ON_NEW_DEVICE
                        ? RendezvousFailureReason.OtherDeviceNotSignedIn
                        : RendezvousFailureReason.OtherDeviceAlreadySignedIn;
            } else if (outcome === Outcome.Unsupported) {
                reason = RendezvousFailureReason.UnsupportedAlgorithm;
            } else {
                reason = RendezvousFailureReason.Unknown;
            }
            await this.cancel(reason);
            return undefined;
        }

        // v2 flow
        if (type === PayloadType.Failure) {
            // new device decided not to complete
            let failureReason: RendezvousFailureReason;
            switch (reason ?? "") {
                case FailureReason.Cancelled:
                    failureReason = RendezvousFailureReason.UserCancelled;
                    break;
                case FailureReason.IncompatibleIntent:
                    failureReason =
                        this.ourIntent === RendezvousIntent.LOGIN_ON_NEW_DEVICE
                            ? RendezvousFailureReason.OtherDeviceNotSignedIn
                            : RendezvousFailureReason.OtherDeviceAlreadySignedIn;
                    break;
                case FailureReason.Unsupported:
                    failureReason = RendezvousFailureReason.UnsupportedAlgorithm;
                    break;
                default:
                    failureReason = RendezvousFailureReason.Unknown;
            }
            await this.cancel(failureReason);
            return undefined;
        }

        // v1 unexpected payload
        if (this.v1FallbackEnabled && type !== PayloadType.Progress) {
            await this.cancel(RendezvousFailureReason.Unknown);
            return undefined;
        }

        // v2 unexpected payload
        if (!this.v1FallbackEnabled && type !== PayloadType.Protocol) {
            await this.cancel(RendezvousFailureReason.Unknown);
            return undefined;
        }

        // invalid protocol
        if (!protocol || !LOGIN_TOKEN_PROTOCOL.matches(protocol)) {
            await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
            return undefined;
        }

        return checksum;
    }

    private async receive(): Promise<MSC3906RendezvousPayload> {
        return (await this.channel.receive()) as MSC3906RendezvousPayload;
    }

    private async send(payload: MSC3906RendezvousPayload): Promise<void> {
        await this.channel.send(payload);
    }

    public async declineLoginOnExistingDevice(): Promise<void> {
        logger.info("User declined sign in");
        await this.send(
            this.v1FallbackEnabled
                ? { type: PayloadType.Finish, outcome: Outcome.Declined }
                : { type: PayloadType.Declined },
        );
    }

    public async approveLoginOnExistingDevice(loginToken: string): Promise<string | undefined> {
        await this.channel.send({
            type: this.v1FallbackEnabled ? PayloadType.Progress : PayloadType.Approved,
            login_token: loginToken,
            homeserver: this.client.baseUrl,
        });

        logger.info("Waiting for outcome");
        const res = await this.receive();
        if (!res) {
            return undefined;
        }
        const { type, outcome, device_id: deviceId, device_key: deviceKey } = res;

        if (
            (this.v1FallbackEnabled && outcome !== "success") ||
            (!this.v1FallbackEnabled && type !== PayloadType.Success)
        ) {
            throw new Error("Linking failed");
        }

        this.newDeviceId = deviceId;
        this.newDeviceKey = deviceKey;

        return deviceId;
    }

    private async verifyAndCrossSignDevice(deviceInfo: DeviceInfo): Promise<CrossSigningInfo | DeviceInfo> {
        if (!this.client.crypto) {
            throw new Error("Crypto not available on client");
        }

        if (!this.newDeviceId) {
            throw new Error("No new device ID set");
        }

        // check that keys received from the server for the new device match those received from the device itself
        if (deviceInfo.getFingerprint() !== this.newDeviceKey) {
            throw new Error(
                `New device has different keys than expected: ${this.newDeviceKey} vs ${deviceInfo.getFingerprint()}`,
            );
        }

        const userId = this.client.getUserId();

        if (!userId) {
            throw new Error("No user ID set");
        }
        // mark the device as verified locally + cross sign
        logger.info(`Marking device ${this.newDeviceId} as verified`);
        const info = await this.client.crypto.setDeviceVerification(userId, this.newDeviceId, true, false, true);

        const masterPublicKey = this.client.crypto.crossSigningInfo.getId("master")!;

        await this.send({
            type: this.v1FallbackEnabled ? PayloadType.Finish : PayloadType.Verified,
            outcome: this.v1FallbackEnabled ? Outcome.Verified : undefined,
            verifying_device_id: this.client.getDeviceId()!,
            verifying_device_key: this.client.getDeviceEd25519Key()!,
            master_key: masterPublicKey,
        });

        return info;
    }

    /**
     * Verify the device and cross-sign it.
     * @param timeout - time in milliseconds to wait for device to come online
     * @returns the new device info if the device was verified
     */
    public async verifyNewDeviceOnExistingDevice(
        timeout = 10 * 1000,
    ): Promise<DeviceInfo | CrossSigningInfo | undefined> {
        if (!this.newDeviceId) {
            throw new Error("No new device to sign");
        }

        if (!this.newDeviceKey) {
            logger.info("No new device key to sign");
            return undefined;
        }

        if (!this.client.crypto) {
            throw new Error("Crypto not available on client");
        }

        const userId = this.client.getUserId();

        if (!userId) {
            throw new Error("No user ID set");
        }

        let deviceInfo = this.client.crypto.getStoredDevice(userId, this.newDeviceId);

        if (!deviceInfo) {
            logger.info("Going to wait for new device to be online");
            await sleep(timeout);
            deviceInfo = this.client.crypto.getStoredDevice(userId, this.newDeviceId);
        }

        if (deviceInfo) {
            return await this.verifyAndCrossSignDevice(deviceInfo);
        }

        throw new Error("Device not online within timeout");
    }

    public async cancel(reason: RendezvousFailureReason): Promise<void> {
        this.onFailure?.(reason);
        await this.channel.cancel(reason);
    }

    public async close(): Promise<void> {
        await this.channel.close();
    }
}
