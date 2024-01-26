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
        await migrateBaseData(args.http, args.userId, args.deviceId, legacyStore, pickleKey, args.storeHandle);

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
    // All we can really do is ask the server for the most recent version.
    if (recoveryKey) {
        const backupInfo = await requestKeyBackupVersion(http);
        if (backupInfo) {
            migrationData.backupVersion = backupInfo.version;
            migrationData.backupRecoveryKey = recoveryKey;
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

            // Not sure if we can reliably distinguish imported vs not-imported sessions in the libolm database.
            // For now at least, let's be conservative and say that all the sessions are imported (which means that
            // the Rust SDK treats them as less secure).
            pickledSession.imported = true;

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
    let encodedKey: IEncryptedPayload | null = null;

    await legacyStore.doTxn("readonly", "account", (txn) => {
        legacyStore.getSecretStorePrivateKey(
            txn,
            (k) => {
                encodedKey = k as IEncryptedPayload | null;
            },
            name as keyof SecretStorePrivateKeys,
        );
    });

    return encodedKey === null ? undefined : await decryptAES(encodedKey, legacyPickleKey, name);
}
