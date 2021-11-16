import type { PkSigning } from "@matrix-org/olm";
import { Logger } from "loglevel";
import { OlmDevice } from "./OlmDevice";
import { DeviceInfo } from "./deviceinfo";
import { IOneTimeKey } from "./dehydration";
import { MatrixClient } from "../client";
declare enum Algorithm {
    Olm = "m.olm.v1.curve25519-aes-sha2",
    Megolm = "m.megolm.v1.aes-sha2",
    MegolmBackup = "m.megolm_backup.v1.curve25519-aes-sha2"
}
/**
 * matrix algorithm tag for olm
 */
export declare const OLM_ALGORITHM = Algorithm.Olm;
/**
 * matrix algorithm tag for megolm
 */
export declare const MEGOLM_ALGORITHM = Algorithm.Megolm;
/**
 * matrix algorithm tag for megolm backups
 */
export declare const MEGOLM_BACKUP_ALGORITHM = Algorithm.MegolmBackup;
export interface IOlmSessionResult {
    device: DeviceInfo;
    sessionId?: string;
}
/**
 * Encrypt an event payload for an Olm device
 *
 * @param {Object<string, string>} resultsObject  The `ciphertext` property
 *   of the m.room.encrypted event to which to add our result
 *
 * @param {string} ourUserId
 * @param {string} ourDeviceId
 * @param {module:crypto/OlmDevice} olmDevice olm.js wrapper
 * @param {string} recipientUserId
 * @param {module:crypto/deviceinfo} recipientDevice
 * @param {object} payloadFields fields to include in the encrypted payload
 *
 * Returns a promise which resolves (to undefined) when the payload
 *    has been encrypted into `resultsObject`
 */
export declare function encryptMessageForDevice(resultsObject: Record<string, string>, ourUserId: string, ourDeviceId: string, olmDevice: OlmDevice, recipientUserId: string, recipientDevice: DeviceInfo, payloadFields: Record<string, any>): Promise<void>;
/**
 * Get the existing olm sessions for the given devices, and the devices that
 * don't have olm sessions.
 *
 * @param {module:crypto/OlmDevice} olmDevice
 *
 * @param {MatrixClient} baseApis
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices to ensure sessions for
 *
 * @return {Promise} resolves to an array.  The first element of the array is a
 *    a map of user IDs to arrays of deviceInfo, representing the devices that
 *    don't have established olm sessions.  The second element of the array is
 *    a map from userId to deviceId to {@link module:crypto~OlmSessionResult}
 */
export declare function getExistingOlmSessions(olmDevice: OlmDevice, baseApis: MatrixClient, devicesByUser: Record<string, DeviceInfo[]>): Promise<{}[]>;
/**
 * Try to make sure we have established olm sessions for the given devices.
 *
 * @param {module:crypto/OlmDevice} olmDevice
 *
 * @param {MatrixClient} baseApis
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices to ensure sessions for
 *
 * @param {boolean} [force=false] If true, establish a new session even if one
 *     already exists.
 *
 * @param {Number} [otkTimeout] The timeout in milliseconds when requesting
 *     one-time keys for establishing new olm sessions.
 *
 * @param {Array} [failedServers] An array to fill with remote servers that
 *     failed to respond to one-time-key requests.
 *
 * @param {Logger} [log] A possibly customised log
 *
 * @return {Promise} resolves once the sessions are complete, to
 *    an Object mapping from userId to deviceId to
 *    {@link module:crypto~OlmSessionResult}
 */
export declare function ensureOlmSessionsForDevices(olmDevice: OlmDevice, baseApis: MatrixClient, devicesByUser: Record<string, DeviceInfo[]>, force?: boolean, otkTimeout?: number, failedServers?: string[], log?: Logger): Promise<Record<string, Record<string, IOlmSessionResult>>>;
export interface IObject {
    unsigned?: object;
    signatures?: object;
}
/**
 * Verify the signature on an object
 *
 * @param {module:crypto/OlmDevice} olmDevice olm wrapper to use for verify op
 *
 * @param {Object} obj object to check signature on.
 *
 * @param {string} signingUserId  ID of the user whose signature should be checked
 *
 * @param {string} signingDeviceId  ID of the device whose signature should be checked
 *
 * @param {string} signingKey   base64-ed ed25519 public key
 *
 * Returns a promise which resolves (to undefined) if the the signature is good,
 * or rejects with an Error if it is bad.
 */
export declare function verifySignature(olmDevice: OlmDevice, obj: IOneTimeKey | IObject, signingUserId: string, signingDeviceId: string, signingKey: string): Promise<void>;
/**
 * Sign a JSON object using public key cryptography
 * @param {Object} obj Object to sign.  The object will be modified to include
 *     the new signature
 * @param {Olm.PkSigning|Uint8Array} key the signing object or the private key
 * seed
 * @param {string} userId The user ID who owns the signing key
 * @param {string} pubKey The public key (ignored if key is a seed)
 * @returns {string} the signature for the object
 */
export declare function pkSign(obj: IObject, key: PkSigning, userId: string, pubKey: string): string;
/**
 * Verify a signed JSON object
 * @param {Object} obj Object to verify
 * @param {string} pubKey The public key to use to verify
 * @param {string} userId The user ID who signed the object
 */
export declare function pkVerify(obj: IObject, pubKey: string, userId: string): void;
/**
 * Encode a typed array of uint8 as base64.
 * @param {Uint8Array} uint8Array The data to encode.
 * @return {string} The base64.
 */
export declare function encodeBase64(uint8Array: ArrayBuffer | Uint8Array): string;
/**
 * Encode a typed array of uint8 as unpadded base64.
 * @param {Uint8Array} uint8Array The data to encode.
 * @return {string} The unpadded base64.
 */
export declare function encodeUnpaddedBase64(uint8Array: ArrayBuffer | Uint8Array): string;
/**
 * Decode a base64 string to a typed array of uint8.
 * @param {string} base64 The base64 to decode.
 * @return {Uint8Array} The decoded data.
 */
export declare function decodeBase64(base64: string): Uint8Array;
export {};
//# sourceMappingURL=olmlib.d.ts.map