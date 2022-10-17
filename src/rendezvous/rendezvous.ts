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

import { RendezvousChannel } from ".";
import { MatrixClient } from "../client";
import { CrossSigningInfo } from "../crypto/CrossSigning";
import { DeviceInfo } from "../crypto/deviceinfo";
import { buildFeatureSupportMap, Feature, ServerSupport } from "../feature";
import { logger } from "../logger";
import { sleep } from "../utils";
import { RendezvousFailureListener, RendezvousFailureReason } from "./cancellationReason";
import { RendezvousIntent } from "./code";

enum PayloadType {
    Start = 'm.login.start',
    Finish = 'm.login.finish',
    Progress = 'm.login.progress',
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
    public code?: string;

    constructor(
        public channel: RendezvousChannel,
        public client: MatrixClient,
        public onFailure?: RendezvousFailureListener,
    ) {}

    async generateCode(): Promise<void> {
        if (this.code) {
            return;
        }

        this.code = JSON.stringify(await this.channel.generateCode(this.ourIntent));
    }

    async startAfterShowingCode(): Promise<string | undefined> {
        const checksum = await this.channel.connect();

        logger.info(`Connected to secure channel with checksum: ${checksum} our intent is ${this.ourIntent}`);

        const features = await buildFeatureSupportMap(await this.client.getVersions());
        // determine available protocols
        if (features.get(Feature.LoginTokenRequest) === ServerSupport.Unsupported) {
            logger.info("Server doesn't support MSC3882");
            await this.send({ type: PayloadType.Finish, outcome: 'unsupported' });
            await this.cancel(RendezvousFailureReason.HomeserverLacksSupport);
            return undefined;
        }

        await this.send({ type: PayloadType.Progress, protocols: [LOGIN_TOKEN_PROTOCOL.name] });

        logger.info('Waiting for other device to chose protocol');
        const { type, protocol, outcome } = await this.channel.receive();

        if (type === PayloadType.Finish) {
            // new device decided not to complete
            switch (outcome ?? '') {
                case 'unsupported':
                    await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
                    break;
                default:
                    await this.cancel(RendezvousFailureReason.Unknown);
            }
            return undefined;
        }

        if (type !== PayloadType.Progress) {
            await this.cancel(RendezvousFailureReason.Unknown);
            return undefined;
        }

        if (!LOGIN_TOKEN_PROTOCOL.matches(protocol)) {
            await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
            return undefined;
        }

        return checksum;
    }

    private async send({ type, ...payload }: { type: PayloadType, [key: string]: any }) {
        await this.channel.send({ type, ...payload });
    }

    async declineLoginOnExistingDevice() {
        logger.info('User declined sign in');
        await this.send({ type: PayloadType.Finish, outcome: 'declined' });
    }

    async approveLoginOnExistingDevice(loginToken: string): Promise<string | undefined> {
        // eslint-disable-next-line camelcase
        await this.send({ type: PayloadType.Progress, login_token: loginToken, homeserver: this.client.baseUrl });

        logger.info('Waiting for outcome');
        const res = await this.channel.receive();
        if (!res) {
            return undefined;
        }
        const { outcome, device_id: deviceId, device_key: deviceKey } = res;

        if (outcome !== 'success') {
            throw new Error('Linking failed');
        }

        this.newDeviceId = deviceId;
        this.newDeviceKey = deviceKey;

        return deviceId;
    }

    private async verifyAndCrossSignDevice(deviceInfo: DeviceInfo) {
        if (!this.client.crypto) {
            throw new Error('Crypto not available on client');
        }

        if (!this.newDeviceId) {
            throw new Error('No new device ID set');
        }

        // check that keys received from the server for the new device match those received from the device itself
        if (deviceInfo.getFingerprint() !== this.newDeviceKey) {
            throw new Error(
                `New device has different keys than expected: ${this.newDeviceKey} vs ${deviceInfo.getFingerprint()}`,
            );
        }

        const userId = this.client.getUserId();

        if (!userId) {
            throw new Error('No user ID set');
        }
        // mark the device as verified locally + cross sign
        logger.info(`Marking device ${this.newDeviceId} as verified`);
        const info = await this.client.crypto.setDeviceVerification(
            userId,
            this.newDeviceId,
            true, false, true,
        );

        const masterPublicKey = this.client.crypto.crossSigningInfo.getId('master');

        await this.send({
            type: PayloadType.Finish,
            outcome: 'verified',
            verifying_device_id: this.client.getDeviceId(),
            verifying_device_key: this.client.getDeviceEd25519Key(),
            master_key: masterPublicKey,
        });

        return info;
    }

    async verifyNewDeviceOnExistingDevice(timeout = 10 * 1000): Promise<DeviceInfo | CrossSigningInfo | undefined> {
        if (!this.newDeviceId) {
            throw new Error('No new device to sign');
        }

        if (!this.newDeviceKey) {
            logger.info("No new device key to sign");
            return undefined;
        }

        if (!this.client.crypto) {
            throw new Error('Crypto not available on client');
        }

        const userId = this.client.getUserId();

        if (!userId) {
            throw new Error('No user ID set');
        }

        {
            const deviceInfo = this.client.crypto.getStoredDevice(userId, this.newDeviceId);

            if (deviceInfo) {
                return await this.verifyAndCrossSignDevice(deviceInfo);
            }
        }

        logger.info("Going to wait for new device to be online");
        await sleep(timeout);

        {
            const deviceInfo = this.client.crypto.getStoredDevice(userId, this.newDeviceId);

            if (deviceInfo) {
                return await this.verifyAndCrossSignDevice(deviceInfo);
            }
        }

        throw new Error('Device not online within timeout');
    }

    async cancel(reason: RendezvousFailureReason) {
        this.onFailure?.(reason);
        await this.channel.cancel(reason);
    }

    async close() {
        await this.channel.close();
    }
}
