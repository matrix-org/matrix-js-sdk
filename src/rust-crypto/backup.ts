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
import { encodeUri } from "../utils";
import { OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { sleep } from "../utils";
import { BackupDecryptor } from "../common-crypto/CryptoBackend";
import { IEncryptedPayload } from "../crypto/aes";

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
     * Determine if a key backup can be trusted.
     *
     * @param info - key backup info dict from {@link MatrixClient#getKeyBackupVersion}.
     */
    public async isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo> {
        const signatureVerification: SignatureVerification = await this.olmMachine.verifyBackup(info);

        const backupKeys: RustSdkCryptoJs.BackupKeys = await this.olmMachine.getBackupKeys();
        const pubKeyForSavedPrivateKey = backupKeys?.decryptionKey?.megolmV1PublicKey;
        const backupMatchesSavedPrivateKey =
            info.algorithm === pubKeyForSavedPrivateKey?.algorithm &&
            (info.auth_data as Curve25519AuthData)?.public_key === pubKeyForSavedPrivateKey.publicKeyBase64;

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
    private keyBackupCheckInProgress: Promise<KeyBackupCheck | null> | null = null;

    /** Helper for `checkKeyBackup` */
    private async doCheckKeyBackup(): Promise<KeyBackupCheck | null> {
        logger.log("Checking key backup status...");
        let backupInfo: KeyBackupInfo | null = null;
        try {
            backupInfo = await this.requestKeyBackupVersion();
        } catch (e) {
            logger.warn("Error checking for active key backup", e);
            return null;
        }
        this.checkedForBackup = true;

        if (backupInfo && !backupInfo.version) {
            logger.warn("active backup lacks a useful 'version'; ignoring it");
        }

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

        logger.log(`Starting loop for ${this.activeBackupVersion}.`);

        // wait between 0 and `maxDelay` seconds, to avoid backup
        // requests from different clients hitting the server all at
        // the same time when a new key is sent
        const delay = Math.random() * maxDelay;
        await sleep(delay);

        try {
            let numFailures = 0; // number of consecutive network failures for exponential backoff

            while (!this.stopped) {
                // Get a batch of room keys to upload
                const request: RustSdkCryptoJs.KeysBackupRequest | null = await this.olmMachine.backupRoomKeys();

                if (!request || this.stopped || !this.activeBackupVersion) {
                    logger.log(`Ending loop for ${this.activeBackupVersion}.`);
                    return;
                }

                try {
                    await this.outgoingRequestProcessor.makeOutgoingRequest(request);
                    numFailures = 0;

                    const keyCount: RustSdkCryptoJs.RoomKeyCounts = await this.olmMachine.roomKeyCounts();
                    const remaining = keyCount.total - keyCount.backedUp;
                    this.emit(CryptoEvent.KeyBackupSessionsRemaining, remaining);
                } catch (err) {
                    numFailures++;
                    logger.error("Error processing backup request for rust crypto-sdk", err);
                    if (err instanceof MatrixError) {
                        const errCode = err.data.errcode;
                        if (errCode == "M_NOT_FOUND" || errCode == "M_WRONG_ROOM_KEYS_VERSION") {
                            await this.disableKeyBackup();
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
                                sleep(waitTime);
                                continue;
                            } // else go to the normal backoff
                        }
                    }

                    // Some other errors (mx, network, or CORS or invalid urls?) anyhow backoff
                    // exponential backoff if we have failures
                    await sleep(1000 * Math.pow(2, Math.min(numFailures - 1, 4)));
                }
            }
        } finally {
            this.backupKeysLoopRunning = false;
        }
    }

    /**
     * Get information about the current key backup from the server
     *
     * @returns Information object from API or null if there is no active backup.
     */
    private async requestKeyBackupVersion(): Promise<KeyBackupInfo | null> {
        try {
            return await this.http.authedRequest<KeyBackupInfo>(
                Method.Get,
                "/room_keys/version",
                undefined,
                undefined,
                {
                    prefix: ClientPrefix.V3,
                },
            );
        } catch (e) {
            if ((<MatrixError>e).errcode === "M_NOT_FOUND") {
                return null;
            } else {
                throw e;
            }
        }
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

        this.olmMachine.saveBackupDecryptionKey(randomKey, res.version);

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
                    await this.decryptionKey.decryptV1(
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

export type RustBackupCryptoEvents =
    | CryptoEvent.KeyBackupStatus
    | CryptoEvent.KeyBackupSessionsRemaining
    | CryptoEvent.KeyBackupFailed;

export type RustBackupCryptoEventMap = {
    [CryptoEvent.KeyBackupStatus]: (enabled: boolean) => void;
    [CryptoEvent.KeyBackupSessionsRemaining]: (remaining: number) => void;
    [CryptoEvent.KeyBackupFailed]: (errCode: string) => void;
};
