/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import type { SecretsBundle } from "@matrix-org/matrix-sdk-crypto-wasm";
import type { IMegolmSessionData } from "../@types/crypto.ts";
import type { ToDeviceBatch, ToDevicePayload } from "../models/ToDeviceMessage.ts";
import { type Room } from "../models/room.ts";
import { type DeviceMap } from "../models/device.ts";
import { type UIAuthCallback } from "../interactive-auth.ts";
import { type PassphraseInfo, type SecretStorageKey, type SecretStorageKeyDescription } from "../secret-storage.ts";
import { type VerificationRequest } from "./verification.ts";
import {
    type BackupTrustInfo,
    type KeyBackupCheck,
    type KeyBackupInfo,
    type KeyBackupRestoreOpts,
    type KeyBackupRestoreResult,
} from "./keybackup.ts";
import { type ISignatures } from "../@types/signed.ts";
import { type MatrixEvent } from "../models/event.ts";

/**
 * `matrix-js-sdk/lib/crypto-api`: End-to-end encryption support.
 *
 * The most important type is {@link CryptoApi}, an instance of which can be retrieved via
 * {@link MatrixClient.getCrypto}.
 *
 * @packageDocumentation
 */

/**
 * The options to start device dehydration.
 */
export interface StartDehydrationOpts {
    /**
     * Force creation of a new dehydration key, even if there is already an
     * existing dehydration key. If `false`, and `onlyIfKeyCached` is `false`, a
     * new key will be created if there is no existing dehydration key, whether
     * already cached in our local storage or stored in Secret Storage.
     *
     * Checking for the presence of the key in Secret Storage may result in the
     * `getSecretStorageKey` callback being called.
     *
     * Defaults to `false`.
     */
    createNewKey?: boolean;
    /**
     * Only start dehydration if we have a dehydration key cached in our local
     * storage. If `true`, Secret Storage will not be checked. Defaults to
     * `false`.
     */
    onlyIfKeyCached?: boolean;
    /**
     * Try to rehydrate a device before creating a new dehydrated device.
     * Setting this to `false` may be useful for situations where the client is
     * known to pre-date the dehydrated device, and so rehydration is
     * unnecessary. Defaults to `true`.
     */
    rehydrate?: boolean;
}

/**
 * Public interface to the cryptography parts of the js-sdk
 *
 * @remarks Currently, this is a work-in-progress. In time, more methods will be added here.
 */
export interface CryptoApi {
    /**
     * Global override for whether the client should ever send encrypted
     * messages to unverified devices. This provides the default for rooms which
     * do not specify a value.
     *
     * If true, all unverified devices will be blacklisted by default
     */
    globalBlacklistUnverifiedDevices: boolean;

    /**
     * The {@link DeviceIsolationMode} mode to use.
     */
    setDeviceIsolationMode(isolationMode: DeviceIsolationMode): void;

    /**
     * Return the current version of the crypto module.
     * For example: `Rust SDK ${versions.matrix_sdk_crypto} (${versions.git_sha}), Vodozemac ${versions.vodozemac}`.
     * @returns the formatted version
     */
    getVersion(): string;

    /**
     * Get the public part of the device keys for the current device.
     *
     * @returns The public device keys.
     */
    getOwnDeviceKeys(): Promise<OwnDeviceKeys>;

    /**
     * Check if we believe the given room to be encrypted.
     *
     * This method returns true if the room has been configured with encryption. The setting is persistent, so that
     * even if the encryption event is removed from the room state, it still returns true. This helps to guard against
     * a downgrade attack wherein a server admin attempts to remove encryption.
     *
     * @returns `true` if the room with the supplied ID is encrypted. `false` if the room is not encrypted, or is unknown to
     * us.
     */
    isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;

    /**
     * Check if we believe the given room supports encrypted state events.
     */
    isStateEncryptionEnabledInRoom(roomId: string): Promise<boolean>;

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     */
    prepareToEncrypt(room: Room): void;

    /**
     * Discard any existing megolm session for the given room.
     *
     * This will ensure that a new session is created on the next call to {@link prepareToEncrypt},
     * or the next time a message is sent.
     *
     * This should not normally be necessary: it should only be used as a debugging tool if there has been a
     * problem with encryption.
     *
     * @param roomId - the room to discard sessions for
     */
    forceDiscardSession(roomId: string): Promise<void>;

    /**
     * Get a list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @returns a promise which resolves to a list of
     *    session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;

    /**
     * Get a JSON list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @returns a promise which resolves to a JSON string
     *    encoding a list of session export objects,
     *    each of which is an IMegolmSessionData
     */
    exportRoomKeysAsJson(): Promise<string>;

    /**
     * Import a list of room keys previously exported by exportRoomKeys
     *
     * @param keys - a list of session export objects
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    importRoomKeys(keys: IMegolmSessionData[], opts?: ImportRoomKeysOpts): Promise<void>;

    /**
     * Import a JSON string encoding a list of room keys previously
     * exported by exportRoomKeysAsJson
     *
     * @param keys - a JSON string encoding a list of session export
     *    objects, each of which is an IMegolmSessionData
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    importRoomKeysAsJson(keys: string, opts?: ImportRoomKeysOpts): Promise<void>;

    /**
     * Check if the given user has published cross-signing keys.
     *
     * - If the user is tracked, a `/keys/query` request is made to update locally the cross signing keys.
     * - If the user is not tracked locally and downloadUncached is set to true,
     *   a `/keys/query` request is made to the server to retrieve the cross signing keys.
     * - Otherwise, return false
     *
     * @param userId - the user ID to check. Defaults to the local user.
     * @param downloadUncached - If true, download the device list for users whose device list we are not
     *    currently tracking. Defaults to false, in which case `false` will be returned for such users.
     *
     * @returns true if the cross signing keys are available.
     */
    userHasCrossSigningKeys(userId?: string, downloadUncached?: boolean): Promise<boolean>;

    /**
     * Get the device information for the given list of users.
     *
     * For any users whose device lists are cached (due to sharing an encrypted room with the user), the
     * cached device data is returned.
     *
     * If there are uncached users, and the `downloadUncached` parameter is set to `true`,
     * a `/keys/query` request is made to the server to retrieve these devices.
     *
     * @param userIds - The users to fetch.
     * @param downloadUncached - If true, download the device list for users whose device list we are not
     *    currently tracking. Defaults to false, in which case such users will not appear at all in the result map.
     *
     * @returns A map `{@link DeviceMap}`.
     */
    getUserDeviceInfo(userIds: string[], downloadUncached?: boolean): Promise<DeviceMap>;

    /**
     * Set whether to trust other user's signatures of their devices.
     *
     * If false, devices will only be considered 'verified' if we have
     * verified that device individually (effectively disabling cross-signing).
     *
     * `true` by default.
     *
     * @param val - the new value
     */
    setTrustCrossSignedDevices(val: boolean): void;

    /**
     * Return whether we trust other user's signatures of their devices.
     *
     * @see {@link CryptoApi.setTrustCrossSignedDevices}
     *
     * @returns `true` if we trust cross-signed devices, otherwise `false`.
     */
    getTrustCrossSignedDevices(): boolean;

    /**
     * Get the verification status of a given user.
     *
     * @param userId - The ID of the user to check.
     *
     */
    getUserVerificationStatus(userId: string): Promise<UserVerificationStatus>;

    /**
     * "Pin" the current identity of the given user, accepting it as genuine.
     *
     * This is useful if the user has changed identity since we first saw them (leading to
     * {@link UserVerificationStatus.needsUserApproval}), and we are now accepting their new identity.
     *
     * Throws an error if called on our own user ID, or on a user ID that we don't have an identity for.
     */
    pinCurrentUserIdentity(userId: string): Promise<void>;

    /**
     * Remove the requirement for this identity to be verified, and pin it.
     *
     * This is useful if the user was previously verified but is not anymore
     * ({@link UserVerificationStatus.wasCrossSigningVerified}) and it is not possible to verify him again now.
     *
     */
    withdrawVerificationRequirement(userId: string): Promise<void>;

    /**
     * Get the verification status of a given device.
     *
     * @param userId - The ID of the user whose device is to be checked.
     * @param deviceId - The ID of the device to check
     *
     * @returns `null` if the device is unknown, or has not published any encryption keys (implying it does not support
     *     encryption); otherwise the verification status of the device.
     */
    getDeviceVerificationStatus(userId: string, deviceId: string): Promise<DeviceVerificationStatus | null>;

    /**
     * Mark the given device as locally verified.
     *
     * Marking a device as locally verified has much the same effect as completing the verification dance, or receiving
     * a cross-signing signature for it.
     *
     * @param userId - owner of the device
     * @param deviceId - unique identifier for the device.
     * @param verified - whether to mark the device as verified. Defaults to 'true'.
     *
     * @throws an error if the device is unknown, or has not published any encryption keys.
     */
    setDeviceVerified(userId: string, deviceId: string, verified?: boolean): Promise<void>;

    /**
     * Cross-sign one of our own devices.
     *
     * This will create a signature for the device using our self-signing key, and publish that signature.
     * Cross-signing a device indicates, to our other devices and to other users, that we have verified that it really
     * belongs to us.
     *
     * Requires that cross-signing has been set up on this device (normally by calling {@link bootstrapCrossSigning}).
     *
     * *Note*: Do not call this unless you have verified, somehow, that the device is genuine!
     *
     * @param deviceId - ID of the device to be signed.
     */
    crossSignDevice(deviceId: string): Promise<void>;

    /**
     * Checks whether cross signing:
     * - is enabled on this account and trusted by this device
     * - has private keys either cached locally or stored in secret storage
     *
     * If this function returns false, {@link bootstrapCrossSigning()} can be used
     * to fix things such that it returns true. That is to say, after
     * `bootstrapCrossSigning()` completes successfully, this function should
     * return true.
     *
     * @returns True if cross-signing is ready to be used on this device
     *
     * @throws May throw {@link matrix.ClientStoppedError} if the `MatrixClient` is stopped before or during the call.
     */
    isCrossSigningReady(): Promise<boolean>;

    /**
     * Get the ID of one of the user's cross-signing keys, if both private and matching
     * public parts of that key are available (ie. cached in the local crypto store).
     *
     * The public part may not be available if a `/keys/query` request has not yet been
     * performed, or if the device that created the keys failed to publish them.
     *
     * If either part of the keypair is not available, this will return `null`.
     *
     * @param type - The type of key to get the ID of.  One of `CrossSigningKey.Master`, `CrossSigningKey.SelfSigning`,
     *     or `CrossSigningKey.UserSigning`.  Defaults to `CrossSigningKey.Master`.
     *
     * @returns If cross-signing has been initialised on this device, the ID of the given key. Otherwise, null
     */
    getCrossSigningKeyId(type?: CrossSigningKey): Promise<string | null>;

    /**
     * Bootstrap cross-signing by creating keys if needed.
     *
     * If everything is already set up, then no changes are made, so this is safe to run to ensure
     * cross-signing is ready for use.
     *
     * This function:
     * - creates new cross-signing keys if they are not found locally cached nor in
     *   secret storage (if it has been set up)
     * - publishes the public keys to the server if they are not already published
     * - stores the private keys in secret storage if secret storage is set up.
     *
     * @param opts - options object
     */
    bootstrapCrossSigning(opts: BootstrapCrossSigningOpts): Promise<void>;

    /**
     * Checks whether secret storage:
     * - is enabled on this account
     * - is storing cross-signing private keys
     * - is storing session backup key (if enabled)
     *
     * If this function returns false, {@link bootstrapSecretStorage()} can be used
     * to fix things such that it returns true. That is to say, after
     * `bootstrapSecretStorage()` completes successfully, this function should
     * return true.
     *
     * @returns True if secret storage is ready to be used on this device
     */
    isSecretStorageReady(): Promise<boolean>;

    /**
     * Inspect the status of secret storage, in more detail than {@link isSecretStorageReady}.
     */
    getSecretStorageStatus(): Promise<SecretStorageStatus>;

    /**
     * Bootstrap [secret storage](https://spec.matrix.org/v1.12/client-server-api/#storage).
     *
     * - If secret storage is not already set up, or {@link CreateSecretStorageOpts.setupNewSecretStorage} is set:
     *   * Calls {@link CreateSecretStorageOpts.createSecretStorageKey} to generate a new key.
     *   * Stores the metadata of the new key in account data and sets it as the default secret storage key.
     *   * Calls {@link CryptoCallbacks.cacheSecretStorageKey} if provided.
     * - Stores the private cross signing keys in the secret storage if they are known, and they are not
     *   already stored in secret storage.
     * - If {@link CreateSecretStorageOpts.setupNewKeyBackup} is set, calls {@link CryptoApi.resetKeyBackup}; otherwise,
     *   stores the key backup decryption key in secret storage if it is known, and it is not
     *   already stored in secret storage.
     *
     * Note that there may be multiple accesses to secret storage during the course of this call, each of which will
     * result in a call to {@link CryptoCallbacks.getSecretStorageKey}.
     *
     * @param opts - Options object.
     */
    bootstrapSecretStorage(opts: CreateSecretStorageOpts): Promise<void>;

    /**
     * Get the status of our cross-signing keys.
     *
     * @returns The current status of cross-signing keys: whether we have public and private keys cached locally, and
     * whether the private keys are in secret storage.
     *
     * @throws May throw {@link matrix.ClientStoppedError} if the `MatrixClient` is stopped before or during the call.
     */
    getCrossSigningStatus(): Promise<CrossSigningStatus>;

    /**
     * Create a recovery key (ie, a key suitable for use with server-side secret storage).
     *
     * The key can either be based on a user-supplied passphrase, or just created randomly.
     *
     * @param password - Optional passphrase string to use to derive the key,
     *      which can later be entered by the user as an alternative to entering the
     *      recovery key itself. If omitted, a key is generated randomly.
     *
     * @returns Object including recovery key and server upload parameters.
     *      The private key should be disposed of after displaying to the use.
     */
    createRecoveryKeyFromPassphrase(password?: string): Promise<GeneratedSecretStorageKey>;

    /**
     * Get information about the encryption of the given event.
     *
     * @param event - the event to get information for
     *
     * @returns `null` if the event is not encrypted, or has not (yet) been successfully decrypted. Otherwise, an
     *      object with information about the encryption of the event.
     */
    getEncryptionInfoForEvent(event: MatrixEvent): Promise<EventEncryptionInfo | null>;

    /**
     * Encrypts a given payload object via Olm to-device messages to a given
     * set of devices.
     *
     * @param eventType - the type of the event to send.
     * @param devices - an array of devices to encrypt the payload for.
     * @param payload - the payload to encrypt.
     *
     * @returns the batch of encrypted payloads which can then be sent via {@link matrix.MatrixClient#queueToDevice}.
     */
    encryptToDeviceMessages(
        eventType: string,
        devices: { userId: string; deviceId: string }[],
        payload: ToDevicePayload,
    ): Promise<ToDeviceBatch>;

    /**
     * Reset the encryption of the user by going through the following steps:
     * - Remove the dehydrated device and stop the periodic creation of dehydrated devices.
     * - Disable backing up room keys and delete any existing backups.
     * - Remove the default secret storage key from the account data (ie: the recovery key).
     * - Reset the cross-signing keys.
     * - Create a new key backup.
     *
     * Note that the dehydrated device will be removed, but will not be replaced
     * and it will not schedule creating new dehydrated devices.  To do this,
     * {@link startDehydration} should be called after a new secret storage key
     * is created.
     *
     * @param authUploadDeviceSigningKeys - Callback to authenticate the upload of device signing keys.
     *      Used when resetting the cross signing keys.
     *      See {@link BootstrapCrossSigningOpts#authUploadDeviceSigningKeys}.
     */
    resetEncryption(authUploadDeviceSigningKeys: UIAuthCallback<void>): Promise<void>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Device/User verification
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Returns to-device verification requests that are already in progress for the given user id.
     *
     * @param userId - the ID of the user to query
     *
     * @returns the VerificationRequests that are in progress
     */
    getVerificationRequestsToDeviceInProgress(userId: string): VerificationRequest[];

    /**
     * Finds a DM verification request that is already in progress for the given room and user.
     *
     * @param roomId - the room to use for verification.
     * @param userId - search for a verification request for the given user.
     *
     * @returns the VerificationRequest that is in progress, if any.
     */
    findVerificationRequestDMInProgress(roomId: string, userId?: string): VerificationRequest | undefined;

    /**
     * Request a key verification from another user, using a DM.
     *
     * @param userId - the user to request verification with.
     * @param roomId - the room to use for verification.
     *
     * @returns resolves to a VerificationRequest when the request has been sent to the other party.
     */
    requestVerificationDM(userId: string, roomId: string): Promise<VerificationRequest>;

    /**
     * Send a verification request to our other devices.
     *
     * This is normally used when the current device is new, and we want to ask another of our devices to cross-sign.
     *
     * If an all-devices verification is already in flight, returns it. Otherwise, initiates a new one.
     *
     * To control the methods offered, set {@link matrix.ICreateClientOpts.verificationMethods} when creating the
     * `MatrixClient`.
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    requestOwnUserVerification(): Promise<VerificationRequest>;

    /**
     * Request an interactive verification with the given device.
     *
     * This is normally used on one of our own devices, when the current device is already cross-signed, and we want to
     * validate another device.
     *
     * If a verification for this user/device is already in flight, returns it. Otherwise, initiates a new one.
     *
     * To control the methods offered, set {@link  matrix.ICreateClientOpts.verificationMethods} when creating the
     * `MatrixClient`.
     *
     * @param userId - ID of the owner of the device to verify
     * @param deviceId - ID of the device to verify
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Secure key backup
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Fetch the backup decryption key we have saved in our store.
     *
     * This can be used for gossiping the key to other devices.
     *
     * @returns the key, if any, or null
     */
    getSessionBackupPrivateKey(): Promise<Uint8Array | null>;

    /**
     * Store the backup decryption key.
     *
     * This should be called if the client has received the key from another device via secret sharing (gossiping).
     * It is the responsability of the caller to check that the decryption key is valid for the given backup version.
     *
     * @param key - the backup decryption key
     * @param version - the backup version corresponding to this decryption key
     */
    storeSessionBackupPrivateKey(key: Uint8Array, version: string): Promise<void>;

    /**
     * Attempt to fetch the backup decryption key from secret storage.
     *
     * If the key is found in secret storage, checks it against the latest backup on the server;
     * if they match, stores the key in the crypto store by calling {@link storeSessionBackupPrivateKey},
     * which enables automatic restore of individual keys when an Unable-to-decrypt error is encountered.
     *
     * If we are unable to fetch the key from secret storage, there is no backup on the server, or the key
     * does not match, throws an exception.
     */
    loadSessionBackupPrivateKeyFromSecretStorage(): Promise<void>;

    /**
     * Get the current status of key backup.
     *
     * @returns If automatic key backups are enabled, the `version` of the active backup. Otherwise, `null`.
     */
    getActiveSessionBackupVersion(): Promise<string | null>;

    /**
     * Determine if a key backup can be trusted.
     *
     * @param info - key backup info dict from {@link CryptoApi.getKeyBackupInfo}.
     */
    isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo>;

    /**
     * Return the details of the latest backup on the server, when we last checked.
     *
     * This normally returns a cached value, but if we haven't yet made a request to the server, it will fire one off.
     * It will always return the details of the active backup if key backup is enabled.
     *
     * Return null if there is no backup.
     *
     * @returns the key backup information
     */
    getKeyBackupInfo(): Promise<KeyBackupInfo | null>;

    /**
     * Force a re-check of the key backup and enable/disable it as appropriate.
     *
     * Fetches the current backup information from the server. If there is a backup, and it is trusted, starts
     * backing up to it; otherwise, disables backups.
     *
     * @returns `null` if there is no backup on the server. Otherwise, data on the backup as returned by the server,
     *   and trust information (as returned by {@link isKeyBackupTrusted}).
     */
    checkKeyBackupAndEnable(): Promise<KeyBackupCheck | null>;

    /**
     * Creates a new key backup version.
     *
     * If there are existing backups they will be replaced.
     *
     * If secret storage is set up, the new decryption key will be saved (the {@link CryptoCallbacks.getSecretStorageKey}
     * callback will be called to obtain the secret storage key).
     *
     * The backup engine will be started using the new backup version (i.e., {@link checkKeyBackupAndEnable} is called).
     */
    resetKeyBackup(): Promise<void>;

    /**
     * Disables server-side key storage and deletes server-side backups.
     *  * Deletes the current key backup version, if any (but not any previous versions).
     *  * Disables 4S, deleting the info for the default key, the default key pointer itself and any
     *    known 4S data (cross-signing keys and the megolm key backup key).
     *  * Deletes any dehydrated devices.
     *  * Sets the "m.org.matrix.custom.backup_disabled" account data flag to indicate that the user has disabled backups.
     */
    disableKeyStorage(): Promise<void>;

    /**
     * Deletes the given key backup.
     *
     * @param version - The backup version to delete.
     */
    deleteKeyBackupVersion(version: string): Promise<void>;

    /**
     * Download and restore the full key backup from the homeserver.
     *
     * Before calling this method, a decryption key, and the backup version to restore,
     * must have been saved in the crypto store. This happens in one of the following ways:
     *
     * - When a new backup version is created with {@link CryptoApi.resetKeyBackup}, a new key is created and cached.
     * - The key can be loaded from secret storage with {@link CryptoApi.loadSessionBackupPrivateKeyFromSecretStorage}.
     * - The key can be received from another device via secret sharing, typically as part of the interactive verification flow.
     * - The key and backup version can also be set explicitly via {@link CryptoApi.storeSessionBackupPrivateKey},
     *   though this is not expected to be a common operation.
     *
     * Warning: the full key backup may be quite large, so this operation may take several hours to complete.
     * Use of {@link KeyBackupRestoreOpts.progressCallback} is recommended.
     *
     * @param opts
     */
    restoreKeyBackup(opts?: KeyBackupRestoreOpts): Promise<KeyBackupRestoreResult>;

    /**
     * Restores a key backup using a passphrase.
     * The decoded key (derived from the passphrase) is stored locally by calling {@link CryptoApi#storeSessionBackupPrivateKey}.
     *
     * @param passphrase - The passphrase to use to restore the key backup.
     * @param opts
     *
     * @deprecated Deriving a backup key from a passphrase is not part of the matrix spec. Instead, a random key is generated and stored/shared via 4S.
     */
    restoreKeyBackupWithPassphrase(passphrase: string, opts?: KeyBackupRestoreOpts): Promise<KeyBackupRestoreResult>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Dehydrated devices
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Returns whether MSC3814 dehydrated devices are supported by the crypto
     * backend and by the server.
     *
     * This should be called before calling `startDehydration`, and if this
     * returns `false`, `startDehydration` should not be called.
     */
    isDehydrationSupported(): Promise<boolean>;

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
     * This function must not be called unless `isDehydrationSupported` returns
     * `true`, and must not be called until after cross-signing and secret
     * storage have been set up.
     *
     * @param opts - options for device dehydration. For backwards compatibility
     *     with old code, a boolean can be given here, which will be treated as
     *     the `createNewKey` option. However, this is deprecated.
     */
    startDehydration(opts?: StartDehydrationOpts | boolean): Promise<void>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Import/export of secret keys
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Export secrets bundle for transmitting to another device as part of OIDC QR login
     */
    exportSecretsBundle?(): Promise<Awaited<ReturnType<SecretsBundle["to_json"]>>>;

    /**
     * Import secrets bundle transmitted from another device.
     * @param secrets - The secrets bundle received from the other device
     */
    importSecretsBundle?(secrets: Awaited<ReturnType<SecretsBundle["to_json"]>>): Promise<void>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Room key history sharing (MSC4268)
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Share any shareable E2EE history in the given room with the given recipient,
     * as per [MSC4268](https://github.com/matrix-org/matrix-spec-proposals/pull/4268)
     *
     * @experimental
     */
    shareRoomHistoryWithUser(roomId: string, userId: string): Promise<void>;
}

/** A reason code for a failure to decrypt an event. */
export enum DecryptionFailureCode {
    /** Message was encrypted with a Megolm session whose keys have not been shared with us. */
    MEGOLM_UNKNOWN_INBOUND_SESSION_ID = "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",

    /** A special case of {@link MEGOLM_UNKNOWN_INBOUND_SESSION_ID}: the sender has told us it is withholding the key. */
    MEGOLM_KEY_WITHHELD = "MEGOLM_KEY_WITHHELD",

    /** A special case of {@link MEGOLM_KEY_WITHHELD}: the sender has told us it is withholding the key, because the current device is unverified. */
    MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE = "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",

    /** Message was encrypted with a Megolm session which has been shared with us, but in a later ratchet state. */
    OLM_UNKNOWN_MESSAGE_INDEX = "OLM_UNKNOWN_MESSAGE_INDEX",

    /**
     * Message was sent before the current device was created; there is no key backup on the server, so this
     * decryption failure is expected.
     */
    HISTORICAL_MESSAGE_NO_KEY_BACKUP = "HISTORICAL_MESSAGE_NO_KEY_BACKUP",

    /**
     * Message was sent before the current device was created; there was a key backup on the server, but we don't
     * seem to have access to the backup. (Probably we don't have the right key.)
     */
    HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED = "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED",

    /**
     * Message was sent before the current device was created; there was a (usable) key backup on the server, but we
     * still can't decrypt. (Either the session isn't in the backup, or we just haven't gotten around to checking yet.)
     */
    HISTORICAL_MESSAGE_WORKING_BACKUP = "HISTORICAL_MESSAGE_WORKING_BACKUP",

    /**
     * Message was sent when the user was not a member of the room.
     */
    HISTORICAL_MESSAGE_USER_NOT_JOINED = "HISTORICAL_MESSAGE_USER_NOT_JOINED",

    /**
     * The sender's identity is not verified, but was previously verified.
     */
    SENDER_IDENTITY_PREVIOUSLY_VERIFIED = "SENDER_IDENTITY_PREVIOUSLY_VERIFIED",

    /**
     * The sender device is not cross-signed.  This will only be used if the
     * device isolation mode is set to `OnlySignedDevicesIsolationMode`.
     */
    UNSIGNED_SENDER_DEVICE = "UNSIGNED_SENDER_DEVICE",

    /**
     * We weren't able to link the message back to any known device.  This will
     * only be used if the device isolation mode is set to `OnlySignedDevicesIsolationMode`.
     */
    UNKNOWN_SENDER_DEVICE = "UNKNOWN_SENDER_DEVICE",

    /** Unknown or unclassified error. */
    UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/** Base {@link DeviceIsolationMode} kind. */
export enum DeviceIsolationModeKind {
    AllDevicesIsolationMode,
    OnlySignedDevicesIsolationMode,
}

/**
 * A type of {@link DeviceIsolationMode}.
 *
 * Message encryption keys are shared with all devices in the room, except in case of
 * verified user problems (see {@link errorOnVerifiedUserProblems}).
 *
 * Events from all senders are always decrypted (and should be decorated with message shields in case
 * of authenticity warnings, see {@link EventEncryptionInfo}).
 */
export class AllDevicesIsolationMode {
    public readonly kind = DeviceIsolationModeKind.AllDevicesIsolationMode;

    /**
     *
     * @param errorOnVerifiedUserProblems - Behavior when sharing keys to remote devices.
     *
     * If set to `true`, sharing keys will fail (i.e. message sending will fail) with an error if:
     *   - The user was previously verified but is not anymore, or:
     *   - A verified user has some unverified devices (not cross-signed).
     *
     * If `false`, the keys will be distributed as usual. In this case, the client UX should display
     * warnings to inform the user about problematic devices/users, and stop them hitting this case.
     */
    public constructor(public readonly errorOnVerifiedUserProblems: boolean) {}
}

/**
 * A type of {@link DeviceIsolationMode}.
 *
 * Message encryption keys are only shared with devices that have been cross-signed by their owner.
 * Encryption will throw an error if a verified user replaces their identity.
 *
 * Events are decrypted only if they come from a cross-signed device. Other events will result in a decryption
 * failure. (To access the failure reason, see {@link MatrixEvent.decryptionFailureReason}.)
 */
export class OnlySignedDevicesIsolationMode {
    public readonly kind = DeviceIsolationModeKind.OnlySignedDevicesIsolationMode;
}

/**
 * DeviceIsolationMode represents the mode of device isolation used when encrypting or decrypting messages.
 * It can be one of two types: {@link AllDevicesIsolationMode} or {@link OnlySignedDevicesIsolationMode}.
 *
 * Only supported by rust Crypto.
 */
export type DeviceIsolationMode = AllDevicesIsolationMode | OnlySignedDevicesIsolationMode;

/**
 * Options object for `CryptoApi.bootstrapCrossSigning`.
 */
export interface BootstrapCrossSigningOpts {
    /** Optional. Reset the cross-signing keys even if keys already exist. */
    setupNewCrossSigning?: boolean;

    /**
     * An application callback to collect the authentication data for uploading the keys. If not given, the keys
     * will not be uploaded to the server (which seems like a bad thing?).
     */
    authUploadDeviceSigningKeys?: UIAuthCallback<void>;
}

/**
 * Represents the ways in which we trust a user
 */
export class UserVerificationStatus {
    /**
     * Indicates if the identity has changed in a way that needs user approval.
     *
     * This happens if the identity has changed since we first saw it, *unless* the new identity has also been verified
     * by our user (eg via an interactive verification).
     *
     * To rectify this, either:
     *
     *  * Conduct a verification of the new identity via {@link CryptoApi.requestVerificationDM}.
     *  * Pin the new identity, via {@link CryptoApi.pinCurrentUserIdentity}.
     *
     * @returns true if the identity has changed in a way that needs user approval.
     */
    public readonly needsUserApproval: boolean;

    public constructor(
        private readonly crossSigningVerified: boolean,
        private readonly crossSigningVerifiedBefore: boolean,
        private readonly tofu: boolean,
        needsUserApproval: boolean = false,
    ) {
        this.needsUserApproval = needsUserApproval;
    }

    /**
     * @returns true if this user is verified via any means
     */
    public isVerified(): boolean {
        return this.isCrossSigningVerified();
    }

    /**
     * @returns true if this user is verified via cross signing
     */
    public isCrossSigningVerified(): boolean {
        return this.crossSigningVerified;
    }

    /**
     * @returns true if we ever verified this user before (at least for
     * the history of verifications observed by this device).
     */
    public wasCrossSigningVerified(): boolean {
        return this.crossSigningVerifiedBefore;
    }

    /**
     * @returns true if this user's key is trusted on first use
     *
     * @deprecated No longer supported, with the Rust crypto stack.
     */
    public isTofu(): boolean {
        return this.tofu;
    }
}

export class DeviceVerificationStatus {
    /**
     * True if this device has been signed by its owner (and that signature verified).
     *
     * This doesn't necessarily mean that we have verified the device, since we may not have verified the
     * owner's cross-signing key.
     */
    public readonly signedByOwner: boolean;

    /**
     * True if this device has been verified via cross signing.
     *
     * This does *not* take into account `trustCrossSignedDevices`.
     */
    public readonly crossSigningVerified: boolean;

    /**
     * TODO: tofu magic wtf does this do?
     */
    public readonly tofu: boolean;

    /**
     * True if the device has been marked as locally verified.
     */
    public readonly localVerified: boolean;

    /**
     * True if the client has been configured to trust cross-signed devices via {@link CryptoApi#setTrustCrossSignedDevices}.
     */
    private readonly trustCrossSignedDevices: boolean;

    public constructor(
        opts: Partial<DeviceVerificationStatus> & {
            /**
             * True if cross-signed devices should be considered verified for {@link DeviceVerificationStatus#isVerified}.
             */
            trustCrossSignedDevices?: boolean;
        },
    ) {
        this.signedByOwner = opts.signedByOwner ?? false;
        this.crossSigningVerified = opts.crossSigningVerified ?? false;
        this.tofu = opts.tofu ?? false;
        this.localVerified = opts.localVerified ?? false;
        this.trustCrossSignedDevices = opts.trustCrossSignedDevices ?? false;
    }

    /**
     * Check if we should consider this device "verified".
     *
     * A device is "verified" if either:
     *  * it has been manually marked as such via {@link CryptoApi.setDeviceVerified}.
     *  * it has been cross-signed with a verified signing key, **and** the client has been configured to trust
     *    cross-signed devices via {@link CryptoApi.setTrustCrossSignedDevices}.
     *
     * @returns true if this device is verified via any means.
     */
    public isVerified(): boolean {
        return this.localVerified || (this.trustCrossSignedDevices && this.crossSigningVerified);
    }
}

/**
 * Enum representing the different stages of importing room keys.
 *
 * This is the type of the `stage` property of {@link ImportRoomKeyProgressData}.
 */
export enum ImportRoomKeyStage {
    /**
     * The stage where room keys are being fetched.
     *
     * @see {@link ImportRoomKeyFetchProgress}.
     */
    Fetch = "fetch",
    /**
     * The stage where room keys are being loaded.
     *
     * @see {@link ImportRoomKeyLoadProgress}.
     */
    LoadKeys = "load_keys",
}

/**
 * Type representing the progress during the 'fetch' stage of the room key import process.
 *
 * @see {@link ImportRoomKeyProgressData}.
 */
export type ImportRoomKeyFetchProgress = {
    /**
     * The current stage of the import process.
     */
    stage: ImportRoomKeyStage.Fetch;
};

/**
 * Type representing the progress during the 'load_keys' stage of the room key import process.
 *
 * @see {@link ImportRoomKeyProgressData}.
 */
export type ImportRoomKeyLoadProgress = {
    /**
     * The current stage of the import process.
     */
    stage: ImportRoomKeyStage.LoadKeys;

    /**
     * The number of successfully loaded room keys so far.
     */
    successes: number;

    /**
     * The number of room keys that failed to load so far.
     */
    failures: number;

    /**
     * The total number of room keys being loaded.
     */
    total: number;
};

/**
 * Room key import progress report.
 * Used when calling {@link CryptoApi#importRoomKeys},
 * {@link CryptoApi#importRoomKeysAsJson} or {@link CryptoApi#restoreKeyBackup} as the parameter of
 * the progressCallback. Used to display feedback.
 */
export type ImportRoomKeyProgressData = ImportRoomKeyFetchProgress | ImportRoomKeyLoadProgress;

/**
 * Options object for {@link CryptoApi#importRoomKeys} and
 * {@link CryptoApi#importRoomKeysAsJson}.
 */
export interface ImportRoomKeysOpts {
    /** Reports ongoing progress of the import process. Can be used for feedback. */
    progressCallback?: (stage: ImportRoomKeyProgressData) => void;
    /** @deprecated not useful externally */
    source?: string;
}

/**
 * The result of a call to {@link CryptoApi.getCrossSigningStatus}.
 */
export interface CrossSigningStatus {
    /**
     * True if the public master, self signing and user signing keys are available on this device.
     */
    publicKeysOnDevice: boolean;
    /**
     * True if the private keys are stored in the secret storage.
     */
    privateKeysInSecretStorage: boolean;
    /**
     * True if the private keys are stored locally.
     */
    privateKeysCachedLocally: {
        masterKey: boolean;
        selfSigningKey: boolean;
        userSigningKey: boolean;
    };
}

/**
 * Crypto callbacks provided by the application
 */
export interface CryptoCallbacks {
    /**
     * Called to retrieve a secret storage encryption key.
     *
     * [Server-side secret storage](https://spec.matrix.org/v1.12/client-server-api/#key-storage)
     * is, as the name implies, a mechanism for storing secrets which should be shared between
     * clients on the server. For example, it is typically used for storing the
     * [key backup decryption key](https://spec.matrix.org/v1.12/client-server-api/#decryption-key)
     * and the private [cross-signing keys](https://spec.matrix.org/v1.12/client-server-api/#cross-signing).
     *
     * The secret storage mechanism encrypts the secrets before uploading them to the server using a
     * secret storage key. The schema supports multiple keys, but in practice only one tends to be used
     * at once; this is the "default secret storage key" and may be known as the "recovery key" (or, sometimes,
     * the "security key").
     *
     * Secret storage can be set up by calling {@link CryptoApi.bootstrapSecretStorage}. Having done so, when
     * the crypto stack needs to access secret storage (for example, when setting up a new device, or to
     * store newly-generated secrets), it will use this callback (`getSecretStorageKey`).
     *
     * Note that the secret storage key may be needed several times in quick succession: it is recommended
     * that applications use a temporary cache to avoid prompting the user multiple times for the key. See
     * also {@link cacheSecretStorageKey} which is called when a new key is created.
     *
     * The helper method {@link deriveRecoveryKeyFromPassphrase} may be useful if the secret storage key
     * was derived from a passphrase.
     *
     * @param opts - An options object.
     *
     * @param name - the name of the *secret* (NB: not the encryption key) being stored or retrieved.
     *    When the item is stored in account data, it will have this `type`.
     *
     * @returns a pair [`keyId`, `privateKey`], where `keyId` is one of the keys from the `keys` parameter,
     *    and `privateKey` is the raw private encryption key, as appropriate for the encryption algorithm.
     *    (For `m.secret_storage.v1.aes-hmac-sha2`, it is the input to an HKDF as defined in the
     *    [specification](https://spec.matrix.org/v1.6/client-server-api/#msecret_storagev1aes-hmac-sha2).)
     *
     *    Alternatively, if none of the keys are known, may return `null` — in which case the original
     *     operation that requires access to a secret in secret storage may fail with an exception.
     */
    getSecretStorageKey?: (
        opts: {
            /**
             * Details of the secret storage keys required: a map from the key ID
             * (excluding the `m.secret_storage.key.` prefix) to details of the key.
             *
             * When storing a secret, `keys` will contain exactly one entry.
             *
             * For secret retrieval, `keys` may contain several entries, and the application can return
             * any one of the requested keys. Unless your application specifically wants to offer the
             * user the ability to have more than one secret storage key active at a time, it is recommended
             * to call {@link matrix.SecretStorage.ServerSideSecretStorage.getDefaultKeyId | ServerSideSecretStorage.getDefaultKeyId}
             * to figure out which is the current default key, and to return `null` if the default key is not listed in `keys`.
             */
            keys: Record<string, SecretStorageKeyDescription>;
        },
        name: string,
    ) => Promise<[string, Uint8Array] | null>;

    /**
     * Called by {@link CryptoApi.bootstrapSecretStorage} when a new default secret storage key is created.
     *
     * Applications can use this to (temporarily) cache the secret storage key, for later return by
     * {@link getSecretStorageKey}.
     *
     * @param keyId - secret storage key id
     * @param keyInfo - secret storage key info
     * @param key - private key to store
     */
    cacheSecretStorageKey?: (keyId: string, keyInfo: SecretStorageKeyDescription, key: Uint8Array) => void;
}

/**
 * The result of a call to {@link CryptoApi.getSecretStorageStatus}.
 */
export interface SecretStorageStatus {
    /** Whether secret storage is fully populated. The same as {@link CryptoApi.isSecretStorageReady}. */
    ready: boolean;

    /** The ID of the current default secret storage key. */
    defaultKeyId: string | null;

    /**
     * For each secret that we checked whether it is correctly stored in secret storage with the default secret storage key.
     *
     * Note that we will only check that the key backup key is stored if key backup is currently enabled (i.e. that
     * {@link CryptoApi.getActiveSessionBackupVersion} returns non-null). `m.megolm_backup.v1` will only be present in that case.
     *
     * (This is an object rather than a `Map` so that it JSON.stringify()s nicely, since its main purpose is to end up
     * in logs.)
     */
    secretStorageKeyValidityMap: {
        [P in SecretStorageKey]?: boolean;
    };
}

/**
 * Parameter of {@link CryptoApi#bootstrapSecretStorage}
 */
export interface CreateSecretStorageOpts {
    /**
     * Function called to await a secret storage key creation flow.
     * @returns Promise resolving to an object with public key metadata, encoded private
     *     recovery key which should be disposed of after displaying to the user,
     *     and raw private key to avoid round tripping if needed.
     */
    createSecretStorageKey?: () => Promise<GeneratedSecretStorageKey>;

    /**
     * If true, a new key backup version will be
     * created and the private key stored in the new SSSS store. Ignored if keyBackupInfo
     * is supplied.
     */
    setupNewKeyBackup?: boolean;

    /**
     * Reset even if keys already exist.
     */
    setupNewSecretStorage?: boolean;
}

/** Types of cross-signing key */
export enum CrossSigningKey {
    Master = "master",
    SelfSigning = "self_signing",
    UserSigning = "user_signing",
}

/**
 * Information on one of the cross-signing keys.
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3keysdevice_signingupload
 */
export interface CrossSigningKeyInfo {
    keys: { [algorithm: string]: string };
    signatures?: ISignatures;
    usage: string[];
    user_id: string;
}

/**
 * Recovery key created by {@link CryptoApi#createRecoveryKeyFromPassphrase} or {@link CreateSecretStorageOpts#createSecretStorageKey}.
 */
export interface GeneratedSecretStorageKey {
    keyInfo?: {
        /** If the key was derived from a passphrase, information (algorithm, salt, etc) on that derivation. */
        passphrase?: PassphraseInfo;
        /** Optional human-readable name for the key, to be stored in account_data. */
        name?: string;
    };
    /** The raw generated private key. */
    privateKey: Uint8Array;
    /** The generated key, encoded for display to the user per https://spec.matrix.org/v1.7/client-server-api/#key-representation. */
    encodedPrivateKey?: string;
}

/**
 *  Result type of {@link CryptoApi#getEncryptionInfoForEvent}.
 */
export interface EventEncryptionInfo {
    /** "Shield" to be shown next to this event representing its verification status */
    shieldColour: EventShieldColour;

    /**
     * `null` if `shieldColour` is `EventShieldColour.NONE`; otherwise a reason code for the shield in `shieldColour`.
     */
    shieldReason: EventShieldReason | null;
}

/**
 * Types of shield to be shown for {@link EventEncryptionInfo#shieldColour}.
 */
export enum EventShieldColour {
    NONE,
    GREY,
    RED,
}

/**
 * Reason codes for {@link EventEncryptionInfo#shieldReason}.
 */
export enum EventShieldReason {
    /** An unknown reason from the crypto library (if you see this, it is a bug in matrix-js-sdk). */
    UNKNOWN,

    /** "Encrypted by an unverified user." */
    UNVERIFIED_IDENTITY,

    /** "Encrypted by a device not verified by its owner." */
    UNSIGNED_DEVICE,

    /** "Encrypted by an unknown or deleted device." */
    UNKNOWN_DEVICE,

    /**
     * "The authenticity of this encrypted message can't be guaranteed on this device."
     *
     * ie: the key has been forwarded, or retrieved from an insecure backup.
     */
    AUTHENTICITY_NOT_GUARANTEED,

    /**
     * The (deprecated) sender_key field in the event does not match the Ed25519 key of the device that sent us the
     * decryption keys.
     */
    MISMATCHED_SENDER_KEY,

    /**
     * The event was sent unencrypted in an encrypted room.
     */
    SENT_IN_CLEAR,

    /**
     * The sender was previously verified but changed their identity.
     */
    VERIFICATION_VIOLATION,

    /**
     * The `sender` field on the event does not match the owner of the device
     * that established the Megolm session.
     */
    MISMATCHED_SENDER,
}

/** The result of a call to {@link CryptoApi.getOwnDeviceKeys} */
export interface OwnDeviceKeys {
    /** Public part of the Ed25519 fingerprint key for the current device, base64 encoded. */
    ed25519: string;
    /** Public part of the Curve25519 identity key for the current device, base64 encoded. */
    curve25519: string;
}

/**
 * Information about the encryption of a successfully decrypted to-device message.
 */
export interface OlmEncryptionInfo {
    /** The user ID of the event sender, note this is untrusted data unless `isVerified` is true **/
    sender: string;
    /**
     * The device ID of the device that sent us the event.
     * Note this is untrusted data unless {@link senderVerified} is true.
     * If the device ID is not known, this will be `null`.
     **/
    senderDevice?: string;
    /** The sender device's public Curve25519 key, base64 encoded **/
    senderCurve25519KeyBase64: string;
    /**
     *  If true, this message is guaranteed to be authentic as it is coming from a device belonging to a user that we have verified.
     *  This is the state at the time of decryption (the user could be verified later).
     */
    senderVerified: boolean;
}

export * from "./verification.ts";
export type * from "./keybackup.ts";
export * from "./recovery-key.ts";
export * from "./key-passphrase.ts";
export * from "./CryptoEvent.ts";
export type * from "./CryptoEventHandlerMap.ts";
