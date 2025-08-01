/*
Copyright 2022-2023 The Matrix.org Foundation C.I.C.

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

import anotherjson from "another-json";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import type { IEventDecryptionResult, IMegolmSessionData } from "../@types/crypto.ts";
import { KnownMembership } from "../@types/membership.ts";
import { type IDeviceLists, type IToDeviceEvent, type ReceivedToDeviceMessage } from "../sync-accumulator.ts";
import type { ToDeviceBatch, ToDevicePayload } from "../models/ToDeviceMessage.ts";
import { type MatrixEvent, MatrixEventEvent } from "../models/event.ts";
import { type Room } from "../models/room.ts";
import { type RoomMember } from "../models/room-member.ts";
import {
    type BackupDecryptor,
    type CryptoBackend,
    DecryptionError,
    type OnSyncCompletedData,
} from "../common-crypto/CryptoBackend.ts";
import { type Logger, LogSpan } from "../logger.ts";
import { type IHttpOpts, type MatrixHttpApi, Method } from "../http-api/index.ts";
import { RoomEncryptor } from "./RoomEncryptor.ts";
import { OutgoingRequestProcessor } from "./OutgoingRequestProcessor.ts";
import { KeyClaimManager } from "./KeyClaimManager.ts";
import { MapWithDefault } from "../utils.ts";
import {
    AllDevicesIsolationMode,
    type BackupTrustInfo,
    type BootstrapCrossSigningOpts,
    type CreateSecretStorageOpts,
    CrossSigningKey,
    type CrossSigningKeyInfo,
    type CrossSigningStatus,
    type CryptoApi,
    type CryptoCallbacks,
    CryptoEvent,
    type CryptoEventHandlerMap,
    DecryptionFailureCode,
    deriveRecoveryKeyFromPassphrase,
    type DeviceIsolationMode,
    DeviceIsolationModeKind,
    DeviceVerificationStatus,
    encodeRecoveryKey,
    type EventEncryptionInfo,
    EventShieldColour,
    EventShieldReason,
    type GeneratedSecretStorageKey,
    type ImportRoomKeysOpts,
    ImportRoomKeyStage,
    type KeyBackupCheck,
    type KeyBackupInfo,
    type KeyBackupRestoreOpts,
    type KeyBackupRestoreResult,
    type OwnDeviceKeys,
    type StartDehydrationOpts,
    UserVerificationStatus,
    type VerificationRequest,
} from "../crypto-api/index.ts";
import { deviceKeysToDeviceMap, rustDeviceToJsDevice } from "./device-converter.ts";
import { type IDownloadKeyResult, type IQueryKeysRequest } from "../client.ts";
import { type Device, type DeviceMap } from "../models/device.ts";
import {
    SECRET_STORAGE_ALGORITHM_V1_AES,
    type SecretStorageKey,
    type ServerSideSecretStorage,
} from "../secret-storage.ts";
import { CrossSigningIdentity } from "./CrossSigningIdentity.ts";
import { secretStorageCanAccessSecrets, secretStorageContainsCrossSigningKeys } from "./secret-storage.ts";
import { isVerificationEvent, RustVerificationRequest, verificationMethodIdentifierToMethod } from "./verification.ts";
import { EventType, MsgType } from "../@types/event.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { decryptionKeyMatchesKeyBackupInfo, RustBackupManager } from "./backup.ts";
import { TypedReEmitter } from "../ReEmitter.ts";
import { secureRandomString } from "../randomstring.ts";
import { ClientStoppedError } from "../errors.ts";
import { type ISignatures } from "../@types/signed.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { OutgoingRequestsManager } from "./OutgoingRequestsManager.ts";
import { PerSessionKeyBackupDownloader } from "./PerSessionKeyBackupDownloader.ts";
import { DehydratedDeviceManager } from "./DehydratedDeviceManager.ts";
import { VerificationMethod } from "../types.ts";
import { keyFromAuthData } from "../common-crypto/key-passphrase.ts";
import { type UIAuthCallback } from "../interactive-auth.ts";
import { getHttpUriForMxc } from "../content-repo.ts";

const ALL_VERIFICATION_METHODS = [
    VerificationMethod.Sas,
    VerificationMethod.ScanQrCode,
    VerificationMethod.ShowQrCode,
    VerificationMethod.Reciprocate,
];

interface ISignableObject {
    signatures?: ISignatures;
    unsigned?: object;
}

/**
 * An implementation of {@link CryptoBackend} using the Rust matrix-sdk-crypto.
 *
 * @internal
 */
export class RustCrypto extends TypedEventEmitter<RustCryptoEvents, CryptoEventHandlerMap> implements CryptoBackend {
    /**
     * The number of iterations to use when deriving a recovery key from a passphrase.
     */
    private readonly RECOVERY_KEY_DERIVATION_ITERATIONS = 500000;

    private _trustCrossSignedDevices = true;
    private deviceIsolationMode: DeviceIsolationMode = new AllDevicesIsolationMode(false);

    /** whether {@link stop} has been called */
    private stopped = false;

    /** mapping of roomId → encryptor class */
    private roomEncryptors: Record<string, RoomEncryptor> = {};

    private eventDecryptor: EventDecryptor;
    private keyClaimManager: KeyClaimManager;
    private outgoingRequestProcessor: OutgoingRequestProcessor;
    private crossSigningIdentity: CrossSigningIdentity;
    private readonly backupManager: RustBackupManager;
    private outgoingRequestsManager: OutgoingRequestsManager;
    private readonly perSessionBackupDownloader: PerSessionKeyBackupDownloader;
    private readonly dehydratedDeviceManager: DehydratedDeviceManager;
    private readonly reemitter = new TypedReEmitter<RustCryptoEvents, CryptoEventHandlerMap>(this);

    public constructor(
        private readonly logger: Logger,

        /** The `OlmMachine` from the underlying rust crypto sdk. */
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,

        /**
         * Low-level HTTP interface: used to make outgoing requests required by the rust SDK.
         *
         * We expect it to set the access token, etc.
         */
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,

        /** The local user's User ID. */
        private readonly userId: string,

        /** The local user's Device ID. */
        _deviceId: string,

        /** Interface to server-side secret storage */
        private readonly secretStorage: ServerSideSecretStorage,

        /** Crypto callbacks provided by the application */
        private readonly cryptoCallbacks: CryptoCallbacks,
    ) {
        super();
        this.outgoingRequestProcessor = new OutgoingRequestProcessor(logger, olmMachine, http);
        this.outgoingRequestsManager = new OutgoingRequestsManager(
            this.logger,
            olmMachine,
            this.outgoingRequestProcessor,
        );

        this.keyClaimManager = new KeyClaimManager(olmMachine, this.outgoingRequestProcessor);

        this.backupManager = new RustBackupManager(logger, olmMachine, http, this.outgoingRequestProcessor);
        this.perSessionBackupDownloader = new PerSessionKeyBackupDownloader(
            this.logger,
            this.olmMachine,
            this.http,
            this.backupManager,
        );
        this.dehydratedDeviceManager = new DehydratedDeviceManager(
            this.logger,
            olmMachine,
            http,
            this.outgoingRequestProcessor,
            secretStorage,
        );
        this.eventDecryptor = new EventDecryptor(this.logger, olmMachine, this.perSessionBackupDownloader);

        // re-emit the events emitted by managers
        this.reemitter.reEmit(this.backupManager, [
            CryptoEvent.KeyBackupStatus,
            CryptoEvent.KeyBackupSessionsRemaining,
            CryptoEvent.KeyBackupFailed,
            CryptoEvent.KeyBackupDecryptionKeyCached,
        ]);
        this.reemitter.reEmit(this.dehydratedDeviceManager, [
            CryptoEvent.DehydratedDeviceCreated,
            CryptoEvent.DehydratedDeviceUploaded,
            CryptoEvent.RehydrationStarted,
            CryptoEvent.RehydrationProgress,
            CryptoEvent.RehydrationCompleted,
            CryptoEvent.RehydrationError,
            CryptoEvent.DehydrationKeyCached,
            CryptoEvent.DehydratedDeviceRotationError,
        ]);

        this.crossSigningIdentity = new CrossSigningIdentity(
            logger,
            olmMachine,
            this.outgoingRequestProcessor,
            secretStorage,
        );

        // Check and start in background the key backup connection
        this.checkKeyBackupAndEnable();
    }

    /**
     * Return the OlmMachine only if {@link RustCrypto#stop} has not been called.
     *
     * This allows us to better handle race conditions where the client is stopped before or during a crypto API call.
     *
     * @throws ClientStoppedError if {@link RustCrypto#stop} has been called.
     */
    private getOlmMachineOrThrow(): RustSdkCryptoJs.OlmMachine {
        if (this.stopped) {
            throw new ClientStoppedError();
        }
        return this.olmMachine;
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // CryptoBackend implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    public set globalErrorOnUnknownDevices(_v: boolean) {
        // Not implemented for rust crypto.
    }

    public get globalErrorOnUnknownDevices(): boolean {
        // Not implemented for rust crypto.
        return false;
    }

    public stop(): void {
        // stop() may be called multiple times, but attempting to close() the OlmMachine twice
        // will cause an error.
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        this.keyClaimManager.stop();
        this.backupManager.stop();
        this.outgoingRequestsManager.stop();
        this.perSessionBackupDownloader.stop();
        this.dehydratedDeviceManager.stop();

        // make sure we close() the OlmMachine; doing so means that all the Rust objects will be
        // cleaned up; in particular, the indexeddb connections will be closed, which means they
        // can then be deleted.
        this.olmMachine.close();
    }

    public async encryptEvent(event: MatrixEvent, _room: Room): Promise<void> {
        const roomId = event.getRoomId()!;
        const encryptor = this.roomEncryptors[roomId];

        if (!encryptor) {
            throw new Error(`Cannot encrypt event in unconfigured room ${roomId}`);
        }

        await encryptor.encryptEvent(event, this.globalBlacklistUnverifiedDevices, this.deviceIsolationMode);
    }

    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const roomId = event.getRoomId();
        if (!roomId) {
            // presumably, a to-device message. These are normally decrypted in preprocessToDeviceMessages
            // so the fact it has come back here suggests that decryption failed.
            //
            // once we drop support for the libolm crypto implementation, we can stop passing to-device messages
            // through decryptEvent and hence get rid of this case.
            throw new Error("to-device event was not decrypted in preprocessToDeviceMessages");
        }
        return await this.eventDecryptor.attemptEventDecryption(event, this.deviceIsolationMode);
    }

    /**
     * Implementation of {@link CryptoBackend#getBackupDecryptor}.
     */
    public async getBackupDecryptor(backupInfo: KeyBackupInfo, privKey: Uint8Array): Promise<BackupDecryptor> {
        if (!(privKey instanceof Uint8Array)) {
            throw new Error(`getBackupDecryptor: expects Uint8Array`);
        }

        if (backupInfo.algorithm != "m.megolm_backup.v1.curve25519-aes-sha2") {
            throw new Error(`getBackupDecryptor: Unsupported algorithm ${backupInfo.algorithm}`);
        }

        const backupDecryptionKey = RustSdkCryptoJs.BackupDecryptionKey.fromBase64(encodeBase64(privKey));
        if (!decryptionKeyMatchesKeyBackupInfo(backupDecryptionKey, backupInfo)) {
            throw new Error(`getBackupDecryptor: key backup on server does not match the decryption key`);
        }

        return this.backupManager.createBackupDecryptor(backupDecryptionKey);
    }

    /**
     * Implementation of {@link CryptoBackend#importBackedUpRoomKeys}.
     */
    public async importBackedUpRoomKeys(
        keys: IMegolmSessionData[],
        backupVersion: string,
        opts?: ImportRoomKeysOpts,
    ): Promise<void> {
        return await this.backupManager.importBackedUpRoomKeys(keys, backupVersion, opts);
    }

    /**
     * Implementation of {@link CryptoBackend.maybeAcceptKeyBundle}.
     */
    public async maybeAcceptKeyBundle(roomId: string, inviter: string): Promise<void> {
        // TODO: retry this if it gets interrupted or it fails.
        // TODO: do this in the background.
        // TODO: handle the bundle message arriving after the invite.

        const logger = new LogSpan(this.logger, `maybeAcceptKeyBundle(${roomId}, ${inviter})`);

        const bundleData = await this.olmMachine.getReceivedRoomKeyBundleData(
            new RustSdkCryptoJs.RoomId(roomId),
            new RustSdkCryptoJs.UserId(inviter),
        );
        if (!bundleData) {
            logger.info("No key bundle found for user");
            return;
        }

        logger.info(`Fetching key bundle ${bundleData.url}`);
        const url = getHttpUriForMxc(
            this.http.opts.baseUrl,
            bundleData.url,
            undefined,
            undefined,
            undefined,
            /* allowDirectLinks */ false,
            /* allowRedirects */ true,
            /* useAuthentication */ true,
        );
        let encryptedBundle: Blob;
        try {
            const bundleUrl = new URL(url);
            encryptedBundle = await this.http.authedRequest<Blob>(
                Method.Get,
                bundleUrl.pathname + bundleUrl.search,
                {},
                undefined,
                {
                    rawResponseBody: true,
                    prefix: "",
                },
            );
        } catch (err) {
            logger.warn(`Error downloading encrypted bundle from ${url}:`, err);
            throw err;
        }

        logger.info(`Received blob of length ${encryptedBundle.size}`);
        try {
            await this.olmMachine.receiveRoomKeyBundle(bundleData, new Uint8Array(await encryptedBundle.arrayBuffer()));
        } catch (err) {
            logger.warn(`Error receiving encrypted bundle:`, err);
            throw err;
        }
    }
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // CryptoApi implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    public globalBlacklistUnverifiedDevices = false;

    /**
     * Implementation of {@link CryptoApi#getVersion}.
     */
    public getVersion(): string {
        const versions = RustSdkCryptoJs.getVersions();
        return `Rust SDK ${versions.matrix_sdk_crypto} (${versions.git_sha}), Vodozemac ${versions.vodozemac}`;
    }

    /**
     * Implementation of {@link CryptoApi#setDeviceIsolationMode}.
     */
    public setDeviceIsolationMode(isolationMode: DeviceIsolationMode): void {
        this.deviceIsolationMode = isolationMode;
    }

    /**
     * Implementation of {@link CryptoApi#isEncryptionEnabledInRoom}.
     */
    public async isEncryptionEnabledInRoom(roomId: string): Promise<boolean> {
        const roomSettings: RustSdkCryptoJs.RoomSettings | undefined = await this.olmMachine.getRoomSettings(
            new RustSdkCryptoJs.RoomId(roomId),
        );
        return Boolean(roomSettings?.algorithm);
    }

    /**
     * Implementation of {@link CryptoApi#getOwnDeviceKeys}.
     */
    public async getOwnDeviceKeys(): Promise<OwnDeviceKeys> {
        const keys = this.olmMachine.identityKeys;
        return { ed25519: keys.ed25519.toBase64(), curve25519: keys.curve25519.toBase64() };
    }

    public prepareToEncrypt(room: Room): void {
        const encryptor = this.roomEncryptors[room.roomId];

        if (encryptor) {
            encryptor.prepareForEncryption(this.globalBlacklistUnverifiedDevices, this.deviceIsolationMode);
        }
    }

    public forceDiscardSession(roomId: string): Promise<void> {
        return this.roomEncryptors[roomId]?.forceDiscardSession();
    }

    public async exportRoomKeys(): Promise<IMegolmSessionData[]> {
        const raw = await this.olmMachine.exportRoomKeys(() => true);
        return JSON.parse(raw);
    }

    public async exportRoomKeysAsJson(): Promise<string> {
        return await this.olmMachine.exportRoomKeys(() => true);
    }

    public async importRoomKeys(keys: IMegolmSessionData[], opts?: ImportRoomKeysOpts): Promise<void> {
        return await this.backupManager.importRoomKeys(keys, opts);
    }

    public async importRoomKeysAsJson(keys: string, opts?: ImportRoomKeysOpts): Promise<void> {
        return await this.backupManager.importRoomKeysAsJson(keys, opts);
    }

    /**
     * Implementation of {@link CryptoApi.userHasCrossSigningKeys}.
     */
    public async userHasCrossSigningKeys(userId = this.userId, downloadUncached = false): Promise<boolean> {
        // TODO: could probably do with a more efficient way of doing this than returning the whole set and searching
        const rustTrackedUsers: Set<RustSdkCryptoJs.UserId> = await this.olmMachine.trackedUsers();
        let rustTrackedUser: RustSdkCryptoJs.UserId | undefined;
        for (const u of rustTrackedUsers) {
            if (userId === u.toString()) {
                rustTrackedUser = u;
                break;
            }
        }

        if (rustTrackedUser !== undefined) {
            if (userId === this.userId) {
                /* make sure we have an *up-to-date* idea of the user's cross-signing keys. This is important, because if we
                 * return "false" here, we will end up generating new cross-signing keys and replacing the existing ones.
                 */
                const request = this.olmMachine.queryKeysForUsers(
                    // clone as rust layer will take ownership and it's reused later
                    [rustTrackedUser.clone()],
                );
                await this.outgoingRequestProcessor.makeOutgoingRequest(request);
            }
            const userIdentity = await this.olmMachine.getIdentity(rustTrackedUser);
            userIdentity?.free();
            return userIdentity !== undefined;
        } else if (downloadUncached) {
            // Download the cross signing keys and check if the master key is available
            const keyResult = await this.downloadDeviceList(new Set([userId]));
            const keys = keyResult.master_keys?.[userId];

            // No master key
            if (!keys) return false;

            // `keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
            // We assume only a single key, and we want the bare form without type
            // prefix, so we select the values.
            return Boolean(Object.values(keys.keys)[0]);
        } else {
            return false;
        }
    }

    /**
     * Get the device information for the given list of users.
     *
     * @param userIds - The users to fetch.
     * @param downloadUncached - If true, download the device list for users whose device list we are not
     *    currently tracking. Defaults to false, in which case such users will not appear at all in the result map.
     *
     * @returns A map `{@link DeviceMap}`.
     */
    public async getUserDeviceInfo(userIds: string[], downloadUncached = false): Promise<DeviceMap> {
        const deviceMapByUserId = new Map<string, Map<string, Device>>();
        const rustTrackedUsers: Set<RustSdkCryptoJs.UserId> = await this.getOlmMachineOrThrow().trackedUsers();

        // Convert RustSdkCryptoJs.UserId to a `Set<string>`
        const trackedUsers = new Set<string>();
        rustTrackedUsers.forEach((rustUserId) => trackedUsers.add(rustUserId.toString()));

        // Keep untracked user to download their keys after
        const untrackedUsers: Set<string> = new Set();

        for (const userId of userIds) {
            // if this is a tracked user, we can just fetch the device list from the rust-sdk
            // (NB: this is probably ok even if we race with a leave event such that we stop tracking the user's
            // devices: the rust-sdk will return the last-known device list, which will be good enough.)
            if (trackedUsers.has(userId)) {
                deviceMapByUserId.set(userId, await this.getUserDevices(userId));
            } else {
                untrackedUsers.add(userId);
            }
        }

        // for any users whose device lists we are not tracking, fall back to downloading the device list
        // over HTTP.
        if (downloadUncached && untrackedUsers.size >= 1) {
            const queryResult = await this.downloadDeviceList(untrackedUsers);
            Object.entries(queryResult.device_keys).forEach(([userId, deviceKeys]) =>
                deviceMapByUserId.set(userId, deviceKeysToDeviceMap(deviceKeys)),
            );
        }

        return deviceMapByUserId;
    }

    /**
     * Get the device list for the given user from the olm machine
     * @param userId - Rust SDK UserId
     */
    private async getUserDevices(userId: string): Promise<Map<string, Device>> {
        const rustUserId = new RustSdkCryptoJs.UserId(userId);

        // For reasons I don't really understand, the Javascript FinalizationRegistry doesn't seem to run the
        // registered callbacks when `userDevices` goes out of scope, nor when the individual devices in the array
        // returned by `userDevices.devices` do so.
        //
        // This is particularly problematic, because each of those structures holds a reference to the
        // VerificationMachine, which in turn holds a reference to the IndexeddbCryptoStore. Hence, we end up leaking
        // open connections to the crypto store, which means the store can't be deleted on logout.
        //
        // To fix this, we explicitly call `.free` on each of the objects, which tells the rust code to drop the
        // allocated memory and decrement the refcounts for the crypto store.

        // Wait for up to a second for any in-flight device list requests to complete.
        // The reason for this isn't so much to avoid races (some level of raciness is
        // inevitable for this method) but to make testing easier.
        const userDevices: RustSdkCryptoJs.UserDevices = await this.olmMachine.getUserDevices(rustUserId, 1);
        try {
            const deviceArray: RustSdkCryptoJs.Device[] = userDevices.devices();
            try {
                return new Map(
                    deviceArray.map((device) => [device.deviceId.toString(), rustDeviceToJsDevice(device, rustUserId)]),
                );
            } finally {
                deviceArray.forEach((d) => d.free());
            }
        } finally {
            userDevices.free();
        }
    }

    /**
     * Download the given user keys by calling `/keys/query` request
     * @param untrackedUsers - download keys of these users
     */
    private async downloadDeviceList(untrackedUsers: Set<string>): Promise<IDownloadKeyResult> {
        const queryBody: IQueryKeysRequest = { device_keys: {} };
        untrackedUsers.forEach((user) => (queryBody.device_keys[user] = []));

        return await this.http.authedRequest(Method.Post, "/_matrix/client/v3/keys/query", undefined, queryBody, {
            prefix: "",
        });
    }

    /**
     * Implementation of {@link CryptoApi#getTrustCrossSignedDevices}.
     */
    public getTrustCrossSignedDevices(): boolean {
        return this._trustCrossSignedDevices;
    }

    /**
     * Implementation of {@link CryptoApi#setTrustCrossSignedDevices}.
     */
    public setTrustCrossSignedDevices(val: boolean): void {
        this._trustCrossSignedDevices = val;
        // TODO: legacy crypto goes through the list of known devices and emits DeviceVerificationChanged
        //  events. Maybe we need to do the same?
    }

    /**
     * Mark the given device as locally verified.
     *
     * Implementation of {@link CryptoApi#setDeviceVerified}.
     */
    public async setDeviceVerified(userId: string, deviceId: string, verified = true): Promise<void> {
        const device: RustSdkCryptoJs.Device | undefined = await this.olmMachine.getDevice(
            new RustSdkCryptoJs.UserId(userId),
            new RustSdkCryptoJs.DeviceId(deviceId),
        );

        if (!device) {
            throw new Error(`Unknown device ${userId}|${deviceId}`);
        }
        try {
            await device.setLocalTrust(
                verified ? RustSdkCryptoJs.LocalTrust.Verified : RustSdkCryptoJs.LocalTrust.Unset,
            );
        } finally {
            device.free();
        }
    }

    /**
     * Blindly cross-sign one of our other devices.
     *
     * Implementation of {@link CryptoApi#crossSignDevice}.
     */
    public async crossSignDevice(deviceId: string): Promise<void> {
        const device: RustSdkCryptoJs.Device | undefined = await this.olmMachine.getDevice(
            new RustSdkCryptoJs.UserId(this.userId),
            new RustSdkCryptoJs.DeviceId(deviceId),
        );
        if (!device) {
            throw new Error(`Unknown device ${deviceId}`);
        }
        try {
            const outgoingRequest: RustSdkCryptoJs.SignatureUploadRequest = await device.verify();
            await this.outgoingRequestProcessor.makeOutgoingRequest(outgoingRequest);
        } finally {
            device.free();
        }
    }

    /**
     * Implementation of {@link CryptoApi#getDeviceVerificationStatus}.
     */
    public async getDeviceVerificationStatus(
        userId: string,
        deviceId: string,
    ): Promise<DeviceVerificationStatus | null> {
        const device: RustSdkCryptoJs.Device | undefined = await this.olmMachine.getDevice(
            new RustSdkCryptoJs.UserId(userId),
            new RustSdkCryptoJs.DeviceId(deviceId),
        );

        if (!device) return null;
        try {
            return new DeviceVerificationStatus({
                signedByOwner: device.isCrossSignedByOwner(),
                crossSigningVerified: device.isCrossSigningTrusted(),
                localVerified: device.isLocallyTrusted(),
                trustCrossSignedDevices: this._trustCrossSignedDevices,
            });
        } finally {
            device.free();
        }
    }

    /**
     * Implementation of {@link CryptoApi#getUserVerificationStatus}.
     */
    public async getUserVerificationStatus(userId: string): Promise<UserVerificationStatus> {
        const userIdentity: RustSdkCryptoJs.OtherUserIdentity | RustSdkCryptoJs.OwnUserIdentity | undefined =
            await this.getOlmMachineOrThrow().getIdentity(new RustSdkCryptoJs.UserId(userId));
        if (userIdentity === undefined) {
            return new UserVerificationStatus(false, false, false);
        }

        const verified = userIdentity.isVerified();
        const wasVerified = userIdentity.wasPreviouslyVerified();
        const needsUserApproval =
            userIdentity instanceof RustSdkCryptoJs.OtherUserIdentity
                ? userIdentity.identityNeedsUserApproval()
                : false;
        userIdentity.free();
        return new UserVerificationStatus(verified, wasVerified, false, needsUserApproval);
    }

    /**
     * Implementation of {@link CryptoApi#pinCurrentUserIdentity}.
     */
    public async pinCurrentUserIdentity(userId: string): Promise<void> {
        const userIdentity: RustSdkCryptoJs.OtherUserIdentity | RustSdkCryptoJs.OwnUserIdentity | undefined =
            await this.getOlmMachineOrThrow().getIdentity(new RustSdkCryptoJs.UserId(userId));

        if (userIdentity === undefined) {
            throw new Error("Cannot pin identity of unknown user");
        }

        if (userIdentity instanceof RustSdkCryptoJs.OwnUserIdentity) {
            throw new Error("Cannot pin identity of own user");
        }

        await userIdentity.pinCurrentMasterKey();
    }

    /**
     * Implementation of {@link CryptoApi#withdrawVerificationRequirement}.
     */
    public async withdrawVerificationRequirement(userId: string): Promise<void> {
        const userIdentity: RustSdkCryptoJs.OtherUserIdentity | RustSdkCryptoJs.OwnUserIdentity | undefined =
            await this.getOlmMachineOrThrow().getIdentity(new RustSdkCryptoJs.UserId(userId));

        if (userIdentity === undefined) {
            throw new Error("Cannot withdraw verification of unknown user");
        }

        await userIdentity.withdrawVerification();
    }

    /**
     * Implementation of {@link CryptoApi#isCrossSigningReady}
     */
    public async isCrossSigningReady(): Promise<boolean> {
        const { privateKeysInSecretStorage, privateKeysCachedLocally } = await this.getCrossSigningStatus();
        const hasKeysInCache =
            Boolean(privateKeysCachedLocally.masterKey) &&
            Boolean(privateKeysCachedLocally.selfSigningKey) &&
            Boolean(privateKeysCachedLocally.userSigningKey);

        const identity = await this.getOwnIdentity();

        // Cross-signing is ready if the public identity is trusted, and the private keys
        // are either cached, or accessible via secret-storage.
        return !!identity?.isVerified() && (hasKeysInCache || privateKeysInSecretStorage);
    }

    /**
     * Implementation of {@link CryptoApi#getCrossSigningKeyId}
     */
    public async getCrossSigningKeyId(type: CrossSigningKey = CrossSigningKey.Master): Promise<string | null> {
        const userIdentity: RustSdkCryptoJs.OwnUserIdentity | undefined = await this.olmMachine.getIdentity(
            new RustSdkCryptoJs.UserId(this.userId),
        );
        if (!userIdentity) {
            // The public keys are not available on this device
            return null;
        }

        try {
            const crossSigningStatus: RustSdkCryptoJs.CrossSigningStatus = await this.olmMachine.crossSigningStatus();

            const privateKeysOnDevice =
                crossSigningStatus.hasMaster && crossSigningStatus.hasUserSigning && crossSigningStatus.hasSelfSigning;

            if (!privateKeysOnDevice) {
                // The private keys are not available on this device
                return null;
            }

            if (!userIdentity.isVerified()) {
                // We have both public and private keys, but they don't match!
                return null;
            }

            let key: string;
            switch (type) {
                case CrossSigningKey.Master:
                    key = userIdentity.masterKey;
                    break;
                case CrossSigningKey.SelfSigning:
                    key = userIdentity.selfSigningKey;
                    break;
                case CrossSigningKey.UserSigning:
                    key = userIdentity.userSigningKey;
                    break;
                default:
                    // Unknown type
                    return null;
            }

            const parsedKey: CrossSigningKeyInfo = JSON.parse(key);
            // `keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
            // We assume only a single key, and we want the bare form without type
            // prefix, so we select the values.
            return Object.values(parsedKey.keys)[0];
        } finally {
            userIdentity.free();
        }
    }

    /**
     * Implementation of {@link CryptoApi#bootstrapCrossSigning}
     */
    public async bootstrapCrossSigning(opts: BootstrapCrossSigningOpts): Promise<void> {
        await this.crossSigningIdentity.bootstrapCrossSigning(opts);
    }

    /**
     * Implementation of {@link CryptoApi#isSecretStorageReady}
     */
    public async isSecretStorageReady(): Promise<boolean> {
        // make sure that the cross-signing keys are stored
        const secretsToCheck: SecretStorageKey[] = [
            "m.cross_signing.master",
            "m.cross_signing.user_signing",
            "m.cross_signing.self_signing",
        ];

        // if key backup is active, we also need to check that the backup decryption key is stored
        const keyBackupEnabled = (await this.backupManager.getActiveBackupVersion()) != null;
        if (keyBackupEnabled) {
            secretsToCheck.push("m.megolm_backup.v1");
        }

        return secretStorageCanAccessSecrets(this.secretStorage, secretsToCheck);
    }

    /**
     * Implementation of {@link CryptoApi#bootstrapSecretStorage}
     */
    public async bootstrapSecretStorage({
        createSecretStorageKey,
        setupNewSecretStorage,
        setupNewKeyBackup,
    }: CreateSecretStorageOpts = {}): Promise<void> {
        // If an AES Key is already stored in the secret storage and setupNewSecretStorage is not set
        // we don't want to create a new key
        const isNewSecretStorageKeyNeeded = setupNewSecretStorage || !(await this.secretStorageHasAESKey());

        if (isNewSecretStorageKeyNeeded) {
            if (!createSecretStorageKey) {
                throw new Error("unable to create a new secret storage key, createSecretStorageKey is not set");
            }

            // Create a new storage key and add it to secret storage
            this.logger.info("bootstrapSecretStorage: creating new secret storage key");
            const recoveryKey = await createSecretStorageKey();
            if (!recoveryKey) {
                throw new Error("createSecretStorageKey() callback did not return a secret storage key");
            }
            await this.addSecretStorageKeyToSecretStorage(recoveryKey);
        }

        const crossSigningPrivateKeys: RustSdkCryptoJs.CrossSigningKeyExport | undefined =
            await this.olmMachine.exportCrossSigningKeys();
        const hasPrivateKeys =
            crossSigningPrivateKeys &&
            crossSigningPrivateKeys.masterKey !== undefined &&
            crossSigningPrivateKeys.self_signing_key !== undefined &&
            crossSigningPrivateKeys.userSigningKey !== undefined;

        // If we have cross-signing private keys cached, store them in secret
        // storage if they are not there already.
        if (
            hasPrivateKeys &&
            (isNewSecretStorageKeyNeeded || !(await secretStorageContainsCrossSigningKeys(this.secretStorage)))
        ) {
            this.logger.info("bootstrapSecretStorage: cross-signing keys not yet exported; doing so now.");

            await this.secretStorage.store("m.cross_signing.master", crossSigningPrivateKeys.masterKey);
            await this.secretStorage.store("m.cross_signing.user_signing", crossSigningPrivateKeys.userSigningKey);
            await this.secretStorage.store("m.cross_signing.self_signing", crossSigningPrivateKeys.self_signing_key);
        }

        // likewise with the key backup key: if we have one, store it in secret storage (if it's not already there)
        // also don't bother storing it if we're about to set up a new backup
        if (!setupNewKeyBackup) {
            await this.saveBackupKeyToStorage();
        } else {
            await this.resetKeyBackup();
        }
    }

    /**
     * If we have a backup key for the current, trusted backup in cache,
     * save it to secret storage.
     */
    private async saveBackupKeyToStorage(): Promise<void> {
        const keyBackupInfo = await this.backupManager.getServerBackupInfo();
        if (!keyBackupInfo || !keyBackupInfo.version) {
            this.logger.info("Not saving backup key to secret storage: no backup info");
            return;
        }

        const backupKeys: RustSdkCryptoJs.BackupKeys = await this.olmMachine.getBackupKeys();
        if (!backupKeys.decryptionKey) {
            this.logger.info("Not saving backup key to secret storage: no backup key");
            return;
        }

        if (!decryptionKeyMatchesKeyBackupInfo(backupKeys.decryptionKey, keyBackupInfo)) {
            this.logger.info("Not saving backup key to secret storage: decryption key does not match backup info");
            return;
        }

        const backupKeyBase64 = backupKeys.decryptionKey.toBase64();

        await this.secretStorage.store("m.megolm_backup.v1", backupKeyBase64);
    }

    /**
     * Add the secretStorage key to the secret storage
     * - The secret storage key must have the `keyInfo` field filled
     * - The secret storage key is set as the default key of the secret storage
     * - Call `cryptoCallbacks.cacheSecretStorageKey` when done
     *
     * @param secretStorageKey - The secret storage key to add in the secret storage.
     */
    private async addSecretStorageKeyToSecretStorage(secretStorageKey: GeneratedSecretStorageKey): Promise<void> {
        const secretStorageKeyObject = await this.secretStorage.addKey(SECRET_STORAGE_ALGORITHM_V1_AES, {
            passphrase: secretStorageKey.keyInfo?.passphrase,
            name: secretStorageKey.keyInfo?.name,
            key: secretStorageKey.privateKey,
        });

        await this.secretStorage.setDefaultKeyId(secretStorageKeyObject.keyId);

        this.cryptoCallbacks.cacheSecretStorageKey?.(
            secretStorageKeyObject.keyId,
            secretStorageKeyObject.keyInfo,
            secretStorageKey.privateKey,
        );
    }

    /**
     * Check if a secret storage AES Key is already added in secret storage
     *
     * @returns True if an AES key is in the secret storage
     */
    private async secretStorageHasAESKey(): Promise<boolean> {
        // See if we already have an AES secret-storage key.
        const secretStorageKeyTuple = await this.secretStorage.getKey();

        if (!secretStorageKeyTuple) return false;

        const [, keyInfo] = secretStorageKeyTuple;

        // Check if the key is an AES key
        return keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES;
    }

    /**
     * Implementation of {@link CryptoApi#getCrossSigningStatus}
     */
    public async getCrossSigningStatus(): Promise<CrossSigningStatus> {
        const userIdentity: RustSdkCryptoJs.OwnUserIdentity | null = await this.getOlmMachineOrThrow().getIdentity(
            new RustSdkCryptoJs.UserId(this.userId),
        );

        const publicKeysOnDevice =
            Boolean(userIdentity?.masterKey) &&
            Boolean(userIdentity?.selfSigningKey) &&
            Boolean(userIdentity?.userSigningKey);
        userIdentity?.free();

        const privateKeysInSecretStorage = await secretStorageContainsCrossSigningKeys(this.secretStorage);
        const crossSigningStatus: RustSdkCryptoJs.CrossSigningStatus | null =
            await this.getOlmMachineOrThrow().crossSigningStatus();

        return {
            publicKeysOnDevice,
            privateKeysInSecretStorage,
            privateKeysCachedLocally: {
                masterKey: Boolean(crossSigningStatus?.hasMaster),
                userSigningKey: Boolean(crossSigningStatus?.hasUserSigning),
                selfSigningKey: Boolean(crossSigningStatus?.hasSelfSigning),
            },
        };
    }

    /**
     * Implementation of {@link CryptoApi#createRecoveryKeyFromPassphrase}
     */
    public async createRecoveryKeyFromPassphrase(password?: string): Promise<GeneratedSecretStorageKey> {
        if (password) {
            // Generate the key from the passphrase
            // first we generate a random salt
            const salt = secureRandomString(32);
            // then we derive the key from the passphrase
            const recoveryKey = await deriveRecoveryKeyFromPassphrase(
                password,
                salt,
                this.RECOVERY_KEY_DERIVATION_ITERATIONS,
            );
            return {
                keyInfo: {
                    passphrase: {
                        algorithm: "m.pbkdf2",
                        iterations: this.RECOVERY_KEY_DERIVATION_ITERATIONS,
                        salt,
                    },
                },
                privateKey: recoveryKey,
                encodedPrivateKey: encodeRecoveryKey(recoveryKey),
            };
        } else {
            // Using the navigator crypto API to generate the private key
            const key = new Uint8Array(32);
            globalThis.crypto.getRandomValues(key);
            return {
                privateKey: key,
                encodedPrivateKey: encodeRecoveryKey(key),
            };
        }
    }

    /**
     * Implementation of {@link CryptoApi#getEncryptionInfoForEvent}.
     */
    public async getEncryptionInfoForEvent(event: MatrixEvent): Promise<EventEncryptionInfo | null> {
        return this.eventDecryptor.getEncryptionInfoForEvent(event);
    }

    /**
     * Returns to-device verification requests that are already in progress for the given user id.
     *
     * Implementation of {@link CryptoApi#getVerificationRequestsToDeviceInProgress}
     *
     * @param userId - the ID of the user to query
     *
     * @returns the VerificationRequests that are in progress
     */
    public getVerificationRequestsToDeviceInProgress(userId: string): VerificationRequest[] {
        const requests: RustSdkCryptoJs.VerificationRequest[] = this.olmMachine.getVerificationRequests(
            new RustSdkCryptoJs.UserId(userId),
        );
        return requests
            .filter((request) => request.roomId === undefined)
            .map((request) => this.makeVerificationRequest(request));
    }

    /**
     * Finds a DM verification request that is already in progress for the given room id
     *
     * Implementation of {@link CryptoApi#findVerificationRequestDMInProgress}
     *
     * @param roomId - the room to use for verification
     * @param userId - search the verification request for the given user
     *
     * @returns the VerificationRequest that is in progress, if any
     *
     */
    public findVerificationRequestDMInProgress(roomId: string, userId?: string): VerificationRequest | undefined {
        if (!userId) throw new Error("missing userId");

        const requests: RustSdkCryptoJs.VerificationRequest[] = this.olmMachine.getVerificationRequests(
            new RustSdkCryptoJs.UserId(userId),
        );

        // Search for the verification request for the given room id
        const request = requests.find((request) => request.roomId?.toString() === roomId);

        if (request) {
            return this.makeVerificationRequest(request);
        }
    }

    /**
     * Implementation of {@link CryptoApi#requestVerificationDM}
     */
    public async requestVerificationDM(userId: string, roomId: string): Promise<VerificationRequest> {
        const userIdentity: RustSdkCryptoJs.OtherUserIdentity | undefined = await this.olmMachine.getIdentity(
            new RustSdkCryptoJs.UserId(userId),
        );

        if (!userIdentity) throw new Error(`unknown userId ${userId}`);

        try {
            // Transform the verification methods into rust objects
            const methods = this._supportedVerificationMethods.map((method) =>
                verificationMethodIdentifierToMethod(method),
            );
            // Get the request content to send to the DM room
            const verificationEventContent: string = await userIdentity.verificationRequestContent(methods);

            // Send the request content to send to the DM room
            const eventId = await this.sendVerificationRequestContent(roomId, verificationEventContent);

            // Get a verification request
            const request: RustSdkCryptoJs.VerificationRequest = await userIdentity.requestVerification(
                new RustSdkCryptoJs.RoomId(roomId),
                new RustSdkCryptoJs.EventId(eventId),
                methods,
            );
            return this.makeVerificationRequest(request);
        } finally {
            userIdentity.free();
        }
    }

    /**
     * Send the verification content to a room
     * See https://spec.matrix.org/v1.7/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid
     *
     * Prefer to use {@link OutgoingRequestProcessor.makeOutgoingRequest} when dealing with {@link RustSdkCryptoJs.RoomMessageRequest}
     *
     * @param roomId - the targeted room
     * @param verificationEventContent - the request body.
     *
     * @returns the event id
     */
    private async sendVerificationRequestContent(roomId: string, verificationEventContent: string): Promise<string> {
        const txId = secureRandomString(32);
        // Send the verification request content to the DM room
        const { event_id: eventId } = await this.http.authedRequest<{ event_id: string }>(
            Method.Put,
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txId)}`,
            undefined,
            verificationEventContent,
            {
                prefix: "",
            },
        );

        return eventId;
    }

    /**
     * The verification methods we offer to the other side during an interactive verification.
     */
    private _supportedVerificationMethods: string[] = ALL_VERIFICATION_METHODS;

    /**
     * Set the verification methods we offer to the other side during an interactive verification.
     *
     * If `undefined`, we will offer all the methods supported by the Rust SDK.
     */
    public setSupportedVerificationMethods(methods: string[] | undefined): void {
        // by default, the Rust SDK does not offer `m.qr_code.scan.v1`, but we do want to offer that.
        this._supportedVerificationMethods = methods ?? ALL_VERIFICATION_METHODS;
    }

    /**
     * Send a verification request to our other devices.
     *
     * If a verification is already in flight, returns it. Otherwise, initiates a new one.
     *
     * Implementation of {@link CryptoApi#requestOwnUserVerification}.
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    public async requestOwnUserVerification(): Promise<VerificationRequest> {
        const userIdentity: RustSdkCryptoJs.OwnUserIdentity | undefined = await this.olmMachine.getIdentity(
            new RustSdkCryptoJs.UserId(this.userId),
        );
        if (userIdentity === undefined) {
            throw new Error("cannot request verification for this device when there is no existing cross-signing key");
        }

        try {
            const [request, outgoingRequest]: [RustSdkCryptoJs.VerificationRequest, RustSdkCryptoJs.ToDeviceRequest] =
                await userIdentity.requestVerification(
                    this._supportedVerificationMethods.map(verificationMethodIdentifierToMethod),
                );
            await this.outgoingRequestProcessor.makeOutgoingRequest(outgoingRequest);
            return this.makeVerificationRequest(request);
        } finally {
            userIdentity.free();
        }
    }

    /**
     * Request an interactive verification with the given device.
     *
     * If a verification is already in flight, returns it. Otherwise, initiates a new one.
     *
     * Implementation of {@link CryptoApi#requestDeviceVerification}.
     *
     * @param userId - ID of the owner of the device to verify
     * @param deviceId - ID of the device to verify
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    public async requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest> {
        const device: RustSdkCryptoJs.Device | undefined = await this.olmMachine.getDevice(
            new RustSdkCryptoJs.UserId(userId),
            new RustSdkCryptoJs.DeviceId(deviceId),
        );

        if (!device) {
            throw new Error("Not a known device");
        }

        try {
            const [request, outgoingRequest] = device.requestVerification(
                this._supportedVerificationMethods.map(verificationMethodIdentifierToMethod),
            );
            await this.outgoingRequestProcessor.makeOutgoingRequest(outgoingRequest);
            return this.makeVerificationRequest(request);
        } finally {
            device.free();
        }
    }

    /**
     * Fetch the backup decryption key we have saved in our store.
     *
     * Implementation of {@link CryptoApi#getSessionBackupPrivateKey}.
     *
     * @returns the key, if any, or null
     */
    public async getSessionBackupPrivateKey(): Promise<Uint8Array | null> {
        const backupKeys: RustSdkCryptoJs.BackupKeys = await this.olmMachine.getBackupKeys();
        if (!backupKeys.decryptionKey) return null;
        return decodeBase64(backupKeys.decryptionKey.toBase64());
    }

    /**
     * Store the backup decryption key.
     *
     * Implementation of {@link CryptoApi#storeSessionBackupPrivateKey}.
     *
     * @param key - the backup decryption key
     * @param version - the backup version for this key.
     */
    public async storeSessionBackupPrivateKey(key: Uint8Array, version?: string): Promise<void> {
        const base64Key = encodeBase64(key);

        if (!version) {
            throw new Error("storeSessionBackupPrivateKey: version is required");
        }

        await this.backupManager.saveBackupDecryptionKey(
            RustSdkCryptoJs.BackupDecryptionKey.fromBase64(base64Key),
            version,
        );
    }

    /**
     * Implementation of {@link CryptoApi#loadSessionBackupPrivateKeyFromSecretStorage}.
     */
    public async loadSessionBackupPrivateKeyFromSecretStorage(): Promise<void> {
        const backupKey = await this.secretStorage.get("m.megolm_backup.v1");
        if (!backupKey) {
            throw new Error("loadSessionBackupPrivateKeyFromSecretStorage: missing decryption key in secret storage");
        }

        const keyBackupInfo = await this.backupManager.getServerBackupInfo();
        if (!keyBackupInfo || !keyBackupInfo.version) {
            throw new Error("loadSessionBackupPrivateKeyFromSecretStorage: unable to get backup version");
        }

        const backupDecryptionKey = RustSdkCryptoJs.BackupDecryptionKey.fromBase64(backupKey);
        if (!decryptionKeyMatchesKeyBackupInfo(backupDecryptionKey, keyBackupInfo)) {
            throw new Error("loadSessionBackupPrivateKeyFromSecretStorage: decryption key does not match backup info");
        }

        await this.backupManager.saveBackupDecryptionKey(backupDecryptionKey, keyBackupInfo.version);
    }

    /**
     * Get the current status of key backup.
     *
     * Implementation of {@link CryptoApi#getActiveSessionBackupVersion}.
     */
    public async getActiveSessionBackupVersion(): Promise<string | null> {
        return await this.backupManager.getActiveBackupVersion();
    }

    /**
     * Implementation of {@link CryptoApi#getKeyBackupInfo}.
     */
    public async getKeyBackupInfo(): Promise<KeyBackupInfo | null> {
        return (await this.backupManager.getServerBackupInfo()) || null;
    }

    /**
     * Determine if a key backup can be trusted.
     *
     * Implementation of {@link CryptoApi#isKeyBackupTrusted}.
     */
    public async isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo> {
        return await this.backupManager.isKeyBackupTrusted(info);
    }

    /**
     * Force a re-check of the key backup and enable/disable it as appropriate.
     *
     * Implementation of {@link CryptoApi#checkKeyBackupAndEnable}.
     */
    public async checkKeyBackupAndEnable(): Promise<KeyBackupCheck | null> {
        return await this.backupManager.checkKeyBackupAndEnable(true);
    }

    /**
     * Implementation of {@link CryptoApi#deleteKeyBackupVersion}.
     */
    public async deleteKeyBackupVersion(version: string): Promise<void> {
        await this.backupManager.deleteKeyBackupVersion(version);
    }

    /**
     * Implementation of {@link CryptoApi#resetKeyBackup}.
     */
    public async resetKeyBackup(): Promise<void> {
        const backupInfo = await this.backupManager.setupKeyBackup((o) => this.signObject(o));

        // we want to store the private key in 4S
        // need to check if 4S is set up?
        if (await this.secretStorageHasAESKey()) {
            await this.secretStorage.store("m.megolm_backup.v1", backupInfo.decryptionKey.toBase64());
        }

        // we can check and start async
        this.checkKeyBackupAndEnable();
    }

    /**
     * Implementation of {@link CryptoApi#disableKeyStorage}.
     */
    public async disableKeyStorage(): Promise<void> {
        // Get the key backup version we're using
        const info = await this.getKeyBackupInfo();
        if (info?.version) {
            await this.deleteKeyBackupVersion(info.version);
        } else {
            this.logger.error("Can't delete key backup version: no version available");
        }

        // also turn off 4S, since this is also storing keys on the server.
        await this.deleteSecretStorage();

        await this.dehydratedDeviceManager.delete();
    }

    /**
     * Signs the given object with the current device and current identity (if available).
     * As defined in {@link https://spec.matrix.org/v1.8/appendices/#signing-json | Signing JSON}.
     *
     * Helper for {@link RustCrypto#resetKeyBackup}.
     *
     * @param obj - The object to sign
     */
    private async signObject<T extends ISignableObject & object>(obj: T): Promise<void> {
        const sigs = new Map(Object.entries(obj.signatures || {}));
        const unsigned = obj.unsigned;

        delete obj.signatures;
        delete obj.unsigned;

        const userSignatures = sigs.get(this.userId) || {};

        const canonalizedJson = anotherjson.stringify(obj);
        const signatures: RustSdkCryptoJs.Signatures = await this.olmMachine.sign(canonalizedJson);

        const map = JSON.parse(signatures.asJSON());

        sigs.set(this.userId, { ...userSignatures, ...map[this.userId] });

        if (unsigned !== undefined) obj.unsigned = unsigned;
        obj.signatures = Object.fromEntries(sigs.entries());
    }

    /**
     * Implementation of {@link CryptoApi#restoreKeyBackupWithPassphrase}.
     */
    public async restoreKeyBackupWithPassphrase(
        passphrase: string,
        opts?: KeyBackupRestoreOpts,
    ): Promise<KeyBackupRestoreResult> {
        const backupInfo = await this.backupManager.getServerBackupInfo();
        if (!backupInfo?.version) {
            throw new Error("No backup info available");
        }

        const privateKey = await keyFromAuthData(backupInfo.auth_data, passphrase);

        // Cache the key
        await this.storeSessionBackupPrivateKey(privateKey, backupInfo.version);
        return this.restoreKeyBackup(opts);
    }

    /**
     * Implementation of {@link CryptoApi#restoreKeyBackup}.
     */
    public async restoreKeyBackup(opts?: KeyBackupRestoreOpts): Promise<KeyBackupRestoreResult> {
        // Get the decryption key from the crypto store
        const backupKeys: RustSdkCryptoJs.BackupKeys = await this.olmMachine.getBackupKeys();
        const { decryptionKey, backupVersion } = backupKeys;
        if (!decryptionKey || !backupVersion) throw new Error("No decryption key found in crypto store");

        const decodedDecryptionKey = decodeBase64(decryptionKey.toBase64());

        const backupInfo = await this.backupManager.requestKeyBackupVersion(backupVersion);
        if (!backupInfo) throw new Error(`Backup version to restore ${backupVersion} not found on server`);

        const backupDecryptor = await this.getBackupDecryptor(backupInfo, decodedDecryptionKey);

        try {
            opts?.progressCallback?.({
                stage: ImportRoomKeyStage.Fetch,
            });

            return await this.backupManager.restoreKeyBackup(backupVersion, backupDecryptor, opts);
        } finally {
            // Free to avoid to keep in memory the decryption key stored in it. To avoid to exposing it to an attacker.
            backupDecryptor.free();
        }
    }

    /**
     * Implementation of {@link CryptoApi#isDehydrationSupported}.
     */
    public async isDehydrationSupported(): Promise<boolean> {
        return await this.dehydratedDeviceManager.isSupported();
    }

    /**
     * Implementation of {@link CryptoApi#startDehydration}.
     */
    public async startDehydration(opts: StartDehydrationOpts | boolean = {}): Promise<void> {
        if (!(await this.isCrossSigningReady()) || !(await this.isSecretStorageReady())) {
            throw new Error("Device dehydration requires cross-signing and secret storage to be set up");
        }
        return await this.dehydratedDeviceManager.start(opts || {});
    }

    /**
     * Implementation of {@link CryptoApi#importSecretsBundle}.
     */
    public async importSecretsBundle(
        secrets: Parameters<NonNullable<CryptoApi["importSecretsBundle"]>>[0],
    ): Promise<void> {
        const secretsBundle = RustSdkCryptoJs.SecretsBundle.from_json(secrets);
        await this.getOlmMachineOrThrow().importSecretsBundle(secretsBundle); // this method frees the SecretsBundle
    }

    /**
     * Implementation of {@link CryptoApi#exportSecretsBundle}.
     */
    public async exportSecretsBundle(): ReturnType<NonNullable<CryptoApi["exportSecretsBundle"]>> {
        const secretsBundle = await this.getOlmMachineOrThrow().exportSecretsBundle();
        const secrets = secretsBundle.to_json();
        secretsBundle.free();
        return secrets;
    }

    /**
     * Implementation of {@link CryptoApi#encryptToDeviceMessages}.
     */
    public async encryptToDeviceMessages(
        eventType: string,
        devices: { userId: string; deviceId: string }[],
        payload: ToDevicePayload,
    ): Promise<ToDeviceBatch> {
        const logger = new LogSpan(this.logger, "encryptToDeviceMessages");
        const uniqueUsers = new Set(devices.map(({ userId }) => userId));

        // This will ensure we have Olm sessions for all of the users' devices.
        // However, we only care about some of the devices.
        // So, perhaps we can optimise this later on.
        await this.keyClaimManager.ensureSessionsForUsers(
            logger,
            Array.from(uniqueUsers).map((userId) => new RustSdkCryptoJs.UserId(userId)),
        );
        const batch: ToDeviceBatch = {
            batch: [],
            eventType: EventType.RoomMessageEncrypted,
        };

        await Promise.all(
            devices.map(async ({ userId, deviceId }) => {
                const device: RustSdkCryptoJs.Device | undefined = await this.olmMachine.getDevice(
                    new RustSdkCryptoJs.UserId(userId),
                    new RustSdkCryptoJs.DeviceId(deviceId),
                );

                if (device) {
                    const encryptedPayload = JSON.parse(await device.encryptToDeviceEvent(eventType, payload));
                    batch.batch.push({
                        deviceId,
                        userId,
                        payload: encryptedPayload,
                    });
                } else {
                    this.logger.warn(`encryptToDeviceMessages: unknown device ${userId}:${deviceId}`);
                }
            }),
        );

        return batch;
    }

    /**
     * Implementation of {@link CryptoApi#resetEncryption}.
     */
    public async resetEncryption(authUploadDeviceSigningKeys: UIAuthCallback<void>): Promise<void> {
        this.logger.debug("resetEncryption: resetting encryption");

        // Delete the dehydrated device, since any existing one will be signed
        // by the wrong cross-signing key
        this.dehydratedDeviceManager.delete();

        // Disable backup, and delete all the backups from the server
        await this.backupManager.deleteAllKeyBackupVersions();

        await this.deleteSecretStorage();

        // Reset the cross-signing keys
        await this.crossSigningIdentity.bootstrapCrossSigning({
            setupNewCrossSigning: true,
            authUploadDeviceSigningKeys,
        });

        // Create a new key backup
        await this.resetKeyBackup();

        this.logger.debug("resetEncryption: ended");
    }

    /**
     * Removes the secret storage key, default key pointer and all (known) secret storage data
     * from the user's account data
     */
    private async deleteSecretStorage(): Promise<void> {
        // Remove the stored secrets in the secret storage
        await this.secretStorage.store("m.cross_signing.master", null);
        await this.secretStorage.store("m.cross_signing.self_signing", null);
        await this.secretStorage.store("m.cross_signing.user_signing", null);
        await this.secretStorage.store("m.megolm_backup.v1", null);

        // Remove the recovery key
        const defaultKeyId = await this.secretStorage.getDefaultKeyId();
        if (defaultKeyId) await this.secretStorage.store(`m.secret_storage.key.${defaultKeyId}`, null);
        // Disable the recovery key and the secret storage
        await this.secretStorage.setDefaultKeyId(null);
    }

    /**
     * Implementation of {@link CryptoApi#shareRoomHistoryWithUser}.
     */
    public async shareRoomHistoryWithUser(roomId: string, userId: string): Promise<void> {
        const logger = new LogSpan(this.logger, `shareRoomHistoryWithUser(${roomId}, ${userId})`);

        // 0. We can only share room history if our user has set up cross-signing.
        const identity = await this.getOwnIdentity();
        if (!identity?.isVerified()) {
            logger.warn(
                "Not sharing message history as the current device is not verified by our cross-signing identity",
            );
            return;
        }

        logger.info("Sharing message history");

        // 1. Construct the key bundle
        const bundle = await this.getOlmMachineOrThrow().buildRoomKeyBundle(new RustSdkCryptoJs.RoomId(roomId));
        if (!bundle) {
            logger.info("No keys to share");
            return;
        }

        // 2. Upload the encrypted bundle to the server
        const uploadResponse = await this.http.uploadContent(bundle.encryptedData);
        logger.info(`Uploaded encrypted key blob: ${JSON.stringify(uploadResponse)}`);

        // 3. We may not share a room with the user, so get a fresh list of devices for the invited user.
        const req = this.getOlmMachineOrThrow().queryKeysForUsers([new RustSdkCryptoJs.UserId(userId)]);
        await this.outgoingRequestProcessor.makeOutgoingRequest(req);

        // 4. Establish Olm sessions with all of the recipient's devices.
        await this.keyClaimManager.ensureSessionsForUsers(logger, [new RustSdkCryptoJs.UserId(userId)]);

        // 5. Send to-device messages to the recipient to share the keys.
        const requests = await this.getOlmMachineOrThrow().shareRoomKeyBundleData(
            new RustSdkCryptoJs.UserId(userId),
            new RustSdkCryptoJs.RoomId(roomId),
            uploadResponse.content_uri,
            bundle.mediaEncryptionInfo,
            RustSdkCryptoJs.CollectStrategy.identityBasedStrategy(),
        );
        for (const req of requests) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // SyncCryptoCallbacks implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Apply sync changes to the olm machine
     * @param events - the received to-device messages
     * @param oneTimeKeysCounts - the received one time key counts
     * @param unusedFallbackKeys - the received unused fallback keys
     * @param devices - the received device list updates
     * @returns A list of processed to-device messages.
     */
    private async receiveSyncChanges({
        events,
        oneTimeKeysCounts = new Map<string, number>(),
        unusedFallbackKeys,
        devices = new RustSdkCryptoJs.DeviceLists(),
    }: {
        events?: IToDeviceEvent[];
        oneTimeKeysCounts?: Map<string, number>;
        unusedFallbackKeys?: Set<string>;
        devices?: RustSdkCryptoJs.DeviceLists;
    }): Promise<RustSdkCryptoJs.ProcessedToDeviceEvent[]> {
        return await this.olmMachine.receiveSyncChanges(
            events ? JSON.stringify(events) : "[]",
            devices,
            oneTimeKeysCounts,
            unusedFallbackKeys,
        );
    }

    /** called by the sync loop to preprocess incoming to-device messages
     *
     * @param events - the received to-device messages
     * @returns A list of preprocessed to-device messages.
     */
    public async preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<ReceivedToDeviceMessage[]> {
        // send the received to-device messages into receiveSyncChanges. We have no info on device-list changes,
        // one-time-keys, or fallback keys, so just pass empty data.
        const processed = await this.receiveSyncChanges({ events });

        const received: ReceivedToDeviceMessage[] = [];

        for (const message of processed) {
            const parsedMessage: IToDeviceEvent = JSON.parse(message.rawEvent);

            // look for interesting to-device messages
            if (parsedMessage.type === EventType.KeyVerificationRequest) {
                const sender = parsedMessage.sender;
                const transactionId = parsedMessage.content.transaction_id;
                if (transactionId && sender) {
                    this.onIncomingKeyVerificationRequest(sender, transactionId);
                }
            }

            switch (message.type) {
                case RustSdkCryptoJs.ProcessedToDeviceEventType.Decrypted: {
                    const encryptionInfo = (message as RustSdkCryptoJs.DecryptedToDeviceEvent).encryptionInfo;
                    received.push({
                        message: parsedMessage,
                        encryptionInfo: {
                            sender: encryptionInfo.sender.toString(),
                            senderDevice: encryptionInfo.senderDevice?.toString(),
                            senderCurve25519KeyBase64: encryptionInfo.senderCurve25519Key,
                            senderVerified: encryptionInfo.isSenderVerified(),
                        },
                    });
                    break;
                }
                case RustSdkCryptoJs.ProcessedToDeviceEventType.PlainText: {
                    received.push({
                        message: parsedMessage,
                        encryptionInfo: null,
                    });
                    break;
                }
                case RustSdkCryptoJs.ProcessedToDeviceEventType.UnableToDecrypt:
                    // ignore messages we cannot decrypt
                    break;
                case RustSdkCryptoJs.ProcessedToDeviceEventType.Invalid:
                    // ignore invalid messages
                    break;
            }
        }

        return received;
    }

    /** called by the sync loop to process one time key counts and unused fallback keys
     *
     * @param oneTimeKeysCounts - the received one time key counts
     * @param unusedFallbackKeys - the received unused fallback keys
     */
    public async processKeyCounts(
        oneTimeKeysCounts?: Record<string, number>,
        unusedFallbackKeys?: string[],
    ): Promise<void> {
        const mapOneTimeKeysCount = oneTimeKeysCounts && new Map<string, number>(Object.entries(oneTimeKeysCounts));
        const setUnusedFallbackKeys = unusedFallbackKeys && new Set<string>(unusedFallbackKeys);

        if (mapOneTimeKeysCount !== undefined || setUnusedFallbackKeys !== undefined) {
            await this.receiveSyncChanges({
                oneTimeKeysCounts: mapOneTimeKeysCount,
                unusedFallbackKeys: setUnusedFallbackKeys,
            });
        }
    }

    /** called by the sync loop to process the notification that device lists have
     * been changed.
     *
     * @param deviceLists - device_lists field from /sync
     */
    public async processDeviceLists(deviceLists: IDeviceLists): Promise<void> {
        const devices = new RustSdkCryptoJs.DeviceLists(
            deviceLists.changed?.map((userId) => new RustSdkCryptoJs.UserId(userId)),
            deviceLists.left?.map((userId) => new RustSdkCryptoJs.UserId(userId)),
        );
        await this.receiveSyncChanges({ devices });
    }

    /** called by the sync loop on m.room.encrypted events
     *
     * @param room - in which the event was received
     * @param event - encryption event to be processed
     */
    public async onCryptoEvent(room: Room, event: MatrixEvent): Promise<void> {
        const config = event.getContent();
        const settings = new RustSdkCryptoJs.RoomSettings();

        if (config.algorithm === "m.megolm.v1.aes-sha2") {
            settings.algorithm = RustSdkCryptoJs.EncryptionAlgorithm.MegolmV1AesSha2;
        } else {
            // Among other situations, this happens if the crypto state event is redacted.
            this.logger.warn(`Room ${room.roomId}: ignoring crypto event with invalid algorithm ${config.algorithm}`);
            return;
        }

        try {
            settings.sessionRotationPeriodMs = config.rotation_period_ms;
            settings.sessionRotationPeriodMessages = config.rotation_period_msgs;
            await this.olmMachine.setRoomSettings(new RustSdkCryptoJs.RoomId(room.roomId), settings);
        } catch (e) {
            this.logger.warn(`Room ${room.roomId}: ignoring crypto event which caused error: ${e}`);
            return;
        }

        // If we got this far, the SDK found the event acceptable.
        // We need to either create or update the active RoomEncryptor.
        const existingEncryptor = this.roomEncryptors[room.roomId];
        if (existingEncryptor) {
            existingEncryptor.onCryptoEvent(config);
        } else {
            this.roomEncryptors[room.roomId] = new RoomEncryptor(
                this.logger.getChild(`[${room.roomId} encryption]`),
                this.olmMachine,
                this.keyClaimManager,
                this.outgoingRequestsManager,
                room,
                config,
            );
        }
    }

    /** called by the sync loop after processing each sync.
     *
     *
     * @param syncState - information on the completed sync.
     */
    public onSyncCompleted(syncState: OnSyncCompletedData): void {
        // Processing the /sync may have produced new outgoing requests which need sending, so kick off the outgoing
        // request loop, if it's not already running.
        this.outgoingRequestsManager.doProcessOutgoingRequests().catch((e) => {
            this.logger.warn("onSyncCompleted: Error processing outgoing requests", e);
        });
    }

    /**
     * Implementation of {@link CryptoApi#markAllTrackedUsersAsDirty}.
     */
    public async markAllTrackedUsersAsDirty(): Promise<void> {
        await this.olmMachine.markAllTrackedUsersAsDirty();
    }

    /**
     * Handle an incoming m.key.verification.request event, received either in-room or in a to-device message.
     *
     * @param sender - the sender of the event
     * @param transactionId - the transaction ID for the verification. For to-device messages, this comes from the
     *    content of the message; for in-room messages it is the event ID.
     */
    private onIncomingKeyVerificationRequest(sender: string, transactionId: string): void {
        const request: RustSdkCryptoJs.VerificationRequest | undefined = this.olmMachine.getVerificationRequest(
            new RustSdkCryptoJs.UserId(sender),
            transactionId,
        );

        if (request) {
            this.emit(CryptoEvent.VerificationRequestReceived, this.makeVerificationRequest(request));
        } else {
            // There are multiple reasons this can happen; probably the most likely is that the event is an
            // in-room event which is too old.
            this.logger.info(
                `Ignoring just-received verification request ${transactionId} which did not start a rust-side verification`,
            );
        }
    }

    /** Utility function to wrap a rust `VerificationRequest` with our own {@link VerificationRequest}. */
    private makeVerificationRequest(request: RustSdkCryptoJs.VerificationRequest): VerificationRequest {
        return new RustVerificationRequest(
            this.logger,
            this.olmMachine,
            request,
            this.outgoingRequestProcessor,
            this._supportedVerificationMethods,
        );
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Other public functions
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /** called by the MatrixClient on a room membership event
     *
     * @param event - The matrix event which caused this event to fire.
     * @param member - The member whose RoomMember.membership changed.
     * @param oldMembership - The previous membership state. Null if it's a new member.
     */
    public onRoomMembership(event: MatrixEvent, member: RoomMember, oldMembership?: string): void {
        const enc = this.roomEncryptors[event.getRoomId()!];
        if (!enc) {
            // not encrypting in this room
            return;
        }
        enc.onRoomMembership(member);
    }

    /** Callback for OlmMachine.registerRoomKeyUpdatedCallback
     *
     * Called by the rust-sdk whenever there is an update to (megolm) room keys. We
     * check if we have any events waiting for the given keys, and schedule them for
     * a decryption retry if so.
     *
     * @param keys - details of the updated keys
     */
    public async onRoomKeysUpdated(keys: RustSdkCryptoJs.RoomKeyInfo[]): Promise<void> {
        for (const key of keys) {
            this.onRoomKeyUpdated(key);
        }
        this.backupManager.maybeUploadKey();
    }

    private onRoomKeyUpdated(key: RustSdkCryptoJs.RoomKeyInfo): void {
        if (this.stopped) return;
        this.logger.debug(
            `Got update for session ${key.sessionId} from sender ${key.senderKey.toBase64()} in ${key.roomId.toString()}`,
        );
        const pendingList = this.eventDecryptor.getEventsPendingRoomKey(key.roomId.toString(), key.sessionId);
        if (pendingList.length === 0) return;

        this.logger.debug(
            "Retrying decryption on events:",
            pendingList.map((e) => `${e.getId()}`),
        );

        // Have another go at decrypting events with this key.
        //
        // We don't want to end up blocking the callback from Rust, which could otherwise end up dropping updates,
        // so we don't wait for the decryption to complete. In any case, there is no need to wait:
        // MatrixEvent.attemptDecryption ensures that there is only one decryption attempt happening at once,
        // and deduplicates repeated attempts for the same event.
        for (const ev of pendingList) {
            ev.attemptDecryption(this, { isRetry: true }).catch((_e) => {
                this.logger.info(`Still unable to decrypt event ${ev.getId()} after receiving key`);
            });
        }
    }

    /**
     * Callback for `OlmMachine.registerRoomKeyWithheldCallback`.
     *
     * Called by the rust sdk whenever we are told that a key has been withheld. We see if we had any events that
     * failed to decrypt for the given session, and update their status if so.
     *
     * @param withheld - Details of the withheld sessions.
     */
    public async onRoomKeysWithheld(withheld: RustSdkCryptoJs.RoomKeyWithheldInfo[]): Promise<void> {
        for (const session of withheld) {
            this.logger.debug(`Got withheld message for session ${session.sessionId} in ${session.roomId.toString()}`);
            const pendingList = this.eventDecryptor.getEventsPendingRoomKey(
                session.roomId.toString(),
                session.sessionId,
            );
            if (pendingList.length === 0) return;

            // The easiest way to update the status of the event is to have another go at decrypting it.
            this.logger.debug(
                "Retrying decryption on events:",
                pendingList.map((e) => `${e.getId()}`),
            );

            for (const ev of pendingList) {
                ev.attemptDecryption(this, { isRetry: true }).catch((_e) => {
                    // It's somewhat expected that we still can't decrypt here.
                });
            }
        }
    }

    /**
     * Callback for `OlmMachine.registerUserIdentityUpdatedCallback`
     *
     * Called by the rust-sdk whenever there is an update to any user's cross-signing status. We re-check their trust
     * status and emit a `UserTrustStatusChanged` event, as well as a `KeysChanged` if it is our own identity that changed.
     *
     * @param userId - the user with the updated identity
     */
    public async onUserIdentityUpdated(userId: RustSdkCryptoJs.UserId): Promise<void> {
        const newVerification = await this.getUserVerificationStatus(userId.toString());
        this.emit(CryptoEvent.UserTrustStatusChanged, userId.toString(), newVerification);

        // If our own user identity has changed, we may now trust the key backup where we did not before.
        // So, re-check the key backup status and enable it if available.
        if (userId.toString() === this.userId) {
            this.emit(CryptoEvent.KeysChanged, {});
            await this.checkKeyBackupAndEnable();
        }
    }

    /**
     * Callback for `OlmMachine.registerDevicesUpdatedCallback`
     *
     * Called when users' devices have updated. Emits `WillUpdateDevices` and `DevicesUpdated`. In the JavaScript
     * crypto backend, these events are called at separate times, with `WillUpdateDevices` being emitted just before
     * the devices are saved, and `DevicesUpdated` being emitted just after. But the OlmMachine only gives us
     * one event, so we emit both events here.
     *
     * @param userIds - an array of user IDs of users whose devices have updated.
     */
    public async onDevicesUpdated(userIds: string[]): Promise<void> {
        this.emit(CryptoEvent.WillUpdateDevices, userIds, false);
        this.emit(CryptoEvent.DevicesUpdated, userIds, false);
    }

    /**
     * Handles secret received from the rust secret inbox.
     *
     * The gossipped secrets are received using the `m.secret.send` event type
     * and are guaranteed to have been received over a 1-to-1 Olm
     * Session from a verified device.
     *
     * The only secret currently handled in this way is `m.megolm_backup.v1`.
     *
     * @param name - the secret name
     * @param value - the secret value
     */
    private async handleSecretReceived(name: string, value: string): Promise<boolean> {
        this.logger.debug(`onReceiveSecret: Received secret ${name}`);
        if (name === "m.megolm_backup.v1") {
            return await this.backupManager.handleBackupSecretReceived(value);
            // XXX at this point we should probably try to download the backup and import the keys,
            // or at least retry for the current decryption failures?
            // Maybe add some signaling when a new secret is received, and let clients handle it?
            // as it's where the restore from backup APIs are exposed.
        }
        return false;
    }

    /**
     * Called when a new secret is received in the rust secret inbox.
     *
     * Will poll the secret inbox and handle the secrets received.
     *
     * @param name - The name of the secret received.
     */
    public async checkSecrets(name: string): Promise<void> {
        const pendingValues: Set<string> = await this.olmMachine.getSecretsFromInbox(name);
        for (const value of pendingValues) {
            if (await this.handleSecretReceived(name, value)) {
                // If we have a valid secret for that name there is no point of processing the other secrets values.
                // It's probably the same secret shared by another device.
                break;
            }
        }

        // Important to call this after handling the secrets as good hygiene.
        await this.olmMachine.deleteSecretsFromInbox(name);
    }

    /**
     * Handle a live event received via /sync.
     * See {@link ClientEventHandlerMap#event}
     *
     * @param event - live event
     */
    public async onLiveEventFromSync(event: MatrixEvent): Promise<void> {
        // Ignore state event or remote echo
        // transaction_id is provided in case of remote echo {@link https://spec.matrix.org/v1.7/client-server-api/#local-echo}
        if (event.isState() || !!event.getUnsigned().transaction_id) return;

        const processEvent = async (evt: MatrixEvent): Promise<void> => {
            // Process only verification event
            if (isVerificationEvent(event)) {
                await this.onKeyVerificationEvent(evt);
            }
        };

        // If the event is encrypted of in failure, we wait for decryption
        if (event.isDecryptionFailure() || event.isEncrypted()) {
            // 5 mins
            const TIMEOUT_DELAY = 5 * 60 * 1000;

            // After 5mins, we are not expecting the event to be decrypted
            const timeoutId = setTimeout(() => event.off(MatrixEventEvent.Decrypted, onDecrypted), TIMEOUT_DELAY);

            const onDecrypted = (decryptedEvent: MatrixEvent, error?: Error): void => {
                if (error) return;

                clearTimeout(timeoutId);
                event.off(MatrixEventEvent.Decrypted, onDecrypted);
                processEvent(decryptedEvent);
            };

            event.on(MatrixEventEvent.Decrypted, onDecrypted);
        } else {
            await processEvent(event);
        }
    }

    /**
     * Handle an in-room key verification event.
     *
     * @param event - a key validation request event.
     */
    private async onKeyVerificationEvent(event: MatrixEvent): Promise<void> {
        const roomId = event.getRoomId();

        if (!roomId) {
            throw new Error("missing roomId in the event");
        }

        this.logger.debug(
            `Incoming verification event ${event.getId()} type ${event.getType()} from ${event.getSender()}`,
        );

        await this.olmMachine.receiveVerificationEvent(
            JSON.stringify({
                event_id: event.getId(),
                type: event.getType(),
                sender: event.getSender(),
                state_key: event.getStateKey(),
                content: event.getContent(),
                origin_server_ts: event.getTs(),
            }),
            new RustSdkCryptoJs.RoomId(roomId),
        );

        if (
            event.getType() === EventType.RoomMessage &&
            event.getContent().msgtype === MsgType.KeyVerificationRequest
        ) {
            this.onIncomingKeyVerificationRequest(event.getSender()!, event.getId()!);
        }

        // that may have caused us to queue up outgoing requests, so make sure we send them.
        this.outgoingRequestsManager.doProcessOutgoingRequests().catch((e) => {
            this.logger.warn("onKeyVerificationRequest: Error processing outgoing requests", e);
        });
    }

    /**
     * Returns the cross-signing user identity of the current user.
     *
     * Not part of the public crypto-api interface.
     * Used during migration from legacy js-crypto to update local trust if needed.
     */
    public async getOwnIdentity(): Promise<RustSdkCryptoJs.OwnUserIdentity | undefined> {
        return await this.olmMachine.getIdentity(new RustSdkCryptoJs.UserId(this.userId));
    }
}

class EventDecryptor {
    /**
     * Events which we couldn't decrypt due to unknown sessions / indexes.
     *
     * Map from roomId to sessionId to Set of MatrixEvents
     */
    private eventsPendingKey = new MapWithDefault<string, MapWithDefault<string, Set<MatrixEvent>>>(
        () => new MapWithDefault<string, Set<MatrixEvent>>(() => new Set()),
    );

    public constructor(
        private readonly logger: Logger,
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        private readonly perSessionBackupDownloader: PerSessionKeyBackupDownloader,
    ) {}

    public async attemptEventDecryption(
        event: MatrixEvent,
        isolationMode: DeviceIsolationMode,
    ): Promise<IEventDecryptionResult> {
        // add the event to the pending list *before* attempting to decrypt.
        // then, if the key turns up while decryption is in progress (and
        // decryption fails), we will schedule a retry.
        // (fixes https://github.com/vector-im/element-web/issues/5001)
        this.addEventToPendingList(event);

        let trustRequirement;

        switch (isolationMode.kind) {
            case DeviceIsolationModeKind.AllDevicesIsolationMode:
                trustRequirement = RustSdkCryptoJs.TrustRequirement.Untrusted;
                break;
            case DeviceIsolationModeKind.OnlySignedDevicesIsolationMode:
                trustRequirement = RustSdkCryptoJs.TrustRequirement.CrossSignedOrLegacy;
                break;
        }

        try {
            const res = (await this.olmMachine.decryptRoomEvent(
                stringifyEvent(event),
                new RustSdkCryptoJs.RoomId(event.getRoomId()!),
                new RustSdkCryptoJs.DecryptionSettings(trustRequirement),
            )) as RustSdkCryptoJs.DecryptedRoomEvent;

            // Success. We can remove the event from the pending list, if
            // that hasn't already happened.
            this.removeEventFromPendingList(event);

            return {
                clearEvent: JSON.parse(res.event),
                claimedEd25519Key: res.senderClaimedEd25519Key,
                senderCurve25519Key: res.senderCurve25519Key,
                forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
            };
        } catch (err) {
            if (err instanceof RustSdkCryptoJs.MegolmDecryptionError) {
                this.onMegolmDecryptionError(event, err, await this.perSessionBackupDownloader.getServerBackupInfo());
            } else {
                throw new DecryptionError(DecryptionFailureCode.UNKNOWN_ERROR, "Unknown error");
            }
        }
    }

    /**
     * Handle a `MegolmDecryptionError` returned by the rust SDK.
     *
     * Fires off a request to the `perSessionBackupDownloader`, if appropriate, and then throws a `DecryptionError`.
     *
     * @param event - The event which could not be decrypted.
     * @param err - The error from the Rust SDK.
     * @param serverBackupInfo - Details about the current backup from the server. `null` if there is no backup.
     *     `undefined` if our attempt to check failed.
     */
    private onMegolmDecryptionError(
        event: MatrixEvent,
        err: RustSdkCryptoJs.MegolmDecryptionError,
        serverBackupInfo: KeyBackupInfo | null | undefined,
    ): never {
        const content = event.getWireContent();
        const errorDetails = { sender_key: content.sender_key, session_id: content.session_id };

        // If the error looks like it might be recoverable from backup, queue up a request to try that.
        if (
            err.code === RustSdkCryptoJs.DecryptionErrorCode.MissingRoomKey ||
            err.code === RustSdkCryptoJs.DecryptionErrorCode.UnknownMessageIndex
        ) {
            this.perSessionBackupDownloader.onDecryptionKeyMissingError(event.getRoomId()!, content.session_id!);

            // If the server is telling us our membership at the time the event
            // was sent, and it isn't "join", we use a different error code.
            const membership = event.getMembershipAtEvent();
            if (membership && membership !== KnownMembership.Join && membership !== KnownMembership.Invite) {
                throw new DecryptionError(
                    DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
                    "This message was sent when we were not a member of the room.",
                    errorDetails,
                );
            }

            // If the event was sent before this device was created, we use some different error codes.
            if (event.getTs() <= this.olmMachine.deviceCreationTimeMs) {
                if (serverBackupInfo === null) {
                    throw new DecryptionError(
                        DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
                        "This message was sent before this device logged in, and there is no key backup on the server.",
                        errorDetails,
                    );
                } else if (!this.perSessionBackupDownloader.isKeyBackupDownloadConfigured()) {
                    throw new DecryptionError(
                        DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
                        "This message was sent before this device logged in, and key backup is not working.",
                        errorDetails,
                    );
                } else {
                    throw new DecryptionError(
                        DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP,
                        "This message was sent before this device logged in. Key backup is working, but we still do not (yet) have the key.",
                        errorDetails,
                    );
                }
            }
        }

        // If we got a withheld code, expose that.
        if (err.maybe_withheld) {
            // Unfortunately the Rust SDK API doesn't let us distinguish between different withheld cases, other than
            // by string-matching.
            const failureCode =
                err.maybe_withheld === "The sender has disabled encrypting to unverified devices."
                    ? DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE
                    : DecryptionFailureCode.MEGOLM_KEY_WITHHELD;
            throw new DecryptionError(failureCode, err.maybe_withheld, errorDetails);
        }

        switch (err.code) {
            case RustSdkCryptoJs.DecryptionErrorCode.MissingRoomKey:
                throw new DecryptionError(
                    DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
                    "The sender's device has not sent us the keys for this message.",
                    errorDetails,
                );

            case RustSdkCryptoJs.DecryptionErrorCode.UnknownMessageIndex:
                throw new DecryptionError(
                    DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX,
                    "The sender's device has not sent us the keys for this message at this index.",
                    errorDetails,
                );

            case RustSdkCryptoJs.DecryptionErrorCode.SenderIdentityVerificationViolation:
                // We're refusing to decrypt due to not trusting the sender,
                // rather than failing to decrypt due to lack of keys, so we
                // don't need to keep it on the pending list.
                this.removeEventFromPendingList(event);
                throw new DecryptionError(
                    DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
                    "The sender identity is unverified, but was previously verified.",
                );

            case RustSdkCryptoJs.DecryptionErrorCode.UnknownSenderDevice:
                // We're refusing to decrypt due to not trusting the sender,
                // rather than failing to decrypt due to lack of keys, so we
                // don't need to keep it on the pending list.
                this.removeEventFromPendingList(event);
                throw new DecryptionError(
                    DecryptionFailureCode.UNKNOWN_SENDER_DEVICE,
                    "The sender device is not known.",
                );

            case RustSdkCryptoJs.DecryptionErrorCode.UnsignedSenderDevice:
                // We're refusing to decrypt due to not trusting the sender,
                // rather than failing to decrypt due to lack of keys, so we
                // don't need to keep it on the pending list.
                this.removeEventFromPendingList(event);
                throw new DecryptionError(
                    DecryptionFailureCode.UNSIGNED_SENDER_DEVICE,
                    "The sender identity is not cross-signed.",
                );

            // We don't map MismatchedIdentityKeys for now, as there is no equivalent in legacy.
            // Just put it on the `UNKNOWN_ERROR` bucket.
            default:
                throw new DecryptionError(DecryptionFailureCode.UNKNOWN_ERROR, err.description, errorDetails);
        }
    }

    public async getEncryptionInfoForEvent(event: MatrixEvent): Promise<EventEncryptionInfo | null> {
        if (!event.getClearContent() || event.isDecryptionFailure()) {
            // not successfully decrypted
            return null;
        }

        // special-case outgoing events, which the rust crypto-sdk will barf on
        if (event.status !== null) {
            return { shieldColour: EventShieldColour.NONE, shieldReason: null };
        }

        const encryptionInfo = await this.olmMachine.getRoomEventEncryptionInfo(
            stringifyEvent(event),
            new RustSdkCryptoJs.RoomId(event.getRoomId()!),
        );

        return rustEncryptionInfoToJsEncryptionInfo(this.logger, encryptionInfo);
    }

    /**
     * Look for events which are waiting for a given megolm session
     *
     * Returns a list of events which were encrypted by `session` and could not be decrypted
     */
    public getEventsPendingRoomKey(roomId: string, sessionId: string): MatrixEvent[] {
        const roomPendingEvents = this.eventsPendingKey.get(roomId);
        if (!roomPendingEvents) return [];

        const sessionPendingEvents = roomPendingEvents.get(sessionId);
        if (!sessionPendingEvents) return [];

        return [...sessionPendingEvents];
    }

    /**
     * Add an event to the list of those awaiting their session keys.
     */
    private addEventToPendingList(event: MatrixEvent): void {
        const roomId = event.getRoomId();
        // We shouldn't have events without a room id here.
        if (!roomId) return;

        const roomPendingEvents = this.eventsPendingKey.getOrCreate(roomId);
        const sessionPendingEvents = roomPendingEvents.getOrCreate(event.getWireContent().session_id);
        sessionPendingEvents.add(event);
    }

    /**
     * Remove an event from the list of those awaiting their session keys.
     */
    private removeEventFromPendingList(event: MatrixEvent): void {
        const roomId = event.getRoomId();
        if (!roomId) return;

        const roomPendingEvents = this.eventsPendingKey.getOrCreate(roomId);
        if (!roomPendingEvents) return;

        const sessionPendingEvents = roomPendingEvents.get(event.getWireContent().session_id);
        if (!sessionPendingEvents) return;

        sessionPendingEvents.delete(event);

        // also clean up the higher-level maps if they are now empty
        if (sessionPendingEvents.size === 0) {
            roomPendingEvents.delete(event.getWireContent().session_id);
            if (roomPendingEvents.size === 0) {
                this.eventsPendingKey.delete(roomId);
            }
        }
    }
}

function stringifyEvent(event: MatrixEvent): string {
    return JSON.stringify({
        event_id: event.getId(),
        type: event.getWireType(),
        sender: event.getSender(),
        state_key: event.getStateKey(),
        content: event.getWireContent(),
        origin_server_ts: event.getTs(),
    });
}

function rustEncryptionInfoToJsEncryptionInfo(
    logger: Logger,
    encryptionInfo: RustSdkCryptoJs.EncryptionInfo | undefined,
): EventEncryptionInfo | null {
    if (encryptionInfo === undefined) {
        // not decrypted here
        return null;
    }

    // TODO: use strict shield semantics.
    const shieldState = encryptionInfo.shieldState(false);

    let shieldColour: EventShieldColour;
    switch (shieldState.color) {
        case RustSdkCryptoJs.ShieldColor.Grey:
            shieldColour = EventShieldColour.GREY;
            break;
        case RustSdkCryptoJs.ShieldColor.None:
            shieldColour = EventShieldColour.NONE;
            break;
        default:
            shieldColour = EventShieldColour.RED;
    }

    let shieldReason: EventShieldReason | null;
    switch (shieldState.code) {
        case undefined:
        case null:
            shieldReason = null;
            break;
        case RustSdkCryptoJs.ShieldStateCode.AuthenticityNotGuaranteed:
            shieldReason = EventShieldReason.AUTHENTICITY_NOT_GUARANTEED;
            break;
        case RustSdkCryptoJs.ShieldStateCode.UnknownDevice:
            shieldReason = EventShieldReason.UNKNOWN_DEVICE;
            break;
        case RustSdkCryptoJs.ShieldStateCode.UnsignedDevice:
            shieldReason = EventShieldReason.UNSIGNED_DEVICE;
            break;
        case RustSdkCryptoJs.ShieldStateCode.UnverifiedIdentity:
            shieldReason = EventShieldReason.UNVERIFIED_IDENTITY;
            break;
        case RustSdkCryptoJs.ShieldStateCode.SentInClear:
            shieldReason = EventShieldReason.SENT_IN_CLEAR;
            break;
        case RustSdkCryptoJs.ShieldStateCode.VerificationViolation:
            shieldReason = EventShieldReason.VERIFICATION_VIOLATION;
            break;
        case RustSdkCryptoJs.ShieldStateCode.MismatchedSender:
            shieldReason = EventShieldReason.MISMATCHED_SENDER;
            break;
        default:
            shieldReason = EventShieldReason.UNKNOWN;
            break;
    }

    return { shieldColour, shieldReason };
}

type CryptoEvents = (typeof CryptoEvent)[keyof typeof CryptoEvent];
type RustCryptoEvents = Exclude<CryptoEvents, CryptoEvent.LegacyCryptoStoreMigrationProgress>;
