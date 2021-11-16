/// <reference types="node" />
import { EventEmitter } from 'events';
import { IExportedDevice, OlmDevice } from "./OlmDevice";
import * as olmlib from "./olmlib";
import { DeviceInfoMap, DeviceList } from "./DeviceList";
import { DeviceInfo } from "./deviceinfo";
import { CrossSigningInfo, DeviceTrustLevel, UserTrustLevel } from './CrossSigning';
import { SecretStorage, SecretStorageKeyTuple, ISecretRequest, SecretStorageKeyObject } from './SecretStorage';
import { IAddSecretStorageKeyOpts, IImportRoomKeysOpts, ISecretStorageKeyInfo } from "./api";
import { VerificationRequest } from "./verification/request/VerificationRequest";
import { InRoomRequests } from "./verification/request/InRoomChannel";
import { DehydrationManager } from './dehydration';
import { BackupManager } from "./backup";
import { IStore } from "../store";
import { Room } from "../models/room";
import { MatrixEvent } from "../models/event";
import { MatrixClient, IKeysUploadResponse, SessionStore } from "../client";
import type { DecryptionAlgorithm } from "./algorithms/base";
import type { IRoomEncryption, RoomList } from "./RoomList";
import { IRecoveryKey, IEncryptedEventInfo } from "./api";
import { ISyncStateData } from "../sync";
import { CryptoStore } from "./store/base";
/**
 * verification method names
 */
export declare const verificationMethods: {
    RECIPROCATE_QR_CODE: string;
    SAS: string;
};
export declare type VerificationMethod = keyof typeof verificationMethods | string;
export declare function isCryptoAvailable(): boolean;
interface IInitOpts {
    exportedOlmDevice?: IExportedDevice;
    pickleKey?: string;
}
export interface IBootstrapCrossSigningOpts {
    setupNewCrossSigning?: boolean;
    authUploadDeviceSigningKeys?(makeRequest: (authData: any) => {}): Promise<void>;
}
interface IBootstrapSecretStorageOpts {
    keyBackupInfo?: any;
    setupNewKeyBackup?: boolean;
    setupNewSecretStorage?: boolean;
    createSecretStorageKey?(): Promise<{
        keyInfo?: any;
        privateKey?: Uint8Array;
    }>;
    getKeyBackupPassphrase?(): Promise<Uint8Array | null>;
}
interface IRoomKey {
    room_id: string;
    algorithm: string;
}
export interface IRoomKeyRequestBody extends IRoomKey {
    session_id: string;
    sender_key: string;
}
export interface IMegolmSessionData {
    [key: string]: any;
    sender_key: string;
    forwarding_curve25519_key_chain: string[];
    sender_claimed_keys: Record<string, string>;
    room_id: string;
    session_id: string;
    session_key: string;
    algorithm?: string;
    untrusted?: boolean;
}
export interface ICheckOwnCrossSigningTrustOpts {
    allowPrivateKeyRequests?: boolean;
}
/**
 * @typedef {Object} module:crypto~OlmSessionResult
 * @property {module:crypto/deviceinfo} device  device info
 * @property {string?} sessionId base64 olm session id; null if no session
 *    could be established
 */
interface IUserOlmSession {
    deviceIdKey: string;
    sessions: {
        sessionId: string;
        hasReceivedMessage: boolean;
    }[];
}
interface ISyncDeviceLists {
    changed: string[];
    left: string[];
}
export interface IRoomKeyRequestRecipient {
    userId: string;
    deviceId: string;
}
interface ISignableObject {
    signatures?: object;
    unsigned?: object;
}
export interface IEventDecryptionResult {
    clearEvent: object;
    senderCurve25519Key?: string;
    claimedEd25519Key?: string;
    forwardingCurve25519KeyChain?: string[];
    untrusted?: boolean;
}
export declare class Crypto extends EventEmitter {
    readonly baseApis: MatrixClient;
    readonly sessionStore: SessionStore;
    readonly userId: string;
    private readonly deviceId;
    private readonly clientStore;
    readonly cryptoStore: CryptoStore;
    private readonly roomList;
    /**
     * @return {string} The version of Olm.
     */
    static getOlmVersion(): [number, number, number];
    readonly backupManager: BackupManager;
    readonly crossSigningInfo: CrossSigningInfo;
    readonly olmDevice: OlmDevice;
    readonly deviceList: DeviceList;
    readonly dehydrationManager: DehydrationManager;
    readonly secretStorage: SecretStorage;
    private readonly reEmitter;
    private readonly verificationMethods;
    readonly supportedAlgorithms: string[];
    private readonly outgoingRoomKeyRequestManager;
    private readonly toDeviceVerificationRequests;
    readonly inRoomVerificationRequests: InRoomRequests;
    private trustCrossSignedDevices;
    private lastOneTimeKeyCheck;
    private oneTimeKeyCheckInProgress;
    private roomEncryptors;
    private roomDecryptors;
    private deviceKeys;
    private globalBlacklistUnverifiedDevices;
    private globalErrorOnUnknownDevices;
    private receivedRoomKeyRequests;
    private receivedRoomKeyRequestCancellations;
    private processingRoomKeyRequests;
    private lazyLoadMembers;
    private roomDeviceTrackingState;
    private lastNewSessionForced;
    private sendKeyRequestsImmediately;
    private oneTimeKeyCount;
    private needsNewFallback;
    /**
     * Cryptography bits
     *
     * This module is internal to the js-sdk; the public API is via MatrixClient.
     *
     * @constructor
     * @alias module:crypto
     *
     * @internal
     *
     * @param {MatrixClient} baseApis base matrix api interface
     *
     * @param {module:store/session/webstorage~WebStorageSessionStore} sessionStore
     *    Store to be used for end-to-end crypto session data
     *
     * @param {string} userId The user ID for the local user
     *
     * @param {string} deviceId The identifier for this device.
     *
     * @param {Object} clientStore the MatrixClient data store.
     *
     * @param {module:crypto/store/base~CryptoStore} cryptoStore
     *    storage for the crypto layer.
     *
     * @param {RoomList} roomList An initialised RoomList object
     *
     * @param {Array} verificationMethods Array of verification methods to use.
     *    Each element can either be a string from MatrixClient.verificationMethods
     *    or a class that implements a verification method.
     */
    constructor(baseApis: MatrixClient, sessionStore: SessionStore, userId: string, deviceId: string, clientStore: IStore, cryptoStore: CryptoStore, roomList: RoomList, verificationMethods: any[]);
    /**
     * Initialise the crypto module so that it is ready for use
     *
     * Returns a promise which resolves once the crypto module is ready for use.
     *
     * @param {Object} opts keyword arguments.
     * @param {string} opts.exportedOlmDevice (Optional) data from exported device
     *     that must be re-created.
     */
    init({ exportedOlmDevice, pickleKey }?: IInitOpts): Promise<void>;
    /**
     * Whether to trust a others users signatures of their devices.
     * If false, devices will only be considered 'verified' if we have
     * verified that device individually (effectively disabling cross-signing).
     *
     * Default: true
     *
     * @return {boolean} True if trusting cross-signed devices
     */
    getCryptoTrustCrossSignedDevices(): boolean;
    /**
     * See getCryptoTrustCrossSignedDevices

     * This may be set before initCrypto() is called to ensure no races occur.
     *
     * @param {boolean} val True to trust cross-signed devices
     */
    setCryptoTrustCrossSignedDevices(val: boolean): void;
    /**
     * Create a recovery key from a user-supplied passphrase.
     *
     * @param {string} password Passphrase string that can be entered by the user
     *     when restoring the backup as an alternative to entering the recovery key.
     *     Optional.
     * @returns {Promise<Object>} Object with public key metadata, encoded private
     *     recovery key which should be disposed of after displaying to the user,
     *     and raw private key to avoid round tripping if needed.
     */
    createRecoveryKeyFromPassphrase(password?: string): Promise<IRecoveryKey>;
    /**
     * Checks whether cross signing:
     * - is enabled on this account and trusted by this device
     * - has private keys either cached locally or stored in secret storage
     *
     * If this function returns false, bootstrapCrossSigning() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapCrossSigning() completes successfully, this function should
     * return true.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @return {boolean} True if cross-signing is ready to be used on this device
     */
    isCrossSigningReady(): Promise<boolean>;
    /**
     * Checks whether secret storage:
     * - is enabled on this account
     * - is storing cross-signing private keys
     * - is storing session backup key (if enabled)
     *
     * If this function returns false, bootstrapSecretStorage() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapSecretStorage() completes successfully, this function should
     * return true.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @return {boolean} True if secret storage is ready to be used on this device
     */
    isSecretStorageReady(): Promise<boolean>;
    /**
     * Bootstrap cross-signing by creating keys if needed. If everything is already
     * set up, then no changes are made, so this is safe to run to ensure
     * cross-signing is ready for use.
     *
     * This function:
     * - creates new cross-signing keys if they are not found locally cached nor in
     *   secret storage (if it has been setup)
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {function} opts.authUploadDeviceSigningKeys Function
     * called to await an interactive auth flow when uploading device signing keys.
     * @param {boolean} [opts.setupNewCrossSigning] Optional. Reset even if keys
     * already exist.
     * Args:
     *     {function} A function that makes the request requiring auth. Receives the
     *     auth data as an object. Can be called multiple times, first with an empty
     *     authDict, to obtain the flows.
     */
    bootstrapCrossSigning({ authUploadDeviceSigningKeys, setupNewCrossSigning, }?: IBootstrapCrossSigningOpts): Promise<void>;
    /**
     * Bootstrap Secure Secret Storage if needed by creating a default key. If everything is
     * already set up, then no changes are made, so this is safe to run to ensure secret
     * storage is ready for use.
     *
     * This function
     * - creates a new Secure Secret Storage key if no default key exists
     *   - if a key backup exists, it is migrated to store the key in the Secret
     *     Storage
     * - creates a backup if none exists, and one is requested
     * - migrates Secure Secret Storage to use the latest algorithm, if an outdated
     *   algorithm is found
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {function} [opts.createSecretStorageKey] Optional. Function
     * called to await a secret storage key creation flow.
     * Returns:
     *     {Promise<Object>} Object with public key metadata, encoded private
     *     recovery key which should be disposed of after displaying to the user,
     *     and raw private key to avoid round tripping if needed.
     * @param {object} [opts.keyBackupInfo] The current key backup object. If passed,
     * the passphrase and recovery key from this backup will be used.
     * @param {boolean} [opts.setupNewKeyBackup] If true, a new key backup version will be
     * created and the private key stored in the new SSSS store. Ignored if keyBackupInfo
     * is supplied.
     * @param {boolean} [opts.setupNewSecretStorage] Optional. Reset even if keys already exist.
     * @param {func} [opts.getKeyBackupPassphrase] Optional. Function called to get the user's
     *     current key backup passphrase. Should return a promise that resolves with a Buffer
     *     containing the key, or rejects if the key cannot be obtained.
     * Returns:
     *     {Promise} A promise which resolves to key creation data for
     *     SecretStorage#addKey: an object with `passphrase` etc fields.
     */
    bootstrapSecretStorage({ createSecretStorageKey, keyBackupInfo, setupNewKeyBackup, setupNewSecretStorage, getKeyBackupPassphrase, }?: IBootstrapSecretStorageOpts): Promise<void>;
    addSecretStorageKey(algorithm: string, opts: IAddSecretStorageKeyOpts, keyID: string): Promise<SecretStorageKeyObject>;
    hasSecretStorageKey(keyID: string): Promise<boolean>;
    getSecretStorageKey(keyID?: string): Promise<SecretStorageKeyTuple>;
    storeSecret(name: string, secret: string, keys?: string[]): Promise<void>;
    getSecret(name: string): Promise<string>;
    isSecretStored(name: string, checkKey?: boolean): Promise<Record<string, ISecretStorageKeyInfo>>;
    requestSecret(name: string, devices: string[]): ISecretRequest;
    getDefaultSecretStorageKeyId(): Promise<string>;
    setDefaultSecretStorageKeyId(k: string): Promise<void>;
    checkSecretStorageKey(key: Uint8Array, info: ISecretStorageKeyInfo): Promise<boolean>;
    /**
     * Checks that a given secret storage private key matches a given public key.
     * This can be used by the getSecretStorageKey callback to verify that the
     * private key it is about to supply is the one that was requested.
     *
     * @param {Uint8Array} privateKey The private key
     * @param {string} expectedPublicKey The public key
     * @returns {boolean} true if the key matches, otherwise false
     */
    checkSecretStoragePrivateKey(privateKey: Uint8Array, expectedPublicKey: string): boolean;
    /**
     * Fetches the backup private key, if cached
     * @returns {Promise} the key, if any, or null
     */
    getSessionBackupPrivateKey(): Promise<Uint8Array | null>;
    /**
     * Stores the session backup key to the cache
     * @param {Uint8Array} key the private key
     * @returns {Promise} so you can catch failures
     */
    storeSessionBackupPrivateKey(key: ArrayLike<number>): Promise<void>;
    /**
     * Checks that a given cross-signing private key matches a given public key.
     * This can be used by the getCrossSigningKey callback to verify that the
     * private key it is about to supply is the one that was requested.
     *
     * @param {Uint8Array} privateKey The private key
     * @param {string} expectedPublicKey The public key
     * @returns {boolean} true if the key matches, otherwise false
     */
    checkCrossSigningPrivateKey(privateKey: Uint8Array, expectedPublicKey: string): boolean;
    /**
     * Run various follow-up actions after cross-signing keys have changed locally
     * (either by resetting the keys for the account or by getting them from secret
     * storage), such as signing the current device, upgrading device
     * verifications, etc.
     */
    private afterCrossSigningLocalKeyChange;
    /**
     * Check if a user's cross-signing key is a candidate for upgrading from device
     * verification.
     *
     * @param {string} userId the user whose cross-signing information is to be checked
     * @param {object} crossSigningInfo the cross-signing information to check
     */
    private checkForDeviceVerificationUpgrade;
    /**
     * Check if the cross-signing key is signed by a verified device.
     *
     * @param {string} userId the user ID whose key is being checked
     * @param {object} key the key that is being checked
     * @param {object} devices the user's devices.  Should be a map from device ID
     *     to device info
     */
    private checkForValidDeviceSignature;
    /**
     * Get the user's cross-signing key ID.
     *
     * @param {string} [type=master] The type of key to get the ID of.  One of
     *     "master", "self_signing", or "user_signing".  Defaults to "master".
     *
     * @returns {string} the key ID
     */
    getCrossSigningId(type: string): string;
    /**
     * Get the cross signing information for a given user.
     *
     * @param {string} userId the user ID to get the cross-signing info for.
     *
     * @returns {CrossSigningInfo} the cross signing information for the user.
     */
    getStoredCrossSigningForUser(userId: string): CrossSigningInfo;
    /**
     * Check whether a given user is trusted.
     *
     * @param {string} userId The ID of the user to check.
     *
     * @returns {UserTrustLevel}
     */
    checkUserTrust(userId: string): UserTrustLevel;
    /**
     * Check whether a given device is trusted.
     *
     * @param {string} userId The ID of the user whose devices is to be checked.
     * @param {string} deviceId The ID of the device to check
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceTrust(userId: string, deviceId: string): DeviceTrustLevel;
    /**
     * Check whether a given deviceinfo is trusted.
     *
     * @param {string} userId The ID of the user whose devices is to be checked.
     * @param {module:crypto/deviceinfo?} device The device info object to check
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceInfoTrust(userId: string, device: DeviceInfo): DeviceTrustLevel;
    private onDeviceListUserCrossSigningUpdated;
    /**
     * Check the copy of our cross-signing key that we have in the device list and
     * see if we can get the private key. If so, mark it as trusted.
     */
    checkOwnCrossSigningTrust({ allowPrivateKeyRequests, }?: ICheckOwnCrossSigningTrustOpts): Promise<void>;
    /**
     * Store a set of keys as our own, trusted, cross-signing keys.
     *
     * @param {object} keys The new trusted set of keys
     */
    private storeTrustedSelfKeys;
    /**
     * Check if the master key is signed by a verified device, and if so, prompt
     * the application to mark it as verified.
     *
     * @param {string} userId the user ID whose key should be checked
     */
    private checkDeviceVerifications;
    setTrustedBackupPubKey(trustedPubKey: string): Promise<void>;
    /**
     */
    enableLazyLoading(): void;
    /**
     * Tell the crypto module to register for MatrixClient events which it needs to
     * listen for
     *
     * @param {external:EventEmitter} eventEmitter event source where we can register
     *    for event notifications
     */
    registerEventHandlers(eventEmitter: EventEmitter): void;
    /** Start background processes related to crypto */
    start(): void;
    /** Stop background processes related to crypto */
    stop(): void;
    /**
     * Get the Ed25519 key for this device
     *
     * @return {string} base64-encoded ed25519 key.
     */
    getDeviceEd25519Key(): string;
    /**
     * Get the Curve25519 key for this device
     *
     * @return {string} base64-encoded curve25519 key.
     */
    getDeviceCurve25519Key(): string;
    /**
     * Set the global override for whether the client should ever send encrypted
     * messages to unverified devices.  This provides the default for rooms which
     * do not specify a value.
     *
     * @param {boolean} value whether to blacklist all unverified devices by default
     */
    setGlobalBlacklistUnverifiedDevices(value: boolean): void;
    /**
     * @return {boolean} whether to blacklist all unverified devices by default
     */
    getGlobalBlacklistUnverifiedDevices(): boolean;
    /**
     * Set whether sendMessage in a room with unknown and unverified devices
     * should throw an error and not send them message. This has 'Global' for
     * symmetry with setGlobalBlacklistUnverifiedDevices but there is currently
     * no room-level equivalent for this setting.
     *
     * This API is currently UNSTABLE and may change or be removed without notice.
     *
     * @param {boolean} value whether error on unknown devices
     */
    setGlobalErrorOnUnknownDevices(value: boolean): void;
    /**
     * @return {boolean} whether to error on unknown devices
     *
     * This API is currently UNSTABLE and may change or be removed without notice.
     */
    getGlobalErrorOnUnknownDevices(): boolean;
    /**
     * Upload the device keys to the homeserver.
     * @return {object} A promise that will resolve when the keys are uploaded.
     */
    uploadDeviceKeys(): Promise<IKeysUploadResponse>;
    /**
     * Stores the current one_time_key count which will be handled later (in a call of
     * onSyncCompleted). The count is e.g. coming from a /sync response.
     *
     * @param {Number} currentCount The current count of one_time_keys to be stored
     */
    updateOneTimeKeyCount(currentCount: number): void;
    setNeedsNewFallback(needsNewFallback: boolean): void;
    getNeedsNewFallback(): boolean;
    private maybeUploadOneTimeKeys;
    private uploadOneTimeKeys;
    /**
     * Download the keys for a list of users and stores the keys in the session
     * store.
     * @param {Array} userIds The users to fetch.
     * @param {boolean} forceDownload Always download the keys even if cached.
     *
     * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
        * module:crypto/deviceinfo|DeviceInfo}.
     */
    downloadKeys(userIds: string[], forceDownload?: boolean): Promise<DeviceInfoMap>;
    /**
     * Get the stored device keys for a user id
     *
     * @param {string} userId the user to list keys for.
     *
     * @return {module:crypto/deviceinfo[]|null} list of devices, or null if we haven't
     * managed to get a list of devices for this user yet.
     */
    getStoredDevicesForUser(userId: string): Array<DeviceInfo> | null;
    /**
     * Get the stored keys for a single device
     *
     * @param {string} userId
     * @param {string} deviceId
     *
     * @return {module:crypto/deviceinfo?} device, or undefined
     * if we don't know about this device
     */
    getStoredDevice(userId: string, deviceId: string): DeviceInfo | undefined;
    /**
     * Save the device list, if necessary
     *
     * @param {number} delay Time in ms before which the save actually happens.
     *     By default, the save is delayed for a short period in order to batch
     *     multiple writes, but this behaviour can be disabled by passing 0.
     *
     * @return {Promise<boolean>} true if the data was saved, false if
     *     it was not (eg. because no changes were pending). The promise
     *     will only resolve once the data is saved, so may take some time
     *     to resolve.
     */
    saveDeviceList(delay: number): Promise<boolean>;
    /**
     * Update the blocked/verified state of the given device
     *
     * @param {string} userId owner of the device
     * @param {string} deviceId unique identifier for the device or user's
     * cross-signing public key ID.
     *
     * @param {?boolean} verified whether to mark the device as verified. Null to
     *     leave unchanged.
     *
     * @param {?boolean} blocked whether to mark the device as blocked. Null to
     *      leave unchanged.
     *
     * @param {?boolean} known whether to mark that the user has been made aware of
     *      the existence of this device. Null to leave unchanged
     *
     * @return {Promise<module:crypto/deviceinfo>} updated DeviceInfo
     */
    setDeviceVerification(userId: string, deviceId: string, verified?: boolean, blocked?: boolean, known?: boolean): Promise<DeviceInfo | CrossSigningInfo>;
    findVerificationRequestDMInProgress(roomId: string): VerificationRequest;
    getVerificationRequestsToDeviceInProgress(userId: string): VerificationRequest[];
    requestVerificationDM(userId: string, roomId: string): Promise<VerificationRequest>;
    requestVerification(userId: string, devices: string[]): Promise<VerificationRequest>;
    private requestVerificationWithChannel;
    beginKeyVerification(method: string, userId: string, deviceId: string, transactionId?: string): any;
    legacyDeviceVerification(userId: string, deviceId: string, method: VerificationMethod): Promise<VerificationRequest>;
    /**
     * Get information on the active olm sessions with a user
     * <p>
     * Returns a map from device id to an object with keys 'deviceIdKey' (the
     * device's curve25519 identity key) and 'sessions' (an array of objects in the
     * same format as that returned by
     * {@link module:crypto/OlmDevice#getSessionInfoForDevice}).
     * <p>
     * This method is provided for debugging purposes.
     *
     * @param {string} userId id of user to inspect
     *
     * @return {Promise<Object.<string, {deviceIdKey: string, sessions: object[]}>>}
     */
    getOlmSessionsForUser(userId: string): Promise<Record<string, IUserOlmSession>>;
    /**
     * Get the device which sent an event
     *
     * @param {module:models/event.MatrixEvent} event event to be checked
     *
     * @return {module:crypto/deviceinfo?}
     */
    getEventSenderDeviceInfo(event: MatrixEvent): DeviceInfo | null;
    /**
     * Get information about the encryption of an event
     *
     * @param {module:models/event.MatrixEvent} event event to be checked
     *
     * @return {object} An object with the fields:
     *    - encrypted: whether the event is encrypted (if not encrypted, some of the
     *      other properties may not be set)
     *    - senderKey: the sender's key
     *    - algorithm: the algorithm used to encrypt the event
     *    - authenticated: whether we can be sure that the owner of the senderKey
     *      sent the event
     *    - sender: the sender's device information, if available
     *    - mismatchedSender: if the event's ed25519 and curve25519 keys don't match
     *      (only meaningful if `sender` is set)
     */
    getEventEncryptionInfo(event: MatrixEvent): IEncryptedEventInfo;
    /**
     * Forces the current outbound group session to be discarded such
     * that another one will be created next time an event is sent.
     *
     * @param {string} roomId The ID of the room to discard the session for
     *
     * This should not normally be necessary.
     */
    forceDiscardSession(roomId: string): void;
    /**
     * Configure a room to use encryption (ie, save a flag in the cryptoStore).
     *
     * @param {string} roomId The room ID to enable encryption in.
     *
     * @param {object} config The encryption config for the room.
     *
     * @param {boolean=} inhibitDeviceQuery true to suppress device list query for
     *   users in the room (for now). In case lazy loading is enabled,
     *   the device query is always inhibited as the members are not tracked.
     */
    setRoomEncryption(roomId: string, config: IRoomEncryption, inhibitDeviceQuery?: boolean): Promise<void>;
    /**
     * Make sure we are tracking the device lists for all users in this room.
     *
     * @param {string} roomId The room ID to start tracking devices in.
     * @returns {Promise} when all devices for the room have been fetched and marked to track
     */
    trackRoomDevices(roomId: string): Promise<void>;
    /**
     * Try to make sure we have established olm sessions for all known devices for
     * the given users.
     *
     * @param {string[]} users list of user ids
     *
     * @return {Promise} resolves once the sessions are complete, to
     *    an Object mapping from userId to deviceId to
     *    {@link module:crypto~OlmSessionResult}
     */
    ensureOlmSessionsForUsers(users: string[]): Promise<Record<string, Record<string, olmlib.IOlmSessionResult>>>;
    /**
     * Get a list containing all of the room keys
     *
     * @return {module:crypto/OlmDevice.MegolmSessionData[]} a list of session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;
    /**
     * Import a list of room keys previously exported by exportRoomKeys
     *
     * @param {Object[]} keys a list of session export objects
     * @param {Object} opts
     * @param {Function} opts.progressCallback called with an object which has a stage param
     * @return {Promise} a promise which resolves once the keys have been imported
     */
    importRoomKeys(keys: IMegolmSessionData[], opts?: IImportRoomKeysOpts): Promise<any>;
    /**
     * Counts the number of end to end session keys that are waiting to be backed up
     * @returns {Promise<number>} Resolves to the number of sessions requiring backup
     */
    countSessionsNeedingBackup(): Promise<number>;
    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param {module:models/room} room the room the event is in
     */
    prepareToEncrypt(room: Room): void;
    /**
     * Encrypt an event according to the configuration of the room.
     *
     * @param {module:models/event.MatrixEvent} event  event to be sent
     *
     * @param {module:models/room} room destination room.
     *
     * @return {Promise?} Promise which resolves when the event has been
     *     encrypted, or null if nothing was needed
     */
    encryptEvent(event: MatrixEvent, room: Room): Promise<void>;
    /**
     * Decrypt a received event
     *
     * @param {MatrixEvent} event
     *
     * @return {Promise<module:crypto~EventDecryptionResult>} resolves once we have
     *  finished decrypting. Rejects with an `algorithms.DecryptionError` if there
     *  is a problem decrypting the event.
     */
    decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult>;
    /**
     * Handle the notification from /sync or /keys/changes that device lists have
     * been changed.
     *
     * @param {Object} syncData Object containing sync tokens associated with this sync
     * @param {Object} syncDeviceLists device_lists field from /sync, or response from
     * /keys/changes
     */
    handleDeviceListChanges(syncData: ISyncStateData, syncDeviceLists: ISyncDeviceLists): Promise<void>;
    /**
     * Send a request for some room keys, if we have not already done so
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     * @param {Array<{userId: string, deviceId: string}>} recipients
     * @param {boolean} resend whether to resend the key request if there is
     *    already one
     *
     * @return {Promise} a promise that resolves when the key request is queued
     */
    requestRoomKey(requestBody: IRoomKeyRequestBody, recipients: IRoomKeyRequestRecipient[], resend?: boolean): Promise<void>;
    /**
     * Cancel any earlier room key request
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    parameters to match for cancellation
     */
    cancelRoomKeyRequest(requestBody: IRoomKeyRequestBody): void;
    /**
     * Re-send any outgoing key requests, eg after verification
     * @returns {Promise}
     */
    cancelAndResendAllOutgoingKeyRequests(): Promise<void>;
    /**
     * handle an m.room.encryption event
     *
     * @param {module:models/event.MatrixEvent} event encryption event
     */
    onCryptoEvent(event: MatrixEvent): Promise<void>;
    /**
     * Called before the result of a sync is processed
     *
     * @param {Object} syncData  the data from the 'MatrixClient.sync' event
     */
    onSyncWillProcess(syncData: ISyncStateData): Promise<void>;
    /**
     * handle the completion of a /sync
     *
     * This is called after the processing of each successful /sync response.
     * It is an opportunity to do a batch process on the information received.
     *
     * @param {Object} syncData  the data from the 'MatrixClient.sync' event
     */
    onSyncCompleted(syncData: ISyncStateData): Promise<void>;
    /**
     * Trigger the appropriate invalidations and removes for a given
     * device list
     *
     * @param {Object} deviceLists device_lists field from /sync, or response from
     * /keys/changes
     */
    private evalDeviceListChanges;
    /**
     * Get a list of all the IDs of users we share an e2e room with
     * for which we are tracking devices already
     *
     * @returns {string[]} List of user IDs
     */
    private getTrackedE2eUsers;
    /**
     * Get a list of the e2e-enabled rooms we are members of,
     * and for which we are already tracking the devices
     *
     * @returns {module:models.Room[]}
     */
    private getTrackedE2eRooms;
    private onToDeviceEvent;
    /**
     * Handle a key event
     *
     * @private
     * @param {module:models/event.MatrixEvent} event key event
     */
    private onRoomKeyEvent;
    /**
     * Handle a key withheld event
     *
     * @private
     * @param {module:models/event.MatrixEvent} event key withheld event
     */
    private onRoomKeyWithheldEvent;
    /**
     * Handle a general key verification event.
     *
     * @private
     * @param {module:models/event.MatrixEvent} event verification start event
     */
    private onKeyVerificationMessage;
    /**
     * Handle key verification requests sent as timeline events
     *
     * @private
     * @param {module:models/event.MatrixEvent} event the timeline event
     * @param {module:models/Room} room not used
     * @param {boolean} atStart not used
     * @param {boolean} removed not used
     * @param {boolean} { liveEvent } whether this is a live event
     */
    private onTimelineEvent;
    private handleVerificationEvent;
    /**
     * Handle a toDevice event that couldn't be decrypted
     *
     * @private
     * @param {module:models/event.MatrixEvent} event undecryptable event
     */
    private onToDeviceBadEncrypted;
    /**
     * Handle a change in the membership state of a member of a room
     *
     * @private
     * @param {module:models/event.MatrixEvent} event  event causing the change
     * @param {module:models/room-member} member  user whose membership changed
     * @param {string=} oldMembership  previous membership
     */
    private onRoomMembership;
    /**
     * Called when we get an m.room_key_request event.
     *
     * @private
     * @param {module:models/event.MatrixEvent} event key request event
     */
    private onRoomKeyRequestEvent;
    /**
     * Process any m.room_key_request events which were queued up during the
     * current sync.
     *
     * @private
     */
    private processReceivedRoomKeyRequests;
    /**
     * Helper for processReceivedRoomKeyRequests
     *
     * @param {IncomingRoomKeyRequest} req
     */
    private processReceivedRoomKeyRequest;
    /**
     * Helper for processReceivedRoomKeyRequests
     *
     * @param {IncomingRoomKeyRequestCancellation} cancellation
     */
    private processReceivedRoomKeyRequestCancellation;
    /**
     * Get a decryptor for a given room and algorithm.
     *
     * If we already have a decryptor for the given room and algorithm, return
     * it. Otherwise try to instantiate it.
     *
     * @private
     *
     * @param {string?} roomId   room id for decryptor. If undefined, a temporary
     * decryptor is instantiated.
     *
     * @param {string} algorithm  crypto algorithm
     *
     * @return {module:crypto.algorithms.base.DecryptionAlgorithm}
     *
     * @raises {module:crypto.algorithms.DecryptionError} if the algorithm is
     * unknown
     */
    getRoomDecryptor(roomId: string, algorithm: string): DecryptionAlgorithm;
    /**
     * Get all the room decryptors for a given encryption algorithm.
     *
     * @param {string} algorithm The encryption algorithm
     *
     * @return {array} An array of room decryptors
     */
    private getRoomDecryptors;
    /**
     * sign the given object with our ed25519 key
     *
     * @param {Object} obj  Object to which we will add a 'signatures' property
     */
    signObject(obj: object & ISignableObject): Promise<void>;
}
/**
 * Fix up the backup key, that may be in the wrong format due to a bug in a
 * migration step.  Some backup keys were stored as a comma-separated list of
 * integers, rather than a base64-encoded byte array.  If this function is
 * passed a string that looks like a list of integers rather than a base64
 * string, it will attempt to convert it to the right format.
 *
 * @param {string} key the key to check
 * @returns {null | string} If the key is in the wrong format, then the fixed
 * key will be returned. Otherwise null will be returned.
 *
 */
export declare function fixBackupKey(key: string): string | null;
/**
 * The parameters of a room key request. The details of the request may
 * vary with the crypto algorithm, but the management and storage layers for
 * outgoing requests expect it to have 'room_id' and 'session_id' properties.
 *
 * @typedef {Object} RoomKeyRequestBody
 */
/**
 * Represents a received m.room_key_request event
 *
 * @property {string} userId    user requesting the key
 * @property {string} deviceId  device requesting the key
 * @property {string} requestId unique id for the request
 * @property {module:crypto~RoomKeyRequestBody} requestBody
 * @property {function()} share  callback which, when called, will ask
 *    the relevant crypto algorithm implementation to share the keys for
 *    this request.
 */
export declare class IncomingRoomKeyRequest {
    readonly userId: string;
    readonly deviceId: string;
    readonly requestId: string;
    readonly requestBody: IRoomKeyRequestBody;
    share: () => void;
    constructor(event: MatrixEvent);
}
export {};
/**
 * The result of a (successful) call to decryptEvent.
 *
 * @typedef {Object} EventDecryptionResult
 *
 * @property {Object} clearEvent The plaintext payload for the event
 *     (typically containing <tt>type</tt> and <tt>content</tt> fields).
 *
 * @property {?string} senderCurve25519Key Key owned by the sender of this
 *    event.  See {@link module:models/event.MatrixEvent#getSenderKey}.
 *
 * @property {?string} claimedEd25519Key ed25519 key claimed by the sender of
 *    this event. See
 *    {@link module:models/event.MatrixEvent#getClaimedEd25519Key}.
 *
 * @property {?Array<string>} forwardingCurve25519KeyChain list of curve25519
 *     keys involved in telling us about the senderCurve25519Key and
 *     claimedEd25519Key. See
 *     {@link module:models/event.MatrixEvent#getForwardingCurve25519KeyChain}.
 */
/**
 * Fires when we receive a room key request
 *
 * @event module:client~MatrixClient#"crypto.roomKeyRequest"
 * @param {module:crypto~IncomingRoomKeyRequest} req  request details
 */
/**
 * Fires when we receive a room key request cancellation
 *
 * @event module:client~MatrixClient#"crypto.roomKeyRequestCancellation"
 * @param {module:crypto~IncomingRoomKeyRequestCancellation} req
 */
/**
 * Fires when the app may wish to warn the user about something related
 * the end-to-end crypto.
 *
 * @event module:client~MatrixClient#"crypto.warning"
 * @param {string} type One of the strings listed above
 */
//# sourceMappingURL=index.d.ts.map