/*
Copyright 2023-2024 The Matrix.org Foundation C.I.C.

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

import { Logger } from "../logger";
import { CryptoStore, MigrationState, SecretStorePrivateKeys } from "../crypto/store/base";
import { IndexedDBCryptoStore } from "../crypto/store/indexeddb-crypto-store";
import { decryptAES, IEncryptedPayload } from "../crypto/aes";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { requestKeyBackupVersion } from "./backup";
import { IRoomEncryption } from "../crypto/RoomList";
import { CrossSigningKeyInfo, Curve25519AuthData } from "../crypto-api";
import { RustCrypto } from "./rust-crypto";
import { KeyBackupInfo } from "../crypto-api/keybackup";
import { sleep } from "../utils";
import { encodeBase64 } from "../base64";

/**
 * Determine if any data needs migrating from the legacy store, and do so.
 *
 * This migrates the base account data, and olm and megolm sessions. It does *not* migrate the room list, which should
 * happen after an `OlmMachine` is created, via {@link migrateRoomSettingsFromLegacyCrypto}.
 *
 * @param args - Arguments object.
 */
export async function migrateFromLegacyCrypto(args: {
    /** A `Logger` instance that will be used for debug output. */
    logger: Logger;

    /**
     * Low-level HTTP interface: used to make outgoing requests required by the rust SDK.
     * We expect it to set the access token, etc.
     */
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>;

    /** Store to migrate data from. */
    legacyStore: CryptoStore;

    /** Pickle key for `legacyStore`. */
    legacyPickleKey?: string;

    /** Local user's User ID. */
    userId: string;

    /** Local user's Device ID. */
    deviceId: string;

    /** Rust crypto store to migrate data into. */
    storeHandle: RustSdkCryptoJs.StoreHandle;

    /**
     * A callback which will receive progress updates on migration from `legacyStore`.
     *
     * Called with (-1, -1) to mark the end of migration.
     */
    legacyMigrationProgressListener?: (progress: number, total: number) => void;
}): Promise<void> {
    const { logger, legacyStore } = args;

    // initialise the rust matrix-sdk-crypto-wasm, if it hasn't already been done
    await RustSdkCryptoJs.initAsync();

    // enable tracing in the rust-sdk
    new RustSdkCryptoJs.Tracing(RustSdkCryptoJs.LoggerLevel.Debug).turnOn();

    if (!(await legacyStore.containsData())) {
        // This store was never used. Nothing to migrate.
        return;
    }

    await legacyStore.startup();

    let accountPickle: string | null = null;
    await legacyStore.doTxn("readonly", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
        legacyStore.getAccount(txn, (acctPickle) => {
            accountPickle = acctPickle;
        });
    });
    if (!accountPickle) {
        // This store is not properly set up. Nothing to migrate.
        logger.debug("Legacy crypto store is not set up (no account found). Not migrating.");
        return;
    }

    let migrationState = await legacyStore.getMigrationState();

    if (migrationState >= MigrationState.MEGOLM_SESSIONS_MIGRATED) {
        // All migration is done for now. The room list comes later, once we have an OlmMachine.
        return;
    }

    const nOlmSessions = await countOlmSessions(logger, legacyStore);
    const nMegolmSessions = await countMegolmSessions(logger, legacyStore);
    const totalSteps = 1 + nOlmSessions + nMegolmSessions;
    logger.info(
        `Migrating data from legacy crypto store. ${nOlmSessions} olm sessions and ${nMegolmSessions} megolm sessions to migrate.`,
    );

    let stepsDone = 0;
    function onProgress(steps: number): void {
        stepsDone += steps;
        args.legacyMigrationProgressListener?.(stepsDone, totalSteps);
    }
    onProgress(0);

    const pickleKey = new TextEncoder().encode(args.legacyPickleKey);

    if (migrationState === MigrationState.NOT_STARTED) {
        logger.info("Migrating data from legacy crypto store. Step 1: base data");
        await migrateBaseData(args.http, args.userId, args.deviceId, legacyStore, pickleKey, args.storeHandle, logger);

        migrationState = MigrationState.INITIAL_DATA_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }
    onProgress(1);

    if (migrationState === MigrationState.INITIAL_DATA_MIGRATED) {
        logger.info(
            `Migrating data from legacy crypto store. Step 2: olm sessions (${nOlmSessions} sessions to migrate).`,
        );
        await migrateOlmSessions(logger, legacyStore, pickleKey, args.storeHandle, onProgress);

        migrationState = MigrationState.OLM_SESSIONS_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }

    if (migrationState === MigrationState.OLM_SESSIONS_MIGRATED) {
        logger.info(
            `Migrating data from legacy crypto store. Step 3: megolm sessions (${nMegolmSessions} sessions to migrate).`,
        );
        await migrateMegolmSessions(logger, legacyStore, pickleKey, args.storeHandle, onProgress);

        migrationState = MigrationState.MEGOLM_SESSIONS_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }

    // Migration is done.
    args.legacyMigrationProgressListener?.(-1, -1);
    logger.info("Migration from legacy crypto store complete");
}

async function migrateBaseData(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    userId: string,
    deviceId: string,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
    logger: Logger,
): Promise<void> {
    const migrationData = new RustSdkCryptoJs.BaseMigrationData();
    migrationData.userId = new RustSdkCryptoJs.UserId(userId);
    migrationData.deviceId = new RustSdkCryptoJs.DeviceId(deviceId);

    await legacyStore.doTxn("readonly", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) =>
        legacyStore.getAccount(txn, (a) => {
            migrationData.pickledAccount = a ?? "";
        }),
    );

    const recoveryKey = await getAndDecryptCachedSecretKey(legacyStore, pickleKey, "m.megolm_backup.v1");

    // If we have a backup recovery key, we need to try to figure out which backup version it is for.
    // All we can really do is ask the server for the most recent version and check if the cached key we have matches.
    // It is possible that the backup has changed since last time his session was opened.
    if (recoveryKey) {
        let backupCallDone = false;
        let backupInfo: KeyBackupInfo | null = null;
        while (!backupCallDone) {
            try {
                backupInfo = await requestKeyBackupVersion(http);
                backupCallDone = true;
            } catch (e) {
                logger.info("Failed to get backup version during migration, retrying in 2 seconds", e);
                // Retry until successful, use simple constant delay
                await sleep(2000);
            }
        }
        if (backupInfo && backupInfo.algorithm == "m.megolm_backup.v1.curve25519-aes-sha2") {
            // check if the recovery key matches, as the active backup version may have changed since the key was cached
            // and the migration started.
            try {
                const decryptionKey = RustSdkCryptoJs.BackupDecryptionKey.fromBase64(recoveryKey);
                const publicKey = (backupInfo.auth_data as Curve25519AuthData)?.public_key;
                const isValid = decryptionKey.megolmV1PublicKey.publicKeyBase64 == publicKey;
                if (isValid) {
                    migrationData.backupVersion = backupInfo.version;
                    migrationData.backupRecoveryKey = recoveryKey;
                } else {
                    logger.debug(
                        "The backup key to migrate does not match the active backup version",
                        `Cached pub key: ${decryptionKey.megolmV1PublicKey.publicKeyBase64}`,
                        `Active pub key: ${publicKey}`,
                    );
                }
            } catch (e) {
                logger.warn("Failed to check if the backup key to migrate matches the active backup version", e);
            }
        }
    }

    migrationData.privateCrossSigningMasterKey = await getAndDecryptCachedSecretKey(legacyStore, pickleKey, "master");
    migrationData.privateCrossSigningSelfSigningKey = await getAndDecryptCachedSecretKey(
        legacyStore,
        pickleKey,
        "self_signing",
    );
    migrationData.privateCrossSigningUserSigningKey = await getAndDecryptCachedSecretKey(
        legacyStore,
        pickleKey,
        "user_signing",
    );
    await RustSdkCryptoJs.Migration.migrateBaseData(migrationData, pickleKey, storeHandle);
}

async function countOlmSessions(logger: Logger, legacyStore: CryptoStore): Promise<number> {
    logger.debug("Counting olm sessions to be migrated");
    let nSessions: number;
    await legacyStore.doTxn("readonly", [IndexedDBCryptoStore.STORE_SESSIONS], (txn) =>
        legacyStore.countEndToEndSessions(txn, (n) => (nSessions = n)),
    );
    return nSessions!;
}

async function countMegolmSessions(logger: Logger, legacyStore: CryptoStore): Promise<number> {
    logger.debug("Counting megolm sessions to be migrated");
    return await legacyStore.countEndToEndInboundGroupSessions();
}

async function migrateOlmSessions(
    logger: Logger,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
    onBatchDone: (batchSize: number) => void,
): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const batch = await legacyStore.getEndToEndSessionsBatch();
        if (batch === null) return;

        logger.debug(`Migrating batch of ${batch.length} olm sessions`);
        const migrationData: RustSdkCryptoJs.PickledSession[] = [];
        for (const session of batch) {
            const pickledSession = new RustSdkCryptoJs.PickledSession();
            pickledSession.senderKey = session.deviceKey!;
            pickledSession.pickle = session.session!;
            pickledSession.lastUseTime = pickledSession.creationTime = new Date(session.lastReceivedMessageTs!);
            migrationData.push(pickledSession);
        }

        await RustSdkCryptoJs.Migration.migrateOlmSessions(migrationData, pickleKey, storeHandle);
        await legacyStore.deleteEndToEndSessionsBatch(batch);
        onBatchDone(batch.length);
    }
}

async function migrateMegolmSessions(
    logger: Logger,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
    onBatchDone: (batchSize: number) => void,
): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const batch = await legacyStore.getEndToEndInboundGroupSessionsBatch();
        if (batch === null) return;

        logger.debug(`Migrating batch of ${batch.length} megolm sessions`);
        const migrationData: RustSdkCryptoJs.PickledInboundGroupSession[] = [];
        for (const session of batch) {
            const sessionData = session.sessionData!;

            const pickledSession = new RustSdkCryptoJs.PickledInboundGroupSession();
            pickledSession.pickle = sessionData.session;
            pickledSession.roomId = new RustSdkCryptoJs.RoomId(sessionData.room_id);
            pickledSession.senderKey = session.senderKey;
            pickledSession.senderSigningKey = sessionData.keysClaimed?.["ed25519"];
            pickledSession.backedUp = !session.needsBackup;

            // The Rust SDK `imported` flag is used to indicate the authenticity status of a Megolm
            // session, which tells us whether we can reliably tell which Olm device is the owner
            // (creator) of the session.
            //
            // If `imported` is true, then we have no cryptographic proof that the session is owned
            // by the device with the identity key `senderKey`.
            //
            // Only Megolm sessions received directly from the owning device via an encrypted
            // `m.room_key` to-device message should have `imported` flag set to false. Megolm
            // sessions received by any other currently available means (i.e. from a
            // `m.forwarded_room_key`, from v1 asymmetric server-side key backup, imported from a
            // file, etc) should have the `imported` flag set to true.
            //
            // Messages encrypted with such Megolm sessions will have a grey shield in the UI
            // ("Authenticity of this message cannot be guaranteed").
            //
            // However, we don't want to bluntly mark all sessions as `imported` during migration
            // because users will suddenly start seeing all their historic messages decorated with a
            // grey shield, which would be seen as a non-actionable regression.
            //
            // In the legacy crypto stack, the flag encoding similar information was called
            // `InboundGroupSessionData.untrusted`. The value of this flag was set as follows:
            //
            // - For outbound Megolm sessions created by our own device, `untrusted` is `undefined`.
            // - For Megolm sessions received via a `m.room_key` to-device message, `untrusted` is
            //   `undefined`.
            // - For Megolm sessions received via a `m.forwarded_room_key` to-device message,
            //   `untrusted` is `true`.
            // - For Megolm sessions imported from a (v1 asymmetric / "legacy") server-side key
            //   backup, `untrusted` is `true`.
            // - For Megolm sessions imported from a file, untrusted is `undefined`.
            //
            // The main difference between the legacy crypto stack and the Rust crypto stack is that
            // the Rust stack considers sessions imported from a file as `imported` (not
            // authenticated). This is because the Megolm session export file format does not
            // encode this authenticity information.
            //
            // Given this migration is only a one-time thing, we make a concession to accept the
            // loss of information in this case, to avoid degrading UX in a non-actionable way.
            pickledSession.imported = sessionData.untrusted === true;

            migrationData.push(pickledSession);
        }

        await RustSdkCryptoJs.Migration.migrateMegolmSessions(migrationData, pickleKey, storeHandle);
        await legacyStore.deleteEndToEndInboundGroupSessionsBatch(batch);
        onBatchDone(batch.length);
    }
}

/**
 * Determine if any room settings need migrating from the legacy store, and do so.
 *
 * @param args - Arguments object.
 */
export async function migrateRoomSettingsFromLegacyCrypto({
    logger,
    legacyStore,
    olmMachine,
}: {
    /** A `Logger` instance that will be used for debug output. */
    logger: Logger;

    /** Store to migrate data from. */
    legacyStore: CryptoStore;

    /** OlmMachine to store the new data on. */
    olmMachine: RustSdkCryptoJs.OlmMachine;
}): Promise<void> {
    if (!(await legacyStore.containsData())) {
        // This store was never used. Nothing to migrate.
        return;
    }

    const migrationState = await legacyStore.getMigrationState();

    if (migrationState >= MigrationState.ROOM_SETTINGS_MIGRATED) {
        // We've already migrated the room settings.
        return;
    }

    let rooms: Record<string, IRoomEncryption> = {};

    await legacyStore.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
        legacyStore.getEndToEndRooms(txn, (result) => {
            rooms = result;
        });
    });

    logger.debug(`Migrating ${Object.keys(rooms).length} sets of room settings`);
    for (const [roomId, legacySettings] of Object.entries(rooms)) {
        try {
            const rustSettings = new RustSdkCryptoJs.RoomSettings();

            if (legacySettings.algorithm !== "m.megolm.v1.aes-sha2") {
                logger.warn(`Room ${roomId}: ignoring room with invalid algorithm ${legacySettings.algorithm}`);
                continue;
            }
            rustSettings.algorithm = RustSdkCryptoJs.EncryptionAlgorithm.MegolmV1AesSha2;
            rustSettings.sessionRotationPeriodMs = legacySettings.rotation_period_ms;
            rustSettings.sessionRotationPeriodMessages = legacySettings.rotation_period_msgs;
            await olmMachine.setRoomSettings(new RustSdkCryptoJs.RoomId(roomId), rustSettings);

            // We don't attempt to clear out the settings from the old store, or record where we've gotten up to,
            // which means that if the app gets restarted while we're in the middle of this migration, we'll start
            // again from scratch. So be it. Given that legacy crypto loads the whole room list into memory on startup
            // anyway, we know it can't be that big.
        } catch (e) {
            logger.warn(`Room ${roomId}: ignoring settings ${JSON.stringify(legacySettings)} which caused error ${e}`);
        }
    }

    logger.debug(`Completed room settings migration`);
    await legacyStore.setMigrationState(MigrationState.ROOM_SETTINGS_MIGRATED);
}

async function getAndDecryptCachedSecretKey(
    legacyStore: CryptoStore,
    legacyPickleKey: Uint8Array,
    name: string,
): Promise<string | undefined> {
    const key = await new Promise<any>((resolve) => {
        legacyStore.doTxn("readonly", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
            legacyStore.getSecretStorePrivateKey(txn, resolve, name as keyof SecretStorePrivateKeys);
        });
    });

    if (key && key.ciphertext && key.iv && key.mac) {
        return await decryptAES(key as IEncryptedPayload, legacyPickleKey, name);
    } else if (key instanceof Uint8Array) {
        // This is a legacy backward compatibility case where the key was stored in clear.
        return encodeBase64(key);
    } else {
        return undefined;
    }
}

/**
 * Check if the user's published identity (ie, public cross-signing keys) was trusted by the legacy session,
 * and if so mark it as trusted in the Rust session if needed.
 *
 * By default, if the legacy session didn't have the private MSK, the migrated session will revert to unverified,
 * even if the user has verified the session in the past.
 *
 * This only occurs if the private MSK was not cached in the crypto store (USK and SSK private keys won't help
 * to establish trust: the trust is rooted in the MSK).
 *
 * Rust crypto will only consider the current session as trusted if we import the private MSK itself.
 *
 * We could prompt the user to verify the session again, but it's probably better to just mark the user identity
 * as locally verified if it was before.
 *
 * See https://github.com/element-hq/element-web/issues/27079
 *
 * @param args - Argument object.
 */
export async function migrateLegacyLocalTrustIfNeeded(args: {
    /** The legacy crypto store that is migrated. */
    legacyCryptoStore: CryptoStore;
    /** The migrated rust crypto stack. */
    rustCrypto: RustCrypto;
    /** The logger to use */
    logger: Logger;
}): Promise<void> {
    const { legacyCryptoStore, rustCrypto, logger } = args;
    // Get the public cross-signing identity from rust.
    const rustOwnIdentity = await rustCrypto.getOwnIdentity();
    if (!rustOwnIdentity) {
        // There are no cross-signing keys published server side, so nothing to do here.
        return;
    }
    if (rustOwnIdentity.isVerified()) {
        // The rust session already trusts the keys, so again, nothing to do.
        return;
    }

    const legacyLocallyTrustedMSK = await getLegacyTrustedPublicMasterKeyBase64(legacyCryptoStore);
    if (!legacyLocallyTrustedMSK) {
        // The user never verified their identity in the legacy session, so nothing to do.
        return;
    }

    const mskInfo: CrossSigningKeyInfo = JSON.parse(rustOwnIdentity.masterKey);
    if (!mskInfo.keys || Object.keys(mskInfo.keys).length === 0) {
        // This should not happen, but let's be safe
        logger.error("Post Migration | Unexpected error: no master key in the rust session.");
        return;
    }
    const rustSeenMSK = Object.values(mskInfo.keys)[0];

    if (rustSeenMSK && rustSeenMSK == legacyLocallyTrustedMSK) {
        logger.info(`Post Migration: Migrating legacy trusted MSK: ${legacyLocallyTrustedMSK} to locally verified.`);
        // Let's mark the user identity as locally verified as part of the migration.
        await rustOwnIdentity!.verify();
        // As well as marking the MSK as trusted, `OlmMachine.verify` returns a
        // `SignatureUploadRequest` which will publish a signature of the MSK using
        // this device. In this case, we ignore the request: since the user hasn't
        // actually re-verified the MSK, we don't publish a new signature. (`.verify`
        // doesn't store the signature, and if we drop the request here it won't be
        // retried.)
        //
        // Not publishing the signature is consistent with the behaviour of
        // matrix-crypto-sdk when the private key is imported via
        // `importCrossSigningKeys`, and when the identity is verified via interactive
        // verification.
        //
        // [Aside: device signatures on the MSK are not considered by the rust-sdk to
        // establish the trust of the user identity so in any case, what we actually do
        // here is somewhat moot.]
    }
}

/**
 * Checks if the legacy store has a trusted public master key, and returns it if so.
 *
 * @param legacyStore - The legacy store to check.
 *
 * @returns `null` if there were no cross signing keys or if they were not trusted. The trusted public master key if it was.
 */
async function getLegacyTrustedPublicMasterKeyBase64(legacyStore: CryptoStore): Promise<string | null> {
    let maybeTrustedKeys: string | null = null;
    await legacyStore.doTxn("readonly", "account", (txn) => {
        legacyStore.getCrossSigningKeys(txn, (keys) => {
            // can be an empty object after resetting cross-signing keys, see storeTrustedSelfKeys
            const msk = keys?.master;
            if (msk && Object.keys(msk.keys).length != 0) {
                // `msk.keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
                maybeTrustedKeys = Object.values(msk.keys)[0];
            }
        });
    });

    return maybeTrustedKeys;
}
