/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { OlmMachine, SignatureVerification } from "@matrix-org/matrix-sdk-crypto-wasm";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    BackupTrustInfo,
    Curve25519AuthData,
    KeyBackupCheck,
    KeyBackupInfo,
    KeyBackupSession,
    Curve25519SessionData,
} from "../crypto-api/keybackup";
import { logger } from "../logger";
import { ClientPrefix, IHttpOpts, MatrixError, MatrixHttpApi, Method } from "../http-api";
import { CryptoEvent, IMegolmSessionData } from "../crypto";
import { TypedEventEmitter } from "../models/typed-event-emitter";
import { encodeUri, logDuration } from "../utils";
import { OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { sleep } from "../utils";
import { BackupDecryptor } from "../common-crypto/CryptoBackend";
import { IEncryptedPayload } from "../crypto/aes";
import { ImportRoomKeyProgressData, ImportRoomKeysOpts } from "../crypto-api";
import { IKeyBackupInfo } from "../crypto/keybackup";
import { IKeyBackup } from "../crypto/backup";

/** Authentification of the backup info, depends on algorithm */
type AuthData = KeyBackupInfo["auth_data"];

/**
 * Holds information of a created keybackup.
 * Useful to get the generated private key material and save it securely somewhere.
 */
interface KeyBackupCreationInfo {
    version: string;
    algorithm: string;
    authData: AuthData;
    decryptionKey: RustSdkCryptoJs.BackupDecryptionKey;
}

/**
 * @internal
 */
export class RustBackupManager extends TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap> {
    /** Have we checked if there is a backup on the server which we can use */
    private checkedForBackup = false;

    /**
     * The latest backup version on the server, when we last checked.
     *
     * If there was no backup on the server, `null`. If our attempt to check resulted in an error, `undefined`.
     *
     * Note that the backup was not necessarily verified.
     */
    private serverBackupInfo: KeyBackupInfo | null | undefined = undefined;

    private activeBackupVersion: string | null = null;
    private stopped = false;

    /** whether {@link backupKeysLoop} is currently running */
    private backupKeysLoopRunning = false;

    public constructor(
        private readonly olmMachine: OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {
        super();
    }

    /**
     * Tells the RustBackupManager to stop.
     * The RustBackupManager is scheduling background uploads of keys to the backup, this
     * call allows to cancel the process when the client is stoppped.
     */
    public stop(): void {
        this.stopped = true;
    }

    /**
     * Get the backup version we are currently backing up to, if any
     */
    public async getActiveBackupVersion(): Promise<string | null> {
        if (!(await this.olmMachine.isBackupEnabled())) return null;
        return this.activeBackupVersion;
    }

    /**
     * Return the details of the latest backup on the server, when we last checked.
     *
     * This normally returns a cached value, but if we haven't yet made a request to the server, it will fire one off.
     * It will always return the details of the active backup if key backup is enabled.
     *
     * If there was no backup on the server, `null`. If our attempt to check resulted in an error, `undefined`.
     */
    public async getServerBackupInfo(): Promise<KeyBackupInfo | null | undefined> {
        // Do a validity check if we haven't already done one. The check is likely to fail if we don't yet have the
        // backup keys -- but as a side-effect, it will populate `serverBackupInfo`.
        await this.checkKeyBackupAndEnable(false);
        return this.serverBackupInfo;
    }

    /**
     * Determine if a key backup can be trusted.
     *
     * @param info - key backup info dict from {@link MatrixClient#getKeyBackupVersion}.
     */
    public async isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo> {
        const signatureVerification: SignatureVerification = await this.olmMachine.verifyBackup(info);

        const backupKeys: RustSdkCryptoJs.BackupKeys = await this.olmMachine.getBackupKeys();
        const decryptionKey = backupKeys?.decryptionKey;
        const backupMatchesSavedPrivateKey =
            !!decryptionKey && backupInfoMatchesBackupDecryptionKey(info, decryptionKey);
        return {
            matchesDecryptionKey: backupMatchesSavedPrivateKey,
            trusted: signatureVerification.trusted(),
        };
    }

    /**
     * Re-check the key backup and enable/disable it as appropriate.
     *
     * @param force - whether we should force a re-check even if one has already happened.
     */
    public checkKeyBackupAndEnable(force: boolean): Promise<KeyBackupCheck | null> {
        if (!force && this.checkedForBackup) {
            return Promise.resolve(null);
        }

        // make sure there is only one check going on at a time
        if (!this.keyBackupCheckInProgress) {
            this.keyBackupCheckInProgress = this.doCheckKeyBackup().finally(() => {
                this.keyBackupCheckInProgress = null;
            });
        }
        return this.keyBackupCheckInProgress;
    }

    /**
     * Handles a backup secret received event and store it if it matches the current backup version.
     *
     * @param secret - The secret as received from a `m.secret.send` event for secret `m.megolm_backup.v1`.
     * @returns true if the secret is valid and has been stored, false otherwise.
     */
    public async handleBackupSecretReceived(secret: string): Promise<boolean> {
        // Currently we only receive the decryption key without any key backup version. It is important to
        // check that the secret is valid for the current version before storing it.
        // We force a check to ensure to have the latest version. We also want to check that the backup is trusted
        // as we don't want to store the secret if the backup is not trusted, and eventually import megolm keys later from an untrusted backup.
        const backupCheck = await this.checkKeyBackupAndEnable(true);

        if (!backupCheck?.backupInfo?.version || !backupCheck.trustInfo.trusted) {
            // There is no server-side key backup, or the backup is not signed by a trusted cross-signing key or trusted own device.
            // This decryption key is useless to us.
            logger.warn(
                "handleBackupSecretReceived: Received a backup decryption key, but there is no trusted server-side key backup",
            );
            return false;
        }

        try {
            const backupDecryptionKey = RustSdkCryptoJs.BackupDecryptionKey.fromBase64(secret);
            const privateKeyMatches = backupInfoMatchesBackupDecryptionKey(backupCheck.backupInfo, backupDecryptionKey);
            if (!privateKeyMatches) {
                logger.warn(
                    `handleBackupSecretReceived: Private decryption key does not match the public key of the current remote backup.`,
                );
                // just ignore the secret
                return false;
            }
            logger.info(
                `handleBackupSecretReceived: A valid backup decryption key has been received and stored in cache.`,
            );
            await this.saveBackupDecryptionKey(backupDecryptionKey, backupCheck.backupInfo.version);
            return true;
        } catch (e) {
            logger.warn("handleBackupSecretReceived: Invalid backup decryption key", e);
        }

        return false;
    }

    public async saveBackupDecryptionKey(
        backupDecryptionKey: RustSdkCryptoJs.BackupDecryptionKey,
        version: string,
    ): Promise<void> {
        await this.olmMachine.saveBackupDecryptionKey(backupDecryptionKey, version);
        // Emit an event that we have a new backup decryption key, so that the sdk can start
        // importing keys from backup if needed.
        this.emit(CryptoEvent.KeyBackupDecryptionKeyCached, version);
    }

    /**
     * Import a list of room keys previously exported by exportRoomKeys
     *
     * @param keys - a list of session export objects
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    public async importRoomKeys(keys: IMegolmSessionData[], opts?: ImportRoomKeysOpts): Promise<void> {
        await this.importRoomKeysAsJson(JSON.stringify(keys), opts);
    }

    /**
     * Import a list of room keys previously exported by exportRoomKeysAsJson
     *
     * @param keys - a JSON string encoding a list of session export objects,
     *    each of which is an IMegolmSessionData
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    public async importRoomKeysAsJson(jsonKeys: string, opts?: ImportRoomKeysOpts): Promise<void> {
        await this.olmMachine.importExportedRoomKeys(jsonKeys, (progress: BigInt, total: BigInt): void => {
            const importOpt: ImportRoomKeyProgressData = {
                total: Number(total),
                successes: Number(progress),
                stage: "load_keys",
                failures: 0,
            };
            opts?.progressCallback?.(importOpt);
        });
    }

    /**
     * Implementation of {@link CryptoBackend#importBackedUpRoomKeys}.
     */
    public async importBackedUpRoomKeys(
        keys: IMegolmSessionData[],
        backupVersion: string,
        opts?: ImportRoomKeysOpts,
    ): Promise<void> {
        const keysByRoom: Map<RustSdkCryptoJs.RoomId, Map<string, IMegolmSessionData>> = new Map();
        for (const key of keys) {
            const roomId = new RustSdkCryptoJs.RoomId(key.room_id);
            if (!keysByRoom.has(roomId)) {
                keysByRoom.set(roomId, new Map());
            }
            keysByRoom.get(roomId)!.set(key.session_id, key);
        }
        await this.olmMachine.importBackedUpRoomKeys(
            keysByRoom,
            (progress: BigInt, total: BigInt, failures: BigInt): void => {
                const importOpt: ImportRoomKeyProgressData = {
                    total: Number(total),
                    successes: Number(progress),
                    stage: "load_keys",
                    failures: Number(failures),
                };
                opts?.progressCallback?.(importOpt);
            },
            backupVersion,
        );
    }

    private keyBackupCheckInProgress: Promise<KeyBackupCheck | null> | null = null;

    /** Helper for `checkKeyBackup` */
    private async doCheckKeyBackup(): Promise<KeyBackupCheck | null> {
        logger.log("Checking key backup status...");
        let backupInfo: KeyBackupInfo | null | undefined;
        try {
            backupInfo = await this.requestKeyBackupVersion();
        } catch (e) {
            logger.warn("Error checking for active key backup", e);
            this.serverBackupInfo = undefined;
            return null;
        }
        this.checkedForBackup = true;

        if (backupInfo && !backupInfo.version) {
            logger.warn("active backup lacks a useful 'version'; ignoring it");
            backupInfo = undefined;
        }
        this.serverBackupInfo = backupInfo;

        const activeVersion = await this.getActiveBackupVersion();

        if (!backupInfo) {
            if (activeVersion !== null) {
                logger.log("No key backup present on server: disabling key backup");
                await this.disableKeyBackup();
            } else {
                logger.log("No key backup present on server: not enabling key backup");
            }
            return null;
        }

        const trustInfo = await this.isKeyBackupTrusted(backupInfo);

        if (!trustInfo.trusted) {
            if (activeVersion !== null) {
                logger.log("Key backup present on server but not trusted: disabling key backup");
                await this.disableKeyBackup();
            } else {
                logger.log("Key backup present on server but not trusted: not enabling key backup");
            }
        } else {
            if (activeVersion === null) {
                logger.log(`Found usable key backup v${backupInfo.version}: enabling key backups`);
                await this.enableKeyBackup(backupInfo);
            } else if (activeVersion !== backupInfo.version) {
                logger.log(`On backup version ${activeVersion} but found version ${backupInfo.version}: switching.`);
                // This will remove any pending backup request, remove the backup key and reset the backup state of each room key we have.
                await this.disableKeyBackup();
                // Enabling will now trigger re-upload of all the keys
                await this.enableKeyBackup(backupInfo);
            } else {
                logger.log(`Backup version ${backupInfo.version} still current`);
            }
        }
        return { backupInfo, trustInfo };
    }

    private async enableKeyBackup(backupInfo: KeyBackupInfo): Promise<void> {
        // we know for certain it must be a Curve25519 key, because we have verified it and only Curve25519
        // keys can be verified.
        //
        // we also checked it has a valid `version`.
        await this.olmMachine.enableBackupV1(
            (backupInfo.auth_data as Curve25519AuthData).public_key,
            backupInfo.version!,
        );
        this.activeBackupVersion = backupInfo.version!;

        this.emit(CryptoEvent.KeyBackupStatus, true);

        this.backupKeysLoop();
    }

    /**
     * Restart the backup key loop if there is an active trusted backup.
     * Doesn't try to check the backup server side. To be called when a new
     * megolm key is known locally.
     */
    public async maybeUploadKey(): Promise<void> {
        if (this.activeBackupVersion != null) {
            this.backupKeysLoop();
        }
    }

    private async disableKeyBackup(): Promise<void> {
        await this.olmMachine.disableBackup();
        this.activeBackupVersion = null;
        this.emit(CryptoEvent.KeyBackupStatus, false);
    }

    private async backupKeysLoop(maxDelay = 10000): Promise<void> {
        if (this.backupKeysLoopRunning) {
            logger.log(`Backup loop already running`);
            return;
        }
        this.backupKeysLoopRunning = true;

        logger.log(`Backup: Starting keys upload loop for backup version:${this.activeBackupVersion}.`);

        // wait between 0 and `maxDelay` seconds, to avoid backup
        // requests from different clients hitting the server all at
        // the same time when a new key is sent
        const delay = Math.random() * maxDelay;
        await sleep(delay);

        try {
            // number of consecutive network failures for exponential backoff
            let numFailures = 0;
            // The number of keys left to back up. (Populated lazily: see more comments below.)
            let remainingToUploadCount: number | null = null;
            // To avoid computing the key when only a few keys were added (after a sync for example),
            // we compute the count only when at least two iterations are needed.
            let isFirstIteration = true;

            while (!this.stopped) {
                // Get a batch of room keys to upload
                let request: RustSdkCryptoJs.KeysBackupRequest | null = null;
                try {
                    request = await logDuration(
                        logger,
                        "BackupRoomKeys: Get keys to backup from rust crypto-sdk",
                        async () => {
                            return await this.olmMachine.backupRoomKeys();
                        },
                    );
                } catch (err) {
                    logger.error("Backup: Failed to get keys to backup from rust crypto-sdk", err);
                }

                if (!request || this.stopped || !this.activeBackupVersion) {
                    logger.log(`Backup: Ending loop for version ${this.activeBackupVersion}.`);
                    if (!request) {
                        // nothing more to upload
                        this.emit(CryptoEvent.KeyBackupSessionsRemaining, 0);
                    }
                    return;
                }

                try {
                    await this.outgoingRequestProcessor.makeOutgoingRequest(request);
                    numFailures = 0;
                    if (this.stopped) break;

                    // Key count performance (`olmMachine.roomKeyCounts()`) can be pretty bad on some configurations.
                    // In particular, we detected on some M1 macs that when the object store reaches a threshold, the count
                    // performance stops growing in O(n) and suddenly becomes very slow (40s, 60s or more).
                    // For reference, the performance drop occurs around 300-400k keys on the platforms where this issue is observed.
                    // Even on other configurations, the count can take several seconds.
                    // This will block other operations on the database, like sending messages.
                    //
                    // This is a workaround to avoid calling `olmMachine.roomKeyCounts()` too often, and only when necessary.
                    // We don't call it on the first loop because there could be only a few keys to upload, and we don't want to wait for the count.
                    if (!isFirstIteration && remainingToUploadCount === null) {
                        try {
                            const keyCount = await this.olmMachine.roomKeyCounts();
                            remainingToUploadCount = keyCount.total - keyCount.backedUp;
                        } catch (err) {
                            logger.error("Backup: Failed to get key counts from rust crypto-sdk", err);
                        }
                    }

                    if (remainingToUploadCount !== null) {
                        this.emit(CryptoEvent.KeyBackupSessionsRemaining, remainingToUploadCount);
                        const keysCountInBatch = this.keysCountInBatch(request);
                        // `OlmMachine.roomKeyCounts` is called only once for the current backupKeysLoop. But new
                        // keys could be added during the current loop (after a sync for example).
                        // So the count can get out of sync with the real number of remaining keys to upload.
                        // Depending on the number of new keys imported and the time to complete the loop,
                        // this could result in multiple events being emitted with a remaining key count of 0.
                        remainingToUploadCount = Math.max(remainingToUploadCount - keysCountInBatch, 0);
                    }
                } catch (err) {
                    numFailures++;
                    logger.error("Backup: Error processing backup request for rust crypto-sdk", err);
                    if (err instanceof MatrixError) {
                        const errCode = err.data.errcode;
                        if (errCode == "M_NOT_FOUND" || errCode == "M_WRONG_ROOM_KEYS_VERSION") {
                            logger.log(`Backup: Failed to upload keys to current vesion: ${errCode}.`);
                            try {
                                await this.disableKeyBackup();
                            } catch (error) {
                                logger.error("Backup: An error occurred while disabling key backup:", error);
                            }
                            this.emit(CryptoEvent.KeyBackupFailed, err.data.errcode!);
                            // There was an active backup and we are out of sync with the server
                            // force a check server side
                            this.backupKeysLoopRunning = false;
                            this.checkKeyBackupAndEnable(true);
                            return;
                        } else if (errCode == "M_LIMIT_EXCEEDED") {
                            // wait for that and then continue?
                            const waitTime = err.data.retry_after_ms;
                            if (waitTime > 0) {
                                await sleep(waitTime);
                                continue;
                            } // else go to the normal backoff
                        }
                    }

                    // Some other errors (mx, network, or CORS or invalid urls?) anyhow backoff
                    // exponential backoff if we have failures
                    await sleep(1000 * Math.pow(2, Math.min(numFailures - 1, 4)));
                }
                isFirstIteration = false;
            }
        } finally {
            this.backupKeysLoopRunning = false;
        }
    }

    /**
     * Utility method to count the number of keys in a backup request, in order to update the remaining keys count.
     * This should be the chunk size of the backup request for all requests but the last, but we don't have access to it
     * (it's static in the Rust SDK).
     * @param batch - The backup request to count the keys from.
     *
     * @returns The number of keys in the backup request.
     */
    private keysCountInBatch(batch: RustSdkCryptoJs.KeysBackupRequest): number {
        const parsedBody: IKeyBackup = JSON.parse(batch.body);
        let count = 0;
        for (const { sessions } of Object.values(parsedBody.rooms)) {
            count += Object.keys(sessions).length;
        }
        return count;
    }

    /**
     * Get information about the current key backup from the server
     *
     * @returns Information object from API or null if there is no active backup.
     */
    private async requestKeyBackupVersion(): Promise<KeyBackupInfo | null> {
        return await requestKeyBackupVersion(this.http);
    }

    /**
     * Creates a new key backup by generating a new random private key.
     *
     * If there is an existing backup server side it will be deleted and replaced
     * by the new one.
     *
     * @param signObject - Method that should sign the backup with existing device and
     * existing identity.
     * @returns a KeyBackupCreationInfo - All information related to the backup.
     */
    public async setupKeyBackup(signObject: (authData: AuthData) => Promise<void>): Promise<KeyBackupCreationInfo> {
        // Clean up any existing backup
        await this.deleteAllKeyBackupVersions();

        const randomKey = RustSdkCryptoJs.BackupDecryptionKey.createRandomKey();
        const pubKey = randomKey.megolmV1PublicKey;

        const authData = { public_key: pubKey.publicKeyBase64 };

        await signObject(authData);

        const res = await this.http.authedRequest<{ version: string }>(
            Method.Post,
            "/room_keys/version",
            undefined,
            {
                algorithm: pubKey.algorithm,
                auth_data: authData,
            },
            {
                prefix: ClientPrefix.V3,
            },
        );

        await this.saveBackupDecryptionKey(randomKey, res.version);

        return {
            version: res.version,
            algorithm: pubKey.algorithm,
            authData: authData,
            decryptionKey: randomKey,
        };
    }

    /**
     * Deletes all key backups.
     *
     * Will call the API to delete active backup until there is no more present.
     */
    public async deleteAllKeyBackupVersions(): Promise<void> {
        // there could be several backup versions. Delete all to be safe.
        let current = (await this.requestKeyBackupVersion())?.version ?? null;
        while (current != null) {
            await this.deleteKeyBackupVersion(current);
            current = (await this.requestKeyBackupVersion())?.version ?? null;
        }

        // XXX: Should this also update Secret Storage and delete any existing keys?
    }

    /**
     * Deletes the given key backup.
     *
     * @param version - The backup version to delete.
     */
    public async deleteKeyBackupVersion(version: string): Promise<void> {
        logger.debug(`deleteKeyBackupVersion v:${version}`);
        const path = encodeUri("/room_keys/version/$version", { $version: version });
        await this.http.authedRequest<void>(Method.Delete, path, undefined, undefined, {
            prefix: ClientPrefix.V3,
        });
    }

    /**
     * Creates a new backup decryptor for the given private key.
     * @param decryptionKey - The private key to use for decryption.
     */
    public createBackupDecryptor(decryptionKey: RustSdkCryptoJs.BackupDecryptionKey): BackupDecryptor {
        return new RustBackupDecryptor(decryptionKey);
    }
}

/**
 * Checks if the provided backup info matches the given private key.
 *
 * @param info - The backup info to check.
 * @param backupDecryptionKey - The `BackupDecryptionKey` private key to check against.
 * @returns `true` if the private key can decrypt the backup, `false` otherwise.
 */
function backupInfoMatchesBackupDecryptionKey(
    info: KeyBackupInfo,
    backupDecryptionKey: RustSdkCryptoJs.BackupDecryptionKey,
): boolean {
    if (info.algorithm !== "m.megolm_backup.v1.curve25519-aes-sha2") {
        logger.warn("backupMatchesPrivateKey: Unsupported backup algorithm", info.algorithm);
        return false;
    }

    return (info.auth_data as Curve25519AuthData)?.public_key === backupDecryptionKey.megolmV1PublicKey.publicKeyBase64;
}

/**
 * Implementation of {@link BackupDecryptor} for the rust crypto backend.
 */
export class RustBackupDecryptor implements BackupDecryptor {
    private decryptionKey: RustSdkCryptoJs.BackupDecryptionKey;
    public sourceTrusted: boolean;

    public constructor(decryptionKey: RustSdkCryptoJs.BackupDecryptionKey) {
        this.decryptionKey = decryptionKey;
        this.sourceTrusted = false;
    }

    /**
     * Implements {@link BackupDecryptor#decryptSessions}
     */
    public async decryptSessions(
        ciphertexts: Record<string, KeyBackupSession<Curve25519SessionData | IEncryptedPayload>>,
    ): Promise<IMegolmSessionData[]> {
        const keys: IMegolmSessionData[] = [];
        for (const [sessionId, sessionData] of Object.entries(ciphertexts)) {
            try {
                const decrypted = JSON.parse(
                    this.decryptionKey.decryptV1(
                        sessionData.session_data.ephemeral,
                        sessionData.session_data.mac,
                        sessionData.session_data.ciphertext,
                    ),
                );
                decrypted.session_id = sessionId;
                keys.push(decrypted);
            } catch (e) {
                logger.log("Failed to decrypt megolm session from backup", e, sessionData);
            }
        }
        return keys;
    }

    /**
     * Implements {@link BackupDecryptor#free}
     */
    public free(): void {
        this.decryptionKey.free();
    }
}

export async function requestKeyBackupVersion(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
): Promise<IKeyBackupInfo | null> {
    try {
        return await http.authedRequest<KeyBackupInfo>(Method.Get, "/room_keys/version", undefined, undefined, {
            prefix: ClientPrefix.V3,
        });
    } catch (e) {
        if ((<MatrixError>e).errcode === "M_NOT_FOUND") {
            return null;
        } else {
            throw e;
        }
    }
}

export type RustBackupCryptoEvents =
    | CryptoEvent.KeyBackupStatus
    | CryptoEvent.KeyBackupSessionsRemaining
    | CryptoEvent.KeyBackupFailed
    | CryptoEvent.KeyBackupDecryptionKeyCached;

export type RustBackupCryptoEventMap = {
    [CryptoEvent.KeyBackupStatus]: (enabled: boolean) => void;
    [CryptoEvent.KeyBackupSessionsRemaining]: (remaining: number) => void;
    [CryptoEvent.KeyBackupFailed]: (errCode: string) => void;
    [CryptoEvent.KeyBackupDecryptionKeyCached]: (version: string) => void;
};
