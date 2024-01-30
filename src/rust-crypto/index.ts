/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { StoreHandle } from "@matrix-org/matrix-sdk-crypto-wasm";

import { RustCrypto } from "./rust-crypto";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { ServerSideSecretStorage } from "../secret-storage";
import { ICryptoCallbacks } from "../crypto";
import { Logger } from "../logger";
import { CryptoStore } from "../crypto/store/base";
import { migrateFromLegacyCrypto, migrateRoomSettingsFromLegacyCrypto } from "./libolm_migration";

/**
 * Create a new `RustCrypto` implementation
 *
 * @param args - Parameter object
 * @internal
 */
export async function initRustCrypto(args: {
    /** A `Logger` instance that will be used for debug output. */
    logger: Logger;

    /**
     * Low-level HTTP interface: used to make outgoing requests required by the rust SDK.
     * We expect it to set the access token, etc.
     */
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>;

    /** The local user's User ID. */
    userId: string;

    /** The local user's Device ID. */
    deviceId: string;

    /** Interface to server-side secret storage. */
    secretStorage: ServerSideSecretStorage;

    /** Crypto callbacks provided by the application. */
    cryptoCallbacks: ICryptoCallbacks;

    /**
     * The prefix to use on the indexeddbs created by rust-crypto.
     * If `null`, a memory store will be used.
     */
    storePrefix: string | null;

    /**
     * A passphrase to use to encrypt the indexeddbs created by rust-crypto.
     *
     * Ignored if `storePrefix` is null. If this is `undefined` (and `storePrefix` is not null), the indexeddbs
     * will be unencrypted.
     */
    storePassphrase?: string;

    /** If defined, we will check if any data needs migrating from this store to the rust store. */
    legacyCryptoStore?: CryptoStore;

    /** The pickle key for `legacyCryptoStore` */
    legacyPickleKey?: string;

    /**
     * A callback which will receive progress updates on migration from `legacyCryptoStore`.
     *
     * Called with (-1, -1) to mark the end of migration.
     */
    legacyMigrationProgressListener?: (progress: number, total: number) => void;
}): Promise<RustCrypto> {
    const { logger } = args;

    // initialise the rust matrix-sdk-crypto-wasm, if it hasn't already been done
    logger.debug("Initialising Rust crypto-sdk WASM artifact");
    await RustSdkCryptoJs.initAsync();

    // enable tracing in the rust-sdk
    new RustSdkCryptoJs.Tracing(RustSdkCryptoJs.LoggerLevel.Debug).turnOn();

    logger.debug("Opening Rust CryptoStore");
    const storeHandle: StoreHandle = await StoreHandle.open(
        args.storePrefix ?? undefined,
        (args.storePrefix && args.storePassphrase) ?? undefined,
    );

    if (args.legacyCryptoStore) {
        // We have a legacy crypto store, which we may need to migrate from.
        await migrateFromLegacyCrypto({
            legacyStore: args.legacyCryptoStore,
            storeHandle,
            ...args,
        });
    }

    const rustCrypto = await initOlmMachine(
        logger,
        args.http,
        args.userId,
        args.deviceId,
        args.secretStorage,
        args.cryptoCallbacks,
        storeHandle,
        args.legacyCryptoStore,
    );

    storeHandle.free();

    logger.debug("Completed rust crypto-sdk setup");
    return rustCrypto;
}

async function initOlmMachine(
    logger: Logger,
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    userId: string,
    deviceId: string,
    secretStorage: ServerSideSecretStorage,
    cryptoCallbacks: ICryptoCallbacks,
    storeHandle: StoreHandle,
    legacyCryptoStore?: CryptoStore,
): Promise<RustCrypto> {
    logger.debug("Init OlmMachine");

    const olmMachine = await RustSdkCryptoJs.OlmMachine.initFromStore(
        new RustSdkCryptoJs.UserId(userId),
        new RustSdkCryptoJs.DeviceId(deviceId),
        storeHandle,
    );

    // A final migration step, now that we have an OlmMachine.
    if (legacyCryptoStore) {
        await migrateRoomSettingsFromLegacyCrypto({
            logger,
            legacyStore: legacyCryptoStore,
            olmMachine,
        });
    }

    // Disable room key requests, per https://github.com/vector-im/element-web/issues/26524.
    olmMachine.roomKeyRequestsEnabled = false;

    const rustCrypto = new RustCrypto(logger, olmMachine, http, userId, deviceId, secretStorage, cryptoCallbacks);
    await olmMachine.registerRoomKeyUpdatedCallback((sessions: RustSdkCryptoJs.RoomKeyInfo[]) =>
        rustCrypto.onRoomKeysUpdated(sessions),
    );
    await olmMachine.registerUserIdentityUpdatedCallback((userId: RustSdkCryptoJs.UserId) =>
        rustCrypto.onUserIdentityUpdated(userId),
    );

    // Check if there are any key backup secrets pending processing. There may be multiple secrets to process if several devices have gossiped them.
    // The `registerReceiveSecretCallback` function will only be triggered for new secrets. If the client is restarted before processing them, the secrets will need to be manually handled.
    rustCrypto.checkSecrets("m.megolm_backup.v1");

    // Register a callback to be notified when a new secret is received, as for now only the key backup secret is supported (the cross signing secrets are handled automatically by the OlmMachine)
    await olmMachine.registerReceiveSecretCallback((name: string, _value: string) =>
        // Instead of directly checking the secret value, we poll the inbox to get all values for that secret type.
        // Once we have all the values, we can safely clear the secret inbox.
        rustCrypto.checkSecrets(name),
    );

    // Tell the OlmMachine to think about its outgoing requests before we hand control back to the application.
    //
    // This is primarily a fudge to get it to correctly populate the `users_for_key_query` list, so that future
    // calls to getIdentity (etc) block until the key queries are performed.
    //
    // Note that we don't actually need to *make* any requests here; it is sufficient to tell the Rust side to think
    // about them.
    //
    // XXX: find a less hacky way to do this.
    await olmMachine.outgoingRequests();

    return rustCrypto;
}
