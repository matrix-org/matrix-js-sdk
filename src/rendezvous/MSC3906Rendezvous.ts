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
    SETUP_ADDITIONAL_DEVICE_FLOW_V1,
} from ".";
import { MatrixClient } from "../client";
import { CrossSigningInfo } from "../crypto/CrossSigning";
import { DeviceInfo } from "../crypto/deviceinfo";
import { buildFeatureSupportMap, Feature, ServerSupport } from "../feature";
import { logger } from "../logger";
import { sleep } from "../utils";

/**
 * These are the possible types of payload that are used in
 * [MSC3906](https://github.com/matrix-org/matrix-spec-proposals/pull/3906) payloads.
 * The values are used in the `type` field.
 */
enum PayloadType {
    /**
     * @deprecated Only used in MSC3906 v1
     */
    Finish = "m.login.finish",
    /**
     * Indicates that a new device is ready to proceed with the setup process.
     */
    Progress = "m.login.progress",
    /**
     * Used by the new device to indicate which protocol to use.
     */
    Protocol = "m.login.protocol",
    /**
     * Used for the new device to indicate which protocols are supported by the existing device and
     * homeserver.
     */
    Protocols = "m.login.protocols",
    /**
     * Indicates that the sign of the new device was approved by the user on the existing device.
     */
    Approved = "m.login.approved",
    /**
     * Indicates that the new device has signed in successfully.
     */
    Success = "m.login.success",
    /**
     * Indicates that the new device has been successfully verified by the existing device.
     */
    Verified = "m.login.verified",
    /**
     * Indicates that the login failed.
     */
    Failure = "m.login.failure",
    /**
     * Indicates that the user declined the login on the existing device.
     */
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

/**
 * Used in the `reason` field of the `m.login.failure` payload.
 */
enum FailureReason {
    Cancelled = "cancelled",
    Unsupported = "unsupported",
    E2EESecurityError = "e2ee_security_error",
    IncompatibleIntent = "incompatible_intent",
}

/**
 * This represents an [MSC3906](https://github.com/matrix-org/matrix-spec-proposals/pull/3906) payload.
 */
export interface MSC3906RendezvousPayload {
    /** The type of the payload */
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

/**
 * Represents the use of an `m.login.token` obtained from an existing device to sign in on a new device.
 */
const LOGIN_TOKEN_PROTOCOL = new UnstableValue("login_token", "org.matrix.msc3906.login_token");

/**
 * This class can be used to complete a "rendezvous flow" as defined in MSC3906.
 *
 * Currently it only supports being used on a device that is already signed in that wishes to help sign in
 * another device.
 *
 * Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC3906Rendezvous {
    private newDeviceId?: string;
    private newDeviceKey?: string;
    private ourIntent: RendezvousIntent = RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE;
    // if true then we follow the v1 flow, otherwise we follow the v2 flow
    private usingV1Flow: boolean;
    private _code?: string;

    /**
     * Creates an instance that can be used to manage the execution of a rendezvous flow.
     *
     * @param channel - The rendezvous channel that should be used for communication with the other device
     * @param client - The Matrix client that should be used.
     * @param onFailure - Optional callback function to be notified of rendezvous failures.
     * @param flow - The rendezvous flow to use. Defaults to setting up an additional device using MSC3906 v1,
     * for backwards compatibility.
     */
    public constructor(
        private channel: RendezvousChannel<MSC3906RendezvousPayload>,
        private client: MatrixClient,
        public onFailure?: RendezvousFailureListener,
        private flow: RendezvousFlow = SETUP_ADDITIONAL_DEVICE_FLOW_V1,
    ) {
        this.usingV1Flow = flow === SETUP_ADDITIONAL_DEVICE_FLOW_V1;
    }

    /**
     * @returns The code representing the rendezvous suitable for rendering in a QR code or undefined if not generated yet.
     */
    public get code(): string | undefined {
        return this._code;
    }

    /**
     * Generate the code including doing partial set up of the channel where required. This code could be encoded in a QR.
     */
    public async generateCode(): Promise<void> {
        if (this._code) {
            return;
        }

        const raw = this.usingV1Flow
            ? await this.channel.generateCode(this.ourIntent)
            : await this.channel.generateCode(this.ourIntent, this.flow);
        this._code = JSON.stringify(raw);
    }

    /**
     * Call this after the code has been shown to the user (perhaps in a QR). It will poll for the other device
     * at the rendezvous point and start the process of setting up the new device.
     *
     * If successful then the user should be asked to approve the login of the other device whilst displaying the
     * returned checksum code which the user should verify matches the code shown on the other device.
     *
     * @returns the checksum of the secure channel if the rendezvous set up was successful, otherwise undefined
     */
    public async startAfterShowingCode(): Promise<string | undefined> {
        const checksum = await this.channel.connect();

        logger.info(`Connected to secure channel with checksum: ${checksum} our intent is ${this.ourIntent}`);

        const features = await buildFeatureSupportMap(await this.client.getVersions());
        // determine available protocols
        if (features.get(Feature.LoginTokenRequest) === ServerSupport.Unsupported) {
            logger.info("Server doesn't support MSC3882");
            await this.send(
                this.usingV1Flow
                    ? { type: PayloadType.Finish, outcome: Outcome.Unsupported }
                    : { type: PayloadType.Failure, reason: FailureReason.Unsupported },
            );
            await this.cancel(RendezvousFailureReason.HomeserverLacksSupport);
            return undefined;
        }

        await this.send({
            type: this.usingV1Flow ? PayloadType.Progress : PayloadType.Protocols,
            protocols: [LOGIN_TOKEN_PROTOCOL.name],
        });

        logger.info("Waiting for other device to chose protocol");
        const nextPayload = await this.receive();

        // even if we didn't start in v1 mode we might detect that the other device is v1:
        // - the finish payload is only used in v1
        // - a progress payload is only sent at this point in v1, in v2 the use of it is different
        if (nextPayload.type === PayloadType.Finish || nextPayload.type === PayloadType.Progress) {
            this.usingV1Flow = true;
        }

        const protocol = this.usingV1Flow
            ? await this.handleV1ProtocolPayload(nextPayload)
            : await this.handleV2ProtocolPayload(nextPayload);

        // invalid protocol
        if (!protocol || !LOGIN_TOKEN_PROTOCOL.matches(protocol)) {
            await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
            return undefined;
        }

        return checksum;
    }

    private async handleV1ProtocolPayload({
        type,
        protocol,
        outcome,
        reason,
        intent,
    }: MSC3906RendezvousPayload): Promise<string | void> {
        if (type === PayloadType.Finish) {
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
            return;
        }

        // unexpected payload
        if (type !== PayloadType.Progress) {
            await this.cancel(RendezvousFailureReason.Unknown);
            return;
        }

        return protocol;
    }

    private async handleV2ProtocolPayload({
        type,
        protocol,
        outcome,
        reason,
        intent,
    }: MSC3906RendezvousPayload): Promise<string | void> {
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
            return;
        }

        // unexpected payload
        if (type !== PayloadType.Protocol) {
            await this.cancel(RendezvousFailureReason.Unknown);
            return;
        }

        return protocol;
    }

    private async receive(): Promise<MSC3906RendezvousPayload> {
        return (await this.channel.receive()) as MSC3906RendezvousPayload;
    }

    private async send(payload: MSC3906RendezvousPayload): Promise<void> {
        await this.channel.send(payload);
    }

    /**
     * Call this if the user has declined the login.
     */
    public async declineLoginOnExistingDevice(): Promise<void> {
        logger.info("User declined sign in");
        await this.send(
            this.usingV1Flow ? { type: PayloadType.Finish, outcome: Outcome.Declined } : { type: PayloadType.Declined },
        );
    }

    /**
     * Call this if the user has approved the login.
     *
     * @param loginToken - the login token to send to the new device for it to complete the login flow
     * @returns if the new device successfully completed the login flow and provided their device id then the device id is
     * returned, otherwise undefined
     */
    public async approveLoginOnExistingDevice(loginToken: string): Promise<string | undefined> {
        await this.channel.send({
            type: this.usingV1Flow ? PayloadType.Progress : PayloadType.Approved,
            login_token: loginToken,
            homeserver: this.client.baseUrl,
        });

        logger.info("Waiting for outcome");
        const res = await this.receive();
        if (!res) {
            return undefined;
        }
        const { type, outcome, device_id: deviceId, device_key: deviceKey } = res;

        if ((this.usingV1Flow && outcome !== "success") || (!this.usingV1Flow && type !== PayloadType.Success)) {
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
            type: this.usingV1Flow ? PayloadType.Finish : PayloadType.Verified,
            outcome: this.usingV1Flow ? Outcome.Verified : undefined,
            verifying_device_id: this.client.getDeviceId()!,
            verifying_device_key: this.client.getDeviceEd25519Key()!,
            master_key: masterPublicKey,
        });

        return info;
    }

    /**
     * Wait for a device to be visible via the homeserver and then verify/cross-sign it.
     *
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
