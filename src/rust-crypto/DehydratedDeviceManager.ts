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

import { type OutgoingRequestProcessor } from "./OutgoingRequestProcessor.ts";
import { encodeUri } from "../utils.ts";
import { type IHttpOpts, type MatrixError, type MatrixHttpApi, Method } from "../http-api/index.ts";
import { type IToDeviceEvent } from "../sync-accumulator.ts";
import { type ServerSideSecretStorage } from "../secret-storage.ts";
import { decodeBase64 } from "../base64.ts";
import { type Logger } from "../logger.ts";
import { CryptoEvent, type CryptoEventHandlerMap, type StartDehydrationOpts } from "../crypto-api/index.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";

/**
 * The response body of `GET /_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device`.
 */
interface DehydratedDeviceResp {
    device_id: string;
    device_data: {
        algorithm: string;
    };
}
/**
 * The response body of `POST /_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device/events`.
 */
interface DehydratedDeviceEventsResp {
    events: IToDeviceEvent[];
    next_batch: string;
}

/**
 * The unstable URL prefix for dehydrated device endpoints
 */
export const UnstablePrefix = "/_matrix/client/unstable/org.matrix.msc3814.v1";
/**
 * The name used for the dehydration key in Secret Storage
 */
const SECRET_STORAGE_NAME = "org.matrix.msc3814";

/**
 * The interval between creating dehydrated devices. (one week)
 */
const DEHYDRATION_INTERVAL = 7 * 24 * 60 * 60 * 1000;

/**
 * Manages dehydrated devices
 *
 * We have one of these per `RustCrypto`.  It's responsible for
 *
 * * determining server support for dehydrated devices
 * * creating new dehydrated devices when requested, including periodically
 *   replacing the dehydrated device with a new one
 * * rehydrating a device when requested, and when present
 *
 * @internal
 */
export class DehydratedDeviceManager extends TypedEventEmitter<DehydratedDevicesEvents, DehydratedDevicesEventMap> {
    /** the ID of the interval for periodically replacing the dehydrated device */
    private intervalId?: ReturnType<typeof setInterval>;

    public constructor(
        private readonly logger: Logger,
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
        private readonly secretStorage: ServerSideSecretStorage,
    ) {
        super();
    }

    private async cacheKey(key: RustSdkCryptoJs.DehydratedDeviceKey): Promise<void> {
        await this.olmMachine.dehydratedDevices().saveDehydratedDeviceKey(key);
        this.emit(CryptoEvent.DehydrationKeyCached);
    }

    /**
     * Return whether the server supports dehydrated devices.
     */
    public async isSupported(): Promise<boolean> {
        // call the endpoint to get a dehydrated device.  If it returns an
        // M_UNRECOGNIZED error, then dehydration is unsupported.  If it returns
        // a successful response, or an M_NOT_FOUND, then dehydration is supported.
        // Any other exceptions are passed through.
        try {
            await this.http.authedRequest<DehydratedDeviceResp>(
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
            if (err.errcode === "M_UNRECOGNIZED") {
                return false;
            } else if (err.errcode === "M_NOT_FOUND") {
                return true;
            }
            throw error;
        }
        return true;
    }

    /**
     * Start using device dehydration.
     *
     * - Rehydrates a dehydrated device, if one is available and `opts.rehydrate`
     *   is `true`.
     * - Creates a new dehydration key, if necessary, and stores it in Secret
     *   Storage.
     *   - If `opts.createNewKey` is set to true, always creates a new key.
     *   - If a dehydration key is not available, creates a new one.
     * - Creates a new dehydrated device, and schedules periodically creating
     *   new dehydrated devices.
     *
     * @param opts - options for device dehydration. For backwards compatibility
     *     with old code, a boolean can be given here, which will be treated as
     *     the `createNewKey` option. However, this is deprecated.
     */
    public async start(opts: StartDehydrationOpts | boolean = {}): Promise<void> {
        if (typeof opts === "boolean") {
            opts = { createNewKey: opts };
        }

        if (opts.onlyIfKeyCached && !(await this.olmMachine.dehydratedDevices().getDehydratedDeviceKey())) {
            return;
        }
        this.stop();
        if (opts.rehydrate !== false) {
            try {
                await this.rehydrateDeviceIfAvailable();
            } catch (e) {
                // If rehydration fails, there isn't much we can do about it.  Log
                // the error, and create a new device.
                this.logger.info("dehydration: Error rehydrating device:", e);
                this.emit(CryptoEvent.RehydrationError, (e as Error).message);
            }
        }
        if (opts.createNewKey) {
            await this.resetKey();
        }
        await this.scheduleDeviceDehydration();
    }

    /**
     * Return whether the dehydration key is stored in Secret Storage.
     */
    public async isKeyStored(): Promise<boolean> {
        return Boolean(await this.secretStorage.isStored(SECRET_STORAGE_NAME));
    }

    /**
     * Reset the dehydration key.
     *
     * Creates a new key and stores it in secret storage.
     *
     * @returns The newly-generated key.
     */
    public async resetKey(): Promise<RustSdkCryptoJs.DehydratedDeviceKey> {
        const key = RustSdkCryptoJs.DehydratedDeviceKey.createRandomKey();
        await this.secretStorage.store(SECRET_STORAGE_NAME, key.toBase64());
        // Also cache it in the rust SDK's crypto store.
        await this.cacheKey(key);
        return key;
    }

    /**
     * Get and cache the encryption key from secret storage.
     *
     * If `create` is `true`, creates a new key if no existing key is present.
     *
     * @returns the key, if available, or `null` if no key is available
     */
    private async getKey(create: boolean): Promise<RustSdkCryptoJs.DehydratedDeviceKey | null> {
        const cachedKey = await this.olmMachine.dehydratedDevices().getDehydratedDeviceKey();
        if (cachedKey) return cachedKey;
        const keyB64 = await this.secretStorage.get(SECRET_STORAGE_NAME);
        if (keyB64 === undefined) {
            if (!create) {
                return null;
            }
            return await this.resetKey();
        }

        // We successfully found the key in secret storage: decode it, and cache it in
        // the rust SDK's crypto store.
        const bytes = decodeBase64(keyB64);
        try {
            const key = RustSdkCryptoJs.DehydratedDeviceKey.createKeyFromArray(bytes);
            await this.cacheKey(key);
            return key;
        } finally {
            bytes.fill(0);
        }
    }

    /**
     * Rehydrate the dehydrated device stored on the server.
     *
     * Checks if there is a dehydrated device on the server.  If so, rehydrates
     * the device and processes the to-device events.
     *
     * Returns whether or not a dehydrated device was found.
     */
    public async rehydrateDeviceIfAvailable(): Promise<boolean> {
        const key = await this.getKey(false);
        if (!key) {
            return false;
        }

        let dehydratedDeviceResp;
        try {
            dehydratedDeviceResp = await this.http.authedRequest<DehydratedDeviceResp>(
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

        this.logger.info("dehydration: dehydrated device found");
        this.emit(CryptoEvent.RehydrationStarted);

        const rehydratedDevice = await this.olmMachine
            .dehydratedDevices()
            .rehydrate(
                key,
                new RustSdkCryptoJs.DeviceId(dehydratedDeviceResp.device_id),
                JSON.stringify(dehydratedDeviceResp.device_data),
            );

        this.logger.info("dehydration: device rehydrated");

        let nextBatch: string | undefined = undefined;
        let toDeviceCount = 0;
        let roomKeyCount = 0;
        const path = encodeUri("/dehydrated_device/$device_id/events", {
            $device_id: dehydratedDeviceResp.device_id,
        });
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const eventResp: DehydratedDeviceEventsResp = await this.http.authedRequest<DehydratedDeviceEventsResp>(
                Method.Post,
                path,
                undefined,
                nextBatch ? { next_batch: nextBatch } : {},
                {
                    prefix: UnstablePrefix,
                },
            );

            if (eventResp.events.length === 0) {
                break;
            }
            toDeviceCount += eventResp.events.length;
            nextBatch = eventResp.next_batch;
            const roomKeyInfos = await rehydratedDevice.receiveEvents(JSON.stringify(eventResp.events));
            roomKeyCount += roomKeyInfos.length;

            this.emit(CryptoEvent.RehydrationProgress, roomKeyCount, toDeviceCount);
        }
        this.logger.info(`dehydration: received ${roomKeyCount} room keys from ${toDeviceCount} to-device events`);
        this.emit(CryptoEvent.RehydrationCompleted);

        return true;
    }

    /**
     * Creates and uploads a new dehydrated device.
     *
     * Creates and stores a new key in secret storage if none is available.
     */
    public async createAndUploadDehydratedDevice(): Promise<void> {
        const key = (await this.getKey(true))!;

        const dehydratedDevice = await this.olmMachine.dehydratedDevices().create();
        this.emit(CryptoEvent.DehydratedDeviceCreated);
        const request = await dehydratedDevice.keysForUpload("Dehydrated device", key);

        await this.outgoingRequestProcessor.makeOutgoingRequest(request);
        this.emit(CryptoEvent.DehydratedDeviceUploaded);

        this.logger.info("dehydration: uploaded device");
    }

    /**
     * Schedule periodic creation of dehydrated devices.
     */
    public async scheduleDeviceDehydration(): Promise<void> {
        // cancel any previously-scheduled tasks
        this.stop();

        await this.createAndUploadDehydratedDevice();
        this.intervalId = setInterval(() => {
            this.createAndUploadDehydratedDevice().catch((error) => {
                this.emit(CryptoEvent.DehydratedDeviceRotationError, error.message);
                this.logger.error("Error creating dehydrated device:", error);
            });
        }, DEHYDRATION_INTERVAL);
    }

    /**
     * Stop the dehydrated device manager.
     *
     * Cancels any scheduled dehydration tasks.
     */
    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    /**
     * Delete the current dehydrated device and stop the dehydrated device manager.
     */
    public async delete(): Promise<void> {
        this.stop();
        try {
            await this.http.authedRequest(
                Method.Delete,
                "/dehydrated_device",
                undefined,
                {},
                {
                    prefix: UnstablePrefix,
                },
            );
        } catch (error) {
            const err = error as MatrixError;
            // If dehydrated devices aren't supported, or no dehydrated device
            // is found, we don't consider it an error, because we we'll end up
            // with no dehydrated device.
            if (err.errcode === "M_UNRECOGNIZED") {
                return;
            } else if (err.errcode === "M_NOT_FOUND") {
                return;
            }
            throw error;
        }
    }
}

/**
 * The events fired by the DehydratedDeviceManager
 * @internal
 */
type DehydratedDevicesEvents =
    | CryptoEvent.DehydratedDeviceCreated
    | CryptoEvent.DehydratedDeviceUploaded
    | CryptoEvent.RehydrationStarted
    | CryptoEvent.RehydrationProgress
    | CryptoEvent.RehydrationCompleted
    | CryptoEvent.RehydrationError
    | CryptoEvent.DehydrationKeyCached
    | CryptoEvent.DehydratedDeviceRotationError;

/**
 * A map of the {@link DehydratedDeviceEvents} fired by the {@link DehydratedDeviceManager} and their payloads.
 * @internal
 */
type DehydratedDevicesEventMap = Pick<CryptoEventHandlerMap, DehydratedDevicesEvents>;
