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

import { RendezvousChannel } from ".";
import { LoginTokenPostResponse } from "../@types/auth";
import { MatrixClient } from "../client";
import { CrossSigningInfo, requestKeysDuringVerification } from "../crypto/CrossSigning";
import { DeviceInfo } from "../crypto/deviceinfo";
import { IAuthData } from "../interactive-auth";
import { logger } from "../logger";
import { createClient } from "../matrix";
import { sleep } from "../utils";
import { RendezvousFailureReason } from "./cancellationReason";
import { RendezvousIntent } from "./code";

export enum PayloadType {
    Start = 'm.login.start',
    Finish = 'm.login.finish',
    Progress = 'm.login.progress',
}

export class Rendezvous {
    private cli?: MatrixClient;
    private newDeviceId?: string;
    private newDeviceKey?: string;
    private ourIntent: RendezvousIntent;
    public code?: string;
    public onFailure?: (reason: RendezvousFailureReason) => void;

    constructor(public channel: RendezvousChannel, cli?: MatrixClient) {
        this.cli = cli;
        this.ourIntent = this.isNewDevice ?
            RendezvousIntent.LOGIN_ON_NEW_DEVICE :
            RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE;
    }

    async generateCode(): Promise<void> {
        if (this.code) {
            return;
        }

        this.code = JSON.stringify(await this.channel.generateCode(this.ourIntent));
    }

    private get isNewDevice(): boolean {
        return !this.cli;
    }

    private async areIntentsIncompatible(theirIntent: RendezvousIntent): Promise<boolean> {
        const incompatible = theirIntent === this.ourIntent;

        logger.info(`ourIntent: ${this.ourIntent}, theirIntent: ${theirIntent}, incompatible: ${incompatible}`);

        if (incompatible) {
            await this.send({ type: PayloadType.Finish, intent: this.ourIntent });
            await this.channel.cancel(
                this.isNewDevice ?
                    RendezvousFailureReason.OtherDeviceNotSignedIn :
                    RendezvousFailureReason.OtherDeviceAlreadySignedIn,
            );
        }

        return incompatible;
    }

    async startAfterShowingCode(): Promise<string | undefined> {
        return this.start();
    }

    async startAfterScanningCode(theirIntent: RendezvousIntent): Promise<string | undefined> {
        return this.start(theirIntent);
    }

    private async start(theirIntent?: RendezvousIntent): Promise<string | undefined> {
        const didScan = !!theirIntent;

        const checksum = await this.channel.connect();

        logger.info(`Connected to secure channel with checksum: ${checksum}`);

        if (didScan) {
            if (await this.areIntentsIncompatible(theirIntent)) {
                // a m.login.finish event is sent as part of areIntentsIncompatible
                return undefined;
            }
        }

        if (this.cli) {
            if (didScan) {
                await this.channel.receive(); // wait for ack
            }

            // determine available protocols
            if (!(await this.cli.doesServerSupportUnstableFeature('org.matrix.msc3882'))) {
                logger.info("Server doesn't support MSC3882");
                await this.send({ type: PayloadType.Finish, outcome: 'unsupported' });
                await this.cancel(RendezvousFailureReason.HomeserverLacksSupport);
                return undefined;
            }

            await this.send({ type: PayloadType.Progress, protocols: ['login_token'] });

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

            if (protocol !== 'login_token') {
                await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
                return undefined;
            }
        } else {
            if (!didScan) {
                logger.info("Sending ack");
                await this.send({ type: PayloadType.Progress });
            }

            logger.info("Waiting for protocols");
            const { protocols } = await this.channel.receive();

            if (!Array.isArray(protocols) || !protocols.includes('login_token')) {
                await this.send({ type: PayloadType.Finish, outcome: 'unsupported' });
                await this.cancel(RendezvousFailureReason.UnsupportedAlgorithm);
                return undefined;
            }

            await this.send({ type: PayloadType.Progress, protocol: "login_token" });
        }

        return checksum;
    }

    async send({ type, ...payload }: { type: PayloadType, [key: string]: any }) {
        await this.channel.send({ type, ...payload });
    }

    async completeLoginOnNewDevice(): Promise<{
        userId: string;
        deviceId: string;
        accessToken: string;
        homeserverUrl: string;
    } | undefined> {
        logger.info('Waiting for login_token');

        // eslint-disable-next-line camelcase
        const { type, login_token: token, outcome, homeserver } = await this.channel.receive();

        if (type === PayloadType.Finish) {
            switch (outcome ?? '') {
                case 'unsupported':
                    await this.cancel(RendezvousFailureReason.HomeserverLacksSupport);
                    break;
                default:
                    await this.cancel(RendezvousFailureReason.Unknown);
            }
            return undefined;
        }

        if (!homeserver) {
            throw new Error("No homeserver returned");
        }
        // eslint-disable-next-line camelcase
        if (!token) {
            throw new Error("No login token returned");
        }

        const client = createClient({
            baseUrl: homeserver,
        });

        const { device_id: deviceId, user_id: userId, access_token: accessToken } =
            await client.login("m.login.token", { token });

        return {
            userId,
            deviceId,
            accessToken,
            homeserverUrl: homeserver,
        };
    }

    async completeVerificationOnNewDevice(client: MatrixClient): Promise<void> {
        await this.send({
            type: PayloadType.Progress,
            outcome: 'success',
            device_id: client.getDeviceId(),
            device_key: client.getDeviceEd25519Key(),
        });

        // await confirmation of verification
        const {
            verifying_device_id: verifyingDeviceId,
            master_key: masterKey,
            verifying_device_key: verifyingDeviceKey,
        } = await this.channel.receive();

        const userId = client.getUserId()!;
        const verifyingDeviceFromServer =
            client.crypto.deviceList.getStoredDevice(userId, verifyingDeviceId);

        if (verifyingDeviceFromServer?.getFingerprint() === verifyingDeviceKey) {
            // set other device as verified
            logger.info(`Setting device ${verifyingDeviceId} as verified`);
            await client.setDeviceVerified(userId, verifyingDeviceId, true);

            if (masterKey) {
                // set master key as trusted
                await client.setDeviceVerified(userId, masterKey, true);
            }

            // request secrets from the verifying device
            logger.info(`Requesting secrets from ${verifyingDeviceId}`);
            await requestKeysDuringVerification(client, userId, verifyingDeviceId);
        } else {
            logger.info(`Verifying device ${verifyingDeviceId} doesn't match: ${verifyingDeviceFromServer}`);
        }
    }

    async declineLoginOnExistingDevice() {
        logger.info('User declined linking');
        await this.send({ type: PayloadType.Finish, outcome: 'declined' });
    }

    async confirmLoginOnExistingDevice(): Promise<string | undefined> {
        const client = this.cli;

        logger.info("Requesting login token");

        const loginTokenResponse = await client.requestLoginToken();

        if (typeof (loginTokenResponse as IAuthData).session === 'string') {
            // TODO: handle UIA response
            throw new Error("UIA isn't supported yet");
        }
        // eslint-disable-next-line camelcase
        const { login_token } = loginTokenResponse as LoginTokenPostResponse;

        // eslint-disable-next-line camelcase
        await this.send({ type: PayloadType.Progress, login_token, homeserver: client.baseUrl });

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

    private async checkAndCrossSignDevice(deviceInfo: DeviceInfo) {
        // check that keys received from the server for the new device match those received from the device itself
        if (deviceInfo.getFingerprint() !== this.newDeviceKey) {
            throw new Error(
                `New device has different keys than expected: ${this.newDeviceKey} vs ${deviceInfo.getFingerprint()}`,
            );
        }

        // mark the device as verified locally + cross sign
        logger.info(`Marking device ${this.newDeviceId} as verified`);
        const info = await this.cli.crypto.setDeviceVerification(
            this.cli.getUserId(),
            this.newDeviceId,
            true, false, true,
        );

        const masterPublicKey = this.cli.crypto.crossSigningInfo.getId('master');

        await this.send({
            type: PayloadType.Finish,
            outcome: 'verified',
            verifying_device_id: this.cli.getDeviceId(),
            verifying_device_key: this.cli.getDeviceEd25519Key(),
            master_key: masterPublicKey,
        });

        return info;
    }

    async crossSign(timeout = 10 * 1000): Promise<DeviceInfo | CrossSigningInfo | undefined> {
        if (!this.newDeviceId) {
            throw new Error('No new device to sign');
        }

        if (!this.newDeviceKey) {
            logger.info("No new device key to sign");
            return undefined;
        }

        const cli = this.cli;

        {
            const deviceInfo = cli.crypto.getStoredDevice(cli.getUserId(), this.newDeviceId);

            if (deviceInfo) {
                return await this.checkAndCrossSignDevice(deviceInfo);
            }
        }

        logger.info("New device is not online");
        await sleep(timeout);

        logger.info("Going to wait for new device to be online");

        {
            const deviceInfo = cli.crypto.getStoredDevice(cli.getUserId(), this.newDeviceId);

            if (deviceInfo) {
                return await this.checkAndCrossSignDevice(deviceInfo);
            }
        }

        throw new Error('Device not online within timeout');
    }

    async userCancelled(): Promise<void> {
        this.cancel(RendezvousFailureReason.UserCancelled);
    }

    async cancel(reason: RendezvousFailureReason) {
        await this.channel.cancel(reason);
    }

    async close() {
        await this.channel.close();
    }
}
