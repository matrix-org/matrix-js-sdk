import { ISignatures } from "../@types/signed";
/**
 * @module crypto/deviceinfo
 */
export interface IDevice {
    keys: Record<string, string>;
    algorithms: string[];
    verified: DeviceVerification;
    known: boolean;
    unsigned?: Record<string, any>;
    signatures?: ISignatures;
}
declare enum DeviceVerification {
    Blocked = -1,
    Unverified = 0,
    Verified = 1
}
/**
  * Information about a user's device
  *
  * @constructor
  * @alias module:crypto/deviceinfo
  *
  * @property {string} deviceId the ID of this device
  *
  * @property {string[]} algorithms list of algorithms supported by this device
  *
  * @property {Object.<string,string>} keys a map from
  *      &lt;key type&gt;:&lt;id&gt; -> &lt;base64-encoded key&gt;>
  *
  * @property {module:crypto/deviceinfo.DeviceVerification} verified
  *     whether the device has been verified/blocked by the user
  *
  * @property {boolean} known
  *     whether the user knows of this device's existence (useful when warning
  *     the user that a user has added new devices)
  *
  * @property {Object} unsigned  additional data from the homeserver
  *
  * @param {string} deviceId id of the device
  */
export declare class DeviceInfo {
    readonly deviceId: string;
    /**
     * rehydrate a DeviceInfo from the session store
     *
     * @param {object} obj  raw object from session store
     * @param {string} deviceId id of the device
     *
     * @return {module:crypto~DeviceInfo} new DeviceInfo
     */
    static fromStorage(obj: Partial<IDevice>, deviceId: string): DeviceInfo;
    /**
     * @enum
     */
    static DeviceVerification: {
        VERIFIED: DeviceVerification;
        UNVERIFIED: DeviceVerification;
        BLOCKED: DeviceVerification;
    };
    algorithms: string[];
    keys: Record<string, string>;
    verified: DeviceVerification;
    known: boolean;
    unsigned: Record<string, any>;
    signatures: ISignatures;
    constructor(deviceId: string);
    /**
     * Prepare a DeviceInfo for JSON serialisation in the session store
     *
     * @return {object} deviceinfo with non-serialised members removed
     */
    toStorage(): IDevice;
    /**
     * Get the fingerprint for this device (ie, the Ed25519 key)
     *
     * @return {string} base64-encoded fingerprint of this device
     */
    getFingerprint(): string;
    /**
     * Get the identity key for this device (ie, the Curve25519 key)
     *
     * @return {string} base64-encoded identity key of this device
     */
    getIdentityKey(): string;
    /**
     * Get the configured display name for this device, if any
     *
     * @return {string?} displayname
     */
    getDisplayName(): string | null;
    /**
     * Returns true if this device is blocked
     *
     * @return {Boolean} true if blocked
     */
    isBlocked(): boolean;
    /**
     * Returns true if this device is verified
     *
     * @return {Boolean} true if verified
     */
    isVerified(): boolean;
    /**
     * Returns true if this device is unverified
     *
     * @return {Boolean} true if unverified
     */
    isUnverified(): boolean;
    /**
     * Returns true if the user knows about this device's existence
     *
     * @return {Boolean} true if known
     */
    isKnown(): boolean;
}
export {};
//# sourceMappingURL=deviceinfo.d.ts.map