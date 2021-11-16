/// <reference types="node" />
import { ICryptoCallbacks, MatrixClient, MatrixEvent } from '../matrix';
import { IAddSecretStorageKeyOpts, ISecretStorageKeyInfo } from './api';
import { EventEmitter } from 'stream';
export declare const SECRET_STORAGE_ALGORITHM_V1_AES = "m.secret_storage.v1.aes-hmac-sha2";
export declare type SecretStorageKeyTuple = [keyId: string, keyInfo: ISecretStorageKeyInfo];
export declare type SecretStorageKeyObject = {
    keyId: string;
    keyInfo: ISecretStorageKeyInfo;
};
export interface ISecretRequest {
    requestId: string;
    promise: Promise<string>;
    cancel: (reason: string) => void;
}
export interface IAccountDataClient extends EventEmitter {
    getAccountDataFromServer: (eventType: string) => Promise<Record<string, any>>;
    getAccountData: (eventType: string) => MatrixEvent;
    setAccountData: (eventType: string, content: any) => Promise<{}>;
}
/**
 * Implements Secure Secret Storage and Sharing (MSC1946)
 * @module crypto/SecretStorage
 */
export declare class SecretStorage {
    private readonly accountDataAdapter;
    private readonly cryptoCallbacks;
    private readonly baseApis?;
    private requests;
    constructor(accountDataAdapter: IAccountDataClient, cryptoCallbacks: ICryptoCallbacks, baseApis?: MatrixClient);
    getDefaultKeyId(): Promise<string>;
    setDefaultKeyId(keyId: string): Promise<void>;
    /**
     * Add a key for encrypting secrets.
     *
     * @param {string} algorithm the algorithm used by the key.
     * @param {object} opts the options for the algorithm.  The properties used
     *     depend on the algorithm given.
     * @param {string} [keyId] the ID of the key.  If not given, a random
     *     ID will be generated.
     *
     * @return {object} An object with:
     *     keyId: {string} the ID of the key
     *     keyInfo: {object} details about the key (iv, mac, passphrase)
     */
    addKey(algorithm: string, opts: IAddSecretStorageKeyOpts, keyId?: string): Promise<SecretStorageKeyObject>;
    /**
     * Get the key information for a given ID.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns {Array?} If the key was found, the return value is an array of
     *     the form [keyId, keyInfo].  Otherwise, null is returned.
     *     XXX: why is this an array when addKey returns an object?
     */
    getKey(keyId: string): Promise<SecretStorageKeyTuple | null>;
    /**
     * Check whether we have a key with a given ID.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @return {boolean} Whether we have the key.
     */
    hasKey(keyId?: string): Promise<boolean>;
    /**
     * Check whether a key matches what we expect based on the key info
     *
     * @param {Uint8Array} key the key to check
     * @param {object} info the key info
     *
     * @return {boolean} whether or not the key matches
     */
    checkKey(key: Uint8Array, info: ISecretStorageKeyInfo): Promise<boolean>;
    /**
     * Store an encrypted secret on the server
     *
     * @param {string} name The name of the secret
     * @param {string} secret The secret contents.
     * @param {Array} keys The IDs of the keys to use to encrypt the secret
     *     or null/undefined to use the default key.
     */
    store(name: string, secret: string, keys?: string[]): Promise<void>;
    /**
     * Get a secret from storage.
     *
     * @param {string} name the name of the secret
     *
     * @return {string} the contents of the secret
     */
    get(name: string): Promise<string>;
    /**
     * Check if a secret is stored on the server.
     *
     * @param {string} name the name of the secret
     * @param {boolean} checkKey check if the secret is encrypted by a trusted key
     *
     * @return {object?} map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    isStored(name: string, checkKey: boolean): Promise<Record<string, ISecretStorageKeyInfo>>;
    /**
     * Request a secret from another device
     *
     * @param {string} name the name of the secret to request
     * @param {string[]} devices the devices to request the secret from
     */
    request(name: string, devices: string[]): ISecretRequest;
    onRequestReceived(event: MatrixEvent): Promise<void>;
    onSecretReceived(event: MatrixEvent): void;
    private getSecretStorageKey;
}
//# sourceMappingURL=SecretStorage.d.ts.map