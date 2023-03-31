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
    getAccountDataFromServer: <T extends { [k: string]: any }>(eventType: string) => Promise<T>;

    /**
     * Set account data event for the current user, with retries
     *
     * @param eventType - The type of account data
     * @param content - the content object to be set
     * @returns an empty object
     */
    setAccountData: (eventType: string, content: any) => Promise<{}>;
}
