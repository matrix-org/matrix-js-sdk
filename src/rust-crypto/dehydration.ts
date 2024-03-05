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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { RustCrypto } from "./rust-crypto";
import { OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { encodeUri } from "../utils";
import { ClientPrefix, IHttpOpts, MatrixError, MatrixHttpApi, Method } from "../http-api";
import { IToDeviceEvent } from "../sync-accumulator";
import { ServerSideSecretStorage } from "../secret-storage";
import { crypto } from "../crypto/crypto";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64";
import { Logger } from "../logger";
import { UnstableValue } from "../NamespacedValue";

// schema for the API response bodies
interface IDehydratedDeviceResp {
    device_id: string;
    device_data: {
        algorithm: string;
    };
}
interface IDehydratedDeviceEventsResp {
    events: IToDeviceEvent[];
    next_batch: string;
}

export const UnstablePrefix = ClientPrefix.Unstable + "/org.matrix.msc3814.v1";
const SECRET_STORAGE_NAME = new UnstableValue("m.dehydrated_device", "org.matrix.msc3814");

/**
 * Manages dehydrated devices
 */
export class RustDehydrationManager {
    private readonly dehydratedDevices: RustSdkCryptoJs.DehydratedDevices;
    private key?: Uint8Array;
    private intervalId?: ReturnType<typeof setInterval>;
    private timeoutId?: ReturnType<typeof setTimeout>;

    public constructor(
        private readonly logger: Logger,
        private readonly rustCrypto: RustCrypto,
        olmMachine: RustSdkCryptoJs.OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
        private readonly secretStorage: ServerSideSecretStorage,
    ) {
        this.dehydratedDevices = olmMachine.dehydratedDevices();
    }

    /** Return whether the dehydration key is stored in Secret Storage
     */
    public async isKeyStored(): Promise<boolean> {
        return Boolean(await this.secretStorage.isStored(SECRET_STORAGE_NAME.name));
    }

    /** Get and cache the encryption key from secret storage
     *
     * If `create` is `true`, creates a new key if no existing key is present.
     */
    private async getKey(create: boolean): Promise<boolean> {
        if (this.key === undefined) {
            const keyB64 = await this.secretStorage.get(SECRET_STORAGE_NAME.name);
            if (keyB64 === undefined) {
                if (!create) {
                    return false;
                }
                this.key = new Uint8Array(32);
                crypto.getRandomValues(this.key);
                await this.secretStorage.store(SECRET_STORAGE_NAME.name, encodeUnpaddedBase64(this.key));
            } else {
                this.key = decodeBase64(keyB64);
            }
        }
        return true;
    }

    /**
     * Rehydrate the dehydrated device stored on the server
     *
     * Checks if there is a dehydrated device on the server.  If so, rehydrates
     * the device and processes the to-device events.
     *
     * Returns whether or not a dehydrated device was found.
     */
    public async rehydrateDeviceIfAvailable(): Promise<boolean> {
        if (!(await this.getKey(false))) {
            return false;
        }

        let dehydratedDeviceResp;
        try {
            dehydratedDeviceResp = await this.http.authedRequest<IDehydratedDeviceResp>(
                Method.Get,
                "/dehydrated_device",
                undefined,
                undefined,
                {
                    prefix: UnstablePrefix,
                },
            );
        } catch (error) {
            const err = error as MatrixError;
            // We ignore M_NOT_FOUND (there is no dehydrated device, so nothing
            // us to do) and M_UNRECOGNIZED (the server does not understand the
            // endpoint).  We pass through any other errors.
            if (err.errcode === "M_NOT_FOUND" || err.errcode === "M_UNRECOGNIZED") {
                this.logger.info("dehydration: No dehydrated device");
                return false;
            }
            throw err;
        }

        this.logger.info("dehydration: device found");

        const rehydratedDevice = await this.dehydratedDevices.rehydrate(
            this.key!,
            new RustSdkCryptoJs.DeviceId(dehydratedDeviceResp.device_id),
            JSON.stringify(dehydratedDeviceResp.device_data),
        );

        this.logger.info("dehydration: device rehydrated");

        let nextBatch: string | undefined = undefined;
        let toDeviceCount = 0;
        let roomKeyCount = 0;
        for (;;) {
            const path = encodeUri("/dehydrated_device/$device_id/events", {
                $device_id: dehydratedDeviceResp.device_id,
            });
            const eventResp: IDehydratedDeviceEventsResp = await this.http.authedRequest<IDehydratedDeviceEventsResp>(
                Method.Post,
                path,
                undefined,
                nextBatch ? { next_batch: nextBatch } : {},
                {
                    prefix: UnstablePrefix,
                },
            );

            if (eventResp.events.length == 0) {
                break;
            }
            toDeviceCount += eventResp.events.length;
            nextBatch = eventResp.next_batch;
            const roomKeyInfos: RustSdkCryptoJs.RoomKeyInfo[] = await rehydratedDevice.receiveEvents(
                JSON.stringify(eventResp.events),
            );
            roomKeyCount += eventResp.events.length;

            // FIXME: is this actually needed?  It looks like the OlmMachine
            // automatically re-tries decryption
            await this.rustCrypto.onRoomKeysUpdated(roomKeyInfos);
        }
        this.logger.info(`dehydration: received ${roomKeyCount} room keys from ${toDeviceCount} to-device events`);

        return true;
    }

    /**
     * Creates and uploads a new dehydrated device
     *
     * Creates and stores a new key in secret storage if none is available.
     */
    public async createAndUploadDehydratedDevice(): Promise<void> {
        await this.getKey(true);

        // FIXME: should raise error if server doesn't support dehydration

        const dehydratedDevice = await this.dehydratedDevices.create();
        // FIXME: should the device display name be localised? passed as a
        // parameter?
        const request = await dehydratedDevice.keysForUpload("Dehydrated device", this.key!);

        await this.outgoingRequestProcessor.makeOutgoingRequest(request);

        this.logger.info("dehydration: uploaded device");

        // FIXME: emit event when done
    }

    /**
     * Schedule periodic creation of dehydrated devices
     *
     * @param interval - the time to wait between creating dehydrated devices
     * @param delay - how long to wait before creating the first dehydrated device.
     *     Defaults to creating the device immediately.
     */
    public async scheduleDeviceDehydration(interval: number, delay?: number): Promise<void> {
        // cancel any previously-scheduled tasks
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }

        if (delay) {
            this.timeoutId = setTimeout(() => {
                this.scheduleDeviceDehydration(interval);
                this.timeoutId = undefined;
            }, delay);
        } else {
            await this.createAndUploadDehydratedDevice();
            // FIXME: should we randomize the time?
            this.intervalId = setInterval(this.createAndUploadDehydratedDevice.bind(this), interval);
        }
    }
}
