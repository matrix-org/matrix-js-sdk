/*
Copyright 2021-2023 The Matrix.org Foundation C.I.C.

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

/**
 * Implementation of server-side secret storage
 *
 * @see https://spec.matrix.org/v1.6/client-server-api/#storage
 */

import { TypedEventEmitter } from "./models/typed-event-emitter";
import { ClientEvent, ClientEventHandlerMap } from "./client";
import { MatrixEvent } from "./models/event";
import { calculateKeyCheck, decryptAES, encryptAES, IEncryptedPayload } from "./crypto/aes";
import { randomString } from "./randomstring";
import { logger } from "./logger";

export const SECRET_STORAGE_ALGORITHM_V1_AES = "m.secret_storage.v1.aes-hmac-sha2";

/**
 * Common base interface for Secret Storage Keys.
 *
 * The common properties for all encryption keys used in server-side secret storage.
 *
 * @see https://spec.matrix.org/v1.6/client-server-api/#key-storage
 */
export interface SecretStorageKeyDescriptionCommon {
    /** A human-readable name for this key. */
    // XXX: according to the spec, this is optional
    name: string;

    /** The encryption algorithm used with this key. */
    algorithm: string;

    /** Information for deriving this key from a passphrase. */
    // XXX: according to the spec, this is optional
    passphrase: PassphraseInfo;
}

/**
 * Properties for a SSSS key using the `m.secret_storage.v1.aes-hmac-sha2` algorithm.
 *
 * Corresponds to `AesHmacSha2KeyDescription` in the specification.
 *
 * @see https://spec.matrix.org/v1.6/client-server-api/#msecret_storagev1aes-hmac-sha2
 */
export interface SecretStorageKeyDescriptionAesV1 extends SecretStorageKeyDescriptionCommon {
    // XXX: strictly speaking, we should be able to enforce the algorithm here. But
    //   this interface ends up being incorrectly used where other algorithms are in use (notably
    //   in device-dehydration support), and unpicking that is too much like hard work
    //   at the moment.
    // algorithm: "m.secret_storage.v1.aes-hmac-sha2";

    /** The 16-byte AES initialization vector, encoded as base64. */
    iv: string;

    /** The MAC of the result of encrypting 32 bytes of 0, encoded as base64. */
    mac: string;
}

/**
 * Union type for secret storage keys.
 *
 * For now, this is only {@link SecretStorageKeyDescriptionAesV1}, but other interfaces may be added in future.
 */
export type SecretStorageKeyDescription = SecretStorageKeyDescriptionAesV1;

/**
 * Information on how to generate the key from a passphrase.
 *
 * @see https://spec.matrix.org/v1.6/client-server-api/#deriving-keys-from-passphrases
 */
export interface PassphraseInfo {
    /** The algorithm to be used to derive the key. */
    algorithm: "m.pbkdf2";

    /** The number of PBKDF2 iterations to use. */
    iterations: number;

    /** The salt to be used for PBKDF2. */
    salt: string;

    /** The number of bits to generate. Defaults to 256. */
    bits?: number;
}

/**
 * Options for {@link SecretStorage#addKey}.
 */
export interface AddSecretStorageKeyOpts {
    pubkey?: string;
    passphrase?: PassphraseInfo;
    name?: string;
    key?: Uint8Array;
}

/**
 * Return type for {@link SecretStorage#getKey}.
 */
export type SecretStorageKeyTuple = [keyId: string, keyInfo: SecretStorageKeyDescription];

/**
 * Return type for {@link SecretStorage#addKey}.
 */
export type SecretStorageKeyObject = { keyId: string; keyInfo: SecretStorageKeyDescription };

/** Interface for managing account data on the server.
 *
 * A subset of {@link MatrixClient}.
 */
export interface AccountDataClient extends TypedEventEmitter<ClientEvent.AccountData, ClientEventHandlerMap> {
    /**
     * Get account data event of given type for the current user. This variant
     * gets account data directly from the homeserver if the local store is not
     * ready, which can be useful very early in startup before the initial sync.
     *
     * @param eventType - The type of account data
     * @returns The contents of the given account data event.
     */
    getAccountDataFromServer: <T extends Record<string, any>>(eventType: string) => Promise<T>;

    /**
     * Set account data event for the current user, with retries
     *
     * @param eventType - The type of account data
     * @param content - the content object to be set
     * @returns an empty object
     */
    setAccountData: (eventType: string, content: any) => Promise<{}>;
}

/**
 *  Application callbacks for use with {@link SecretStorage}
 */
export interface SecretStorageCallbacks {
    getSecretStorageKey?: (
        keys: { keys: Record<string, SecretStorageKeyDescription> },
        name: string,
    ) => Promise<[string, Uint8Array] | null>;
}

interface SecretInfo {
    encrypted: {
        [keyId: string]: IEncryptedPayload;
    };
}

interface Decryptors {
    encrypt: (plaintext: string) => Promise<IEncryptedPayload>;
    decrypt: (ciphertext: IEncryptedPayload) => Promise<string>;
}

/**
 * Interface provided by SecretStorage implementations
 *
 * Normally this will just be an {@link SecretStorage}, but for backwards-compatibility some methods allow other
 * implementations.
 */
export interface ISecretStorage {
    /**
     * Add a key for encrypting secrets.
     *
     * @param algorithm - the algorithm used by the key.
     * @param opts - the options for the algorithm.  The properties used
     *     depend on the algorithm given.
     * @param keyId - the ID of the key.  If not given, a random
     *     ID will be generated.
     *
     * @returns An object with:
     *     keyId: the ID of the key
     *     keyInfo: details about the key (iv, mac, passphrase)
     */
    addKey(algorithm: string, opts: AddSecretStorageKeyOpts, keyId?: string): Promise<SecretStorageKeyObject>;

    /**
     * Get the key information for a given ID.
     *
     * @param keyId - The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns If the key was found, the return value is an array of
     *     the form [keyId, keyInfo].  Otherwise, null is returned.
     *     XXX: why is this an array when addKey returns an object?
     */
    getKey(keyId?: string | null): Promise<SecretStorageKeyTuple | null>;

    /**
     * Check whether we have a key with a given ID.
     *
     * @param keyId - The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns Whether we have the key.
     */
    hasKey(keyId?: string): Promise<boolean>;

    /**
     * Check whether a key matches what we expect based on the key info
     *
     * @param key - the key to check
     * @param info - the key info
     *
     * @returns whether or not the key matches
     */
    checkKey(key: Uint8Array, info: SecretStorageKeyDescriptionAesV1): Promise<boolean>;

    /**
     * Store an encrypted secret on the server
     *
     * @param name - The name of the secret
     * @param secret - The secret contents.
     * @param keys - The IDs of the keys to use to encrypt the secret
     *     or null/undefined to use the default key.
     */
    store(name: string, secret: string, keys?: string[] | null): Promise<void>;

    /**
     * Get a secret from storage.
     *
     * @param name - the name of the secret
     *
     * @returns the contents of the secret
     */
    get(name: string): Promise<string | undefined>;

    /**
     * Check if a secret is stored on the server.
     *
     * @param name - the name of the secret
     *
     * @returns map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    isStored(name: string): Promise<Record<string, SecretStorageKeyDescriptionAesV1> | null>;
}

/**
 * Implementation of Server-side secret storage.
 *
 * Secret *sharing* is *not* implemented here: this class is strictly about the storage component of
 * SSSS.
 *
 * @see https://spec.matrix.org/v1.6/client-server-api/#storage
 */
export class SecretStorage implements ISecretStorage {
    /**
     * Construct a new `SecretStorage`.
     *
     * Normally, it is unnecessary to call this directly, since MatrixClient automatically constructs one.
     * However, it may be useful to construct a new `SecretStorage`, if custom `callbacks` are required, for example.
     *
     * @param accountDataAdapter - interface for fetching and setting account data on the server. Normally an instance
     *   of {@link MatrixClient}.
     * @param callbacks - application level callbacks for retrieving secret keys
     */
    public constructor(
        private readonly accountDataAdapter: AccountDataClient,
        private readonly callbacks: SecretStorageCallbacks,
    ) {}

    public async getDefaultKeyId(): Promise<string | null> {
        const defaultKey = await this.accountDataAdapter.getAccountDataFromServer<{ key: string }>(
            "m.secret_storage.default_key",
        );
        if (!defaultKey) return null;
        return defaultKey.key;
    }

    public setDefaultKeyId(keyId: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const listener = (ev: MatrixEvent): void => {
                if (ev.getType() === "m.secret_storage.default_key" && ev.getContent().key === keyId) {
                    this.accountDataAdapter.removeListener(ClientEvent.AccountData, listener);
                    resolve();
                }
            };
            this.accountDataAdapter.on(ClientEvent.AccountData, listener);

            this.accountDataAdapter.setAccountData("m.secret_storage.default_key", { key: keyId }).catch((e) => {
                this.accountDataAdapter.removeListener(ClientEvent.AccountData, listener);
                reject(e);
            });
        });
    }

    /**
     * Add a key for encrypting secrets.
     *
     * @param algorithm - the algorithm used by the key.
     * @param opts - the options for the algorithm.  The properties used
     *     depend on the algorithm given.
     * @param keyId - the ID of the key.  If not given, a random
     *     ID will be generated.
     *
     * @returns An object with:
     *     keyId: the ID of the key
     *     keyInfo: details about the key (iv, mac, passphrase)
     */
    public async addKey(
        algorithm: string,
        opts: AddSecretStorageKeyOpts = {},
        keyId?: string,
    ): Promise<SecretStorageKeyObject> {
        if (algorithm !== SECRET_STORAGE_ALGORITHM_V1_AES) {
            throw new Error(`Unknown key algorithm ${algorithm}`);
        }

        const keyInfo = { algorithm } as SecretStorageKeyDescriptionAesV1;

        if (opts.name) {
            keyInfo.name = opts.name;
        }

        if (opts.passphrase) {
            keyInfo.passphrase = opts.passphrase;
        }
        if (opts.key) {
            const { iv, mac } = await calculateKeyCheck(opts.key);
            keyInfo.iv = iv;
            keyInfo.mac = mac;
        }

        if (!keyId) {
            do {
                keyId = randomString(32);
            } while (
                await this.accountDataAdapter.getAccountDataFromServer<SecretStorageKeyDescription>(
                    `m.secret_storage.key.${keyId}`,
                )
            );
        }

        await this.accountDataAdapter.setAccountData(`m.secret_storage.key.${keyId}`, keyInfo);

        return {
            keyId,
            keyInfo,
        };
    }

    /**
     * Get the key information for a given ID.
     *
     * @param keyId - The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns If the key was found, the return value is an array of
     *     the form [keyId, keyInfo].  Otherwise, null is returned.
     *     XXX: why is this an array when addKey returns an object?
     */
    public async getKey(keyId?: string | null): Promise<SecretStorageKeyTuple | null> {
        if (!keyId) {
            keyId = await this.getDefaultKeyId();
        }
        if (!keyId) {
            return null;
        }

        const keyInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretStorageKeyDescriptionAesV1>(
            "m.secret_storage.key." + keyId,
        );
        return keyInfo ? [keyId, keyInfo] : null;
    }

    /**
     * Check whether we have a key with a given ID.
     *
     * @param keyId - The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns Whether we have the key.
     */
    public async hasKey(keyId?: string): Promise<boolean> {
        return Boolean(await this.getKey(keyId));
    }

    /**
     * Check whether a key matches what we expect based on the key info
     *
     * @param key - the key to check
     * @param info - the key info
     *
     * @returns whether or not the key matches
     */
    public async checkKey(key: Uint8Array, info: SecretStorageKeyDescriptionAesV1): Promise<boolean> {
        if (info.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
            if (info.mac) {
                const { mac } = await calculateKeyCheck(key, info.iv);
                return info.mac.replace(/=+$/g, "") === mac.replace(/=+$/g, "");
            } else {
                // if we have no information, we have to assume the key is right
                return true;
            }
        } else {
            throw new Error("Unknown algorithm");
        }
    }

    /**
     * Store an encrypted secret on the server
     *
     * @param name - The name of the secret
     * @param secret - The secret contents.
     * @param keys - The IDs of the keys to use to encrypt the secret
     *     or null/undefined to use the default key.
     */
    public async store(name: string, secret: string, keys?: string[] | null): Promise<void> {
        const encrypted: Record<string, IEncryptedPayload> = {};

        if (!keys) {
            const defaultKeyId = await this.getDefaultKeyId();
            if (!defaultKeyId) {
                throw new Error("No keys specified and no default key present");
            }
            keys = [defaultKeyId];
        }

        if (keys.length === 0) {
            throw new Error("Zero keys given to encrypt with!");
        }

        for (const keyId of keys) {
            // get key information from key storage
            const keyInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretStorageKeyDescriptionAesV1>(
                "m.secret_storage.key." + keyId,
            );
            if (!keyInfo) {
                throw new Error("Unknown key: " + keyId);
            }

            // encrypt secret, based on the algorithm
            if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
                const keys = { [keyId]: keyInfo };
                const [, encryption] = await this.getSecretStorageKey(keys, name);
                encrypted[keyId] = await encryption.encrypt(secret);
            } else {
                logger.warn("unknown algorithm for secret storage key " + keyId + ": " + keyInfo.algorithm);
                // do nothing if we don't understand the encryption algorithm
            }
        }

        // save encrypted secret
        await this.accountDataAdapter.setAccountData(name, { encrypted });
    }

    /**
     * Get a secret from storage.
     *
     * @param name - the name of the secret
     *
     * @returns the contents of the secret
     */
    public async get(name: string): Promise<string | undefined> {
        const secretInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretInfo>(name);
        if (!secretInfo) {
            return;
        }
        if (!secretInfo.encrypted) {
            throw new Error("Content is not encrypted!");
        }

        // get possible keys to decrypt
        const keys: Record<string, SecretStorageKeyDescriptionAesV1> = {};
        for (const keyId of Object.keys(secretInfo.encrypted)) {
            // get key information from key storage
            const keyInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretStorageKeyDescriptionAesV1>(
                "m.secret_storage.key." + keyId,
            );
            const encInfo = secretInfo.encrypted[keyId];
            // only use keys we understand the encryption algorithm of
            if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
                if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
                    keys[keyId] = keyInfo;
                }
            }
        }

        if (Object.keys(keys).length === 0) {
            throw new Error(
                `Could not decrypt ${name} because none of ` +
                    `the keys it is encrypted with are for a supported algorithm`,
            );
        }

        // fetch private key from app
        const [keyId, decryption] = await this.getSecretStorageKey(keys, name);
        const encInfo = secretInfo.encrypted[keyId];

        return decryption.decrypt(encInfo);
    }

    /**
     * Check if a secret is stored on the server.
     *
     * @param name - the name of the secret
     *
     * @returns map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    public async isStored(name: string): Promise<Record<string, SecretStorageKeyDescriptionAesV1> | null> {
        // check if secret exists
        const secretInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretInfo>(name);
        if (!secretInfo?.encrypted) return null;

        const ret: Record<string, SecretStorageKeyDescriptionAesV1> = {};

        // filter secret encryption keys with supported algorithm
        for (const keyId of Object.keys(secretInfo.encrypted)) {
            // get key information from key storage
            const keyInfo = await this.accountDataAdapter.getAccountDataFromServer<SecretStorageKeyDescriptionAesV1>(
                "m.secret_storage.key." + keyId,
            );
            if (!keyInfo) continue;
            const encInfo = secretInfo.encrypted[keyId];

            // only use keys we understand the encryption algorithm of
            if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
                if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
                    ret[keyId] = keyInfo;
                }
            }
        }
        return Object.keys(ret).length ? ret : null;
    }

    private async getSecretStorageKey(
        keys: Record<string, SecretStorageKeyDescriptionAesV1>,
        name: string,
    ): Promise<[string, Decryptors]> {
        if (!this.callbacks.getSecretStorageKey) {
            throw new Error("No getSecretStorageKey callback supplied");
        }

        const returned = await this.callbacks.getSecretStorageKey({ keys }, name);

        if (!returned) {
            throw new Error("getSecretStorageKey callback returned falsey");
        }
        if (returned.length < 2) {
            throw new Error("getSecretStorageKey callback returned invalid data");
        }

        const [keyId, privateKey] = returned;
        if (!keys[keyId]) {
            throw new Error("App returned unknown key from getSecretStorageKey!");
        }

        if (keys[keyId].algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
            const decryption = {
                encrypt: function (secret: string): Promise<IEncryptedPayload> {
                    return encryptAES(secret, privateKey, name);
                },
                decrypt: function (encInfo: IEncryptedPayload): Promise<string> {
                    return decryptAES(encInfo, privateKey, name);
                },
            };
            return [keyId, decryption];
        } else {
            throw new Error("Unknown key type: " + keys[keyId].algorithm);
        }
    }
}
