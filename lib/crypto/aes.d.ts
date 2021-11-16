export interface IEncryptedPayload {
    [key: string]: any;
    iv?: string;
    ciphertext?: string;
    mac?: string;
}
export declare function encryptAES(data: string, key: Uint8Array, name: string, ivStr?: string): Promise<IEncryptedPayload>;
export declare function decryptAES(data: IEncryptedPayload, key: Uint8Array, name: string): Promise<string>;
/** Calculate the MAC for checking the key.
 *
 * @param {Uint8Array} key the key to use
 * @param {string} [iv] The initialization vector as a base64-encoded string.
 *     If omitted, a random initialization vector will be created.
 * @return {Promise<object>} An object that contains, `mac` and `iv` properties.
 */
export declare function calculateKeyCheck(key: Uint8Array, iv?: string): Promise<IEncryptedPayload>;
//# sourceMappingURL=aes.d.ts.map