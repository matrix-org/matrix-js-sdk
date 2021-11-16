/// <reference types="node" />
/**
 * Cross signing methods
 * @module crypto/CrossSigning
 */
import { EventEmitter } from 'events';
import { PkSigning } from "@matrix-org/olm";
import { DeviceInfo } from "./deviceinfo";
import { SecretStorage } from "./SecretStorage";
import { ICrossSigningKey, ISignedKey, MatrixClient } from "../client";
import { OlmDevice } from "./OlmDevice";
import { ICryptoCallbacks } from "../matrix";
import { ISignatures } from "../@types/signed";
import { CryptoStore } from "./store/base";
export interface ICacheCallbacks {
    getCrossSigningKeyCache?(type: string, expectedPublicKey?: string): Promise<Uint8Array>;
    storeCrossSigningKeyCache?(type: string, key: Uint8Array): Promise<void>;
}
export interface ICrossSigningInfo {
    keys: Record<string, ICrossSigningKey>;
    firstUse: boolean;
    crossSigningVerifiedBefore: boolean;
}
export declare class CrossSigningInfo extends EventEmitter {
    readonly userId: string;
    private callbacks;
    private cacheCallbacks;
    keys: Record<string, ICrossSigningKey>;
    firstUse: boolean;
    private crossSigningVerifiedBefore;
    /**
     * Information about a user's cross-signing keys
     *
     * @class
     *
     * @param {string} userId the user that the information is about
     * @param {object} callbacks Callbacks used to interact with the app
     *     Requires getCrossSigningKey and saveCrossSigningKeys
     * @param {object} cacheCallbacks Callbacks used to interact with the cache
     */
    constructor(userId: string, callbacks?: ICryptoCallbacks, cacheCallbacks?: ICacheCallbacks);
    static fromStorage(obj: ICrossSigningInfo, userId: string): CrossSigningInfo;
    toStorage(): ICrossSigningInfo;
    /**
     * Calls the app callback to ask for a private key
     *
     * @param {string} type The key type ("master", "self_signing", or "user_signing")
     * @param {string} expectedPubkey The matching public key or undefined to use
     *     the stored public key for the given key type.
     * @returns {Array} An array with [ public key, Olm.PkSigning ]
     */
    getCrossSigningKey(type: string, expectedPubkey?: string): Promise<[string, PkSigning]>;
    /**
     * Check whether the private keys exist in secret storage.
     * XXX: This could be static, be we often seem to have an instance when we
     * want to know this anyway...
     *
     * @param {SecretStorage} secretStorage The secret store using account data
     * @returns {object} map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    isStoredInSecretStorage(secretStorage: SecretStorage): Promise<Record<string, object>>;
    /**
     * Store private keys in secret storage for use by other devices. This is
     * typically called in conjunction with the creation of new cross-signing
     * keys.
     *
     * @param {Map} keys The keys to store
     * @param {SecretStorage} secretStorage The secret store using account data
     */
    static storeInSecretStorage(keys: Map<string, Uint8Array>, secretStorage: SecretStorage): Promise<void>;
    /**
     * Get private keys from secret storage created by some other device. This
     * also passes the private keys to the app-specific callback.
     *
     * @param {string} type The type of key to get.  One of "master",
     * "self_signing", or "user_signing".
     * @param {SecretStorage} secretStorage The secret store using account data
     * @return {Uint8Array} The private key
     */
    static getFromSecretStorage(type: string, secretStorage: SecretStorage): Promise<Uint8Array>;
    /**
     * Check whether the private keys exist in the local key cache.
     *
     * @param {string} [type] The type of key to get. One of "master",
     * "self_signing", or "user_signing". Optional, will check all by default.
     * @returns {boolean} True if all keys are stored in the local cache.
     */
    isStoredInKeyCache(type?: string): Promise<boolean>;
    /**
     * Get cross-signing private keys from the local cache.
     *
     * @returns {Map} A map from key type (string) to private key (Uint8Array)
     */
    getCrossSigningKeysFromCache(): Promise<Map<string, Uint8Array>>;
    /**
     * Get the ID used to identify the user. This can also be used to test for
     * the existence of a given key type.
     *
     * @param {string} type The type of key to get the ID of.  One of "master",
     * "self_signing", or "user_signing".  Defaults to "master".
     *
     * @return {string} the ID
     */
    getId(type?: string): string;
    /**
     * Create new cross-signing keys for the given key types. The public keys
     * will be held in this class, while the private keys are passed off to the
     * `saveCrossSigningKeys` application callback.
     *
     * @param {CrossSigningLevel} level The key types to reset
     */
    resetKeys(level?: CrossSigningLevel): Promise<void>;
    /**
     * unsets the keys, used when another session has reset the keys, to disable cross-signing
     */
    clearKeys(): void;
    setKeys(keys: Record<string, ICrossSigningKey>): void;
    updateCrossSigningVerifiedBefore(isCrossSigningVerified: boolean): void;
    signObject<T extends object>(data: T, type: string): Promise<T & {
        signatures: ISignatures;
    }>;
    signUser(key: CrossSigningInfo): Promise<ICrossSigningKey>;
    signDevice(userId: string, device: DeviceInfo): Promise<ISignedKey>;
    /**
     * Check whether a given user is trusted.
     *
     * @param {CrossSigningInfo} userCrossSigning Cross signing info for user
     *
     * @returns {UserTrustLevel}
     */
    checkUserTrust(userCrossSigning: CrossSigningInfo): UserTrustLevel;
    /**
     * Check whether a given device is trusted.
     *
     * @param {CrossSigningInfo} userCrossSigning Cross signing info for user
     * @param {module:crypto/deviceinfo} device The device to check
     * @param {boolean} localTrust Whether the device is trusted locally
     * @param {boolean} trustCrossSignedDevices Whether we trust cross signed devices
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceTrust(userCrossSigning: CrossSigningInfo, device: DeviceInfo, localTrust: boolean, trustCrossSignedDevices: boolean): DeviceTrustLevel;
    /**
     * @returns {object} Cache callbacks
     */
    getCacheCallbacks(): ICacheCallbacks;
}
export declare enum CrossSigningLevel {
    MASTER = 4,
    USER_SIGNING = 2,
    SELF_SIGNING = 1
}
/**
 * Represents the ways in which we trust a user
 */
export declare class UserTrustLevel {
    private readonly crossSigningVerified;
    private readonly crossSigningVerifiedBefore;
    private readonly tofu;
    constructor(crossSigningVerified: boolean, crossSigningVerifiedBefore: boolean, tofu: boolean);
    /**
     * @returns {boolean} true if this user is verified via any means
     */
    isVerified(): boolean;
    /**
     * @returns {boolean} true if this user is verified via cross signing
     */
    isCrossSigningVerified(): boolean;
    /**
     * @returns {boolean} true if we ever verified this user before (at least for
     * the history of verifications observed by this device).
     */
    wasCrossSigningVerified(): boolean;
    /**
     * @returns {boolean} true if this user's key is trusted on first use
     */
    isTofu(): boolean;
}
/**
 * Represents the ways in which we trust a device
 */
export declare class DeviceTrustLevel {
    readonly crossSigningVerified: boolean;
    readonly tofu: boolean;
    private readonly localVerified;
    private readonly trustCrossSignedDevices;
    constructor(crossSigningVerified: boolean, tofu: boolean, localVerified: boolean, trustCrossSignedDevices: boolean);
    static fromUserTrustLevel(userTrustLevel: UserTrustLevel, localVerified: boolean, trustCrossSignedDevices: boolean): DeviceTrustLevel;
    /**
     * @returns {boolean} true if this device is verified via any means
     */
    isVerified(): boolean;
    /**
     * @returns {boolean} true if this device is verified via cross signing
     */
    isCrossSigningVerified(): boolean;
    /**
     * @returns {boolean} true if this device is verified locally
     */
    isLocallyVerified(): boolean;
    /**
     * @returns {boolean} true if this device is trusted from a user's key
     * that is trusted on first use
     */
    isTofu(): boolean;
}
export declare function createCryptoStoreCacheCallbacks(store: CryptoStore, olmDevice: OlmDevice): ICacheCallbacks;
export declare type KeysDuringVerification = [[string, PkSigning], [string, PkSigning], [string, PkSigning], void];
/**
 * Request cross-signing keys from another device during verification.
 *
 * @param {MatrixClient} baseApis base Matrix API interface
 * @param {string} userId The user ID being verified
 * @param {string} deviceId The device ID being verified
 */
export declare function requestKeysDuringVerification(baseApis: MatrixClient, userId: string, deviceId: string): Promise<KeysDuringVerification | void>;
//# sourceMappingURL=CrossSigning.d.ts.map