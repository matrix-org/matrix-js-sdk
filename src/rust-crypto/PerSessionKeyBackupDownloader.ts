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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";

import { Curve25519AuthData, KeyBackupInfo, KeyBackupSession } from "../crypto-api/keybackup";
import { IMegolmSessionData } from "../crypto";
import { Logger } from "../logger";
import { ClientPrefix, IHttpOpts, MatrixError, MatrixHttpApi, Method } from "../http-api";
import { RustBackupCryptoEventMap, RustBackupCryptoEvents, RustBackupDecryptor, RustBackupManager } from "./backup";
import { CryptoEvent, TypedEventEmitter } from "../matrix";
import { encodeUri, sleep } from "../utils";
import { RustCrypto } from "./rust-crypto";

/**
 * Extract the dependices of the OnDemandKeyBackupDownloader, main reason is to make testing easier.
 */
export interface OnDemandBackupDelegate {
    getActiveBackupVersion(): Promise<string | null>;

    getBackupDecryptionKey(): Promise<RustSdkCryptoJs.BackupKeys | null>;

    requestRoomKeyFromBackup(version: string, rooomId: string, sessionId: string): Promise<KeyBackupSession>;

    importRoomKeys(keys: IMegolmSessionData[]): Promise<void>;

    createBackupDecryptor(key: RustSdkCryptoJs.BackupDecryptionKey): RustBackupDecryptor;

    requestKeyBackupVersion(): Promise<KeyBackupInfo | null>;

    /**
     * The backup downloader will listen to these events to know when to check for backup status changes in order to
     * resume or stop querying.
     */
    getCryptoEventEmitter(): TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>;
}

/**
 * Utility to create a delegate for the OnDemandKeyBackupDownloader that is usable by rust crypto.
 * @param rustCrypto - The rust crypto instance.
 * @param backupManager - The backup manager instance.
 * @param olmMachine - The olm machine instance.
 * @param http - The http instance.
 */
export function createDelegate(
    rustCrypto: RustCrypto,
    backupManager: RustBackupManager,
    olmMachine: OlmMachine,
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
): OnDemandBackupDelegate {
    return {
        getActiveBackupVersion(): Promise<string | null> {
            return backupManager.getActiveBackupVersion();
        },

        async getBackupDecryptionKey(): Promise<RustSdkCryptoJs.BackupKeys | null> {
            try {
                return await olmMachine.getBackupKeys();
            } catch (e) {
                return null;
            }
        },

        async requestRoomKeyFromBackup(version: string, roomId: string, sessionId: string): Promise<KeyBackupSession> {
            const path = encodeUri("/room_keys/keys/$roomId/$sessionId", {
                $roomId: roomId,
                $sessionId: sessionId,
            });

            return await http.authedRequest<KeyBackupSession>(Method.Get, path, { version }, undefined, {
                prefix: ClientPrefix.V3,
            });
        },

        async importRoomKeys(keys: IMegolmSessionData[]): Promise<void> {
            return rustCrypto.importRoomKeys(keys);
        },

        createBackupDecryptor: (key: RustSdkCryptoJs.BackupDecryptionKey): RustBackupDecryptor => {
            return new RustBackupDecryptor(key);
        },

        async requestKeyBackupVersion(): Promise<KeyBackupInfo | null> {
            return await backupManager.requestKeyBackupVersion();
        },

        getCryptoEventEmitter(): TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap> {
            return rustCrypto;
        },
    };
}

export enum KeyDownloadError {
    VERSION_MISMATCH = "VERSION_MISMATCH",
    MISSING_DECRYPTION_KEY = "MISSING_DECRYPTION_KEY",
    NETWORK_ERROR = "NETWORK_ERROR",
    STOPPED = "STOPPED",
    UNKNOWN_ERROR = "UNKNOWN_ERROR",
    RATE_LIMITED = "RATE_LIMITED",
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
}

type SessionInfo = { roomId: string; megolmSessionId: string };

type KeyDownloadResult =
    | { ok: true; value: KeyBackupSession }
    | { ok: false; error: KeyDownloadError; [key: string]: any };

type Configuration = {
    backupVersion: string;
    decryptor: RustBackupDecryptor;
};

export enum KeyDownloaderEvent {
    DownloadLoopStateUpdate = "download_loop_started",
    DownLoopStep = "download_loop_step",
    QueryKeyError = "query_key_error",
    KeyImported = "key_imported",
}
export type KeyDownloaderEventMap = {
    [KeyDownloaderEvent.DownloadLoopStateUpdate]: (loopRunning: boolean) => void;
    [KeyDownloaderEvent.DownLoopStep]: (remaining: number) => void;
    [KeyDownloaderEvent.QueryKeyError]: (errCode: KeyDownloadError) => void;
    [KeyDownloaderEvent.KeyImported]: (roomId: string, sessionId: string) => void;
};

/**
 * When an unable to decrypt error is encountered, the client will call this
 * in order to try to download the key from the backup.
 *
 */
export class PerSessionKeyBackupDownloader extends TypedEventEmitter<KeyDownloaderEvent, KeyDownloaderEventMap> {
    private stopped = false;

    private configuration: Configuration | null = null;

    /** We remember when a session was requested and not found in backup to avoid query again too soon. */
    private sessionLastCheckAttemptedTime: Record<string, number> = {};

    public constructor(
        private readonly delegate: OnDemandBackupDelegate,
        private readonly logger: Logger,
        private readonly maxTimeBetweenRetry: number,
    ) {
        super();

        const emitter = this.delegate.getCryptoEventEmitter();

        emitter.on(CryptoEvent.KeyBackupStatus, (ev) => {
            this.logger.info(`Key backup status changed, check configuration`);
            // we want to check configuration
            this.onBackupStatusChanged();
        });

        emitter.on(CryptoEvent.KeyBackupFailed, (ev) => {
            this.logger.info(`Key backup upload failed, check configuration`);
            // we want to check configuration
            this.onBackupStatusChanged();
        });

        /// TODO When the PR that adds signaling when the decryption is merged, we can use it to trigger a refresh
        // emitter.on(CryptoEvent.KeyBackupPrivateKeyCached, (ev) => {
        //     this.logger.info(`Key backup decryption key is known, check configuration`);
        //     // we want to check configuration
        //     this.onBackupStatusChanged();
        // });
    }

    public stop(): void {
        this.stopped = true;
    }

    private onBackupStatusChanged(): void {
        // we want to check configuration
        this.hasConfigurationProblem = false;
        this.configuration = null;
        this.getOrCreateBackupDecryptor(true).then((decryptor) => {
            if (decryptor) {
                this.downloadKeysLoop();
            }
        });
    }

    private downloadLoopRunning = false;

    private queuedRequests: SessionInfo[] = [];

    private isAlreadyInQueue(roomId: string, megolmSessionId: string): boolean {
        return (
            this.queuedRequests.findIndex((info) => {
                return info.roomId == roomId && info.megolmSessionId == megolmSessionId;
            }) != -1
        );
    }

    private markAsNotFoundInBackup(megolmSessionId: string): void {
        const now = Date.now();
        this.sessionLastCheckAttemptedTime[megolmSessionId] = now;
        // if too big make some cleaning to keep under control
        if (Object.keys(this.sessionLastCheckAttemptedTime).length > 100) {
            for (const key in this.sessionLastCheckAttemptedTime) {
                if (Math.max(now - this.sessionLastCheckAttemptedTime[key], 0) > this.maxTimeBetweenRetry) {
                    delete this.sessionLastCheckAttemptedTime[key];
                }
            }
        }
    }

    private wasRequestedRecently(megolmSessionId: string): boolean {
        const lastCheck = this.sessionLastCheckAttemptedTime[megolmSessionId];
        if (!lastCheck) return false;
        return Math.max(Date.now() - lastCheck, 0) < this.maxTimeBetweenRetry;
    }

    private hasConfigurationProblem = false;

    private pauseLoop(): void {
        this.downloadLoopRunning = false;
        this.emit(KeyDownloaderEvent.DownloadLoopStateUpdate, false);
    }
    /**
     * Called when a MissingRoomKey or UnknownMessageIndex decryption error is encountered.
     *
     * This will try to download the key from the backup if there is a trusted active backup.
     * In case of success the key will be imported and the onRoomKeysUpdated callback will be called
     * internally by the rust-sdk and decrytion will be retried.
     *
     * @param roomId - The room ID of the room where the error occurred.
     * @param megolmSessionId - The megolm session ID that is missing.
     */
    public onDecryptionKeyMissingError(roomId: string, megolmSessionId: string): void {
        // Several messages encrypted with the same session may be decrypted at the same time,
        // so we need to be resistant and not query several time the same session.
        if (this.isAlreadyInQueue(roomId, megolmSessionId)) {
            // There is already a request queued for this session, no need to queue another one.
            this.logger.trace(`Not checking key backup for session ${megolmSessionId} as it is already queued`);
            return;
        }

        if (this.wasRequestedRecently(megolmSessionId)) {
            // We already tried to download this session recently, no need to try again.
            this.logger.trace(
                `Not checking key backup for session ${megolmSessionId} as it was already requested recently`,
            );
            return;
        }

        // We always add the request to the queue, even if we have a configuration problem (can't access backup).
        // This is to make sure that if the configuration problem is resolved, we will try to download the key.
        // This will happen after an initial sync, at this point the backup will not yet be trusted, but it will be
        // just after the verification.
        // We don't need to persist it because currently on refresh the sdk will retry to decrypt the messages.
        this.queuedRequests.push({ roomId, megolmSessionId });

        // Start the download loop if it's not already running.
        this.downloadKeysLoop();
    }

    private async downloadKeysLoop(): Promise<void> {
        if (this.downloadLoopRunning) return;

        // If we have a configuration problem, we don't want to try to download.
        // If any configuration change is detected, we will retry and restart the loop.
        if (this.hasConfigurationProblem) return;

        this.downloadLoopRunning = true;
        this.emit(KeyDownloaderEvent.DownloadLoopStateUpdate, true);

        while (this.queuedRequests.length > 0) {
            this.emit(KeyDownloaderEvent.DownLoopStep, this.queuedRequests.length);
            // we just peek the first one without removing it, so if a new request for same key comes in while we're
            // processing this one, it won't queue another request.
            const request = this.queuedRequests[0];
            const result = await this.queryKeyBackup(request.roomId, request.megolmSessionId);
            if (this.stopped) {
                this.emit(KeyDownloaderEvent.QueryKeyError, KeyDownloadError.STOPPED);
                return;
            }
            if (result.ok) {
                // We got the encrypted key from backup, let's try to decrypt and import it.
                try {
                    await this.decryptAndImport(request, result.value);
                    this.emit(KeyDownloaderEvent.KeyImported, request.roomId, request.megolmSessionId);
                } catch (e) {
                    this.emit(KeyDownloaderEvent.QueryKeyError, KeyDownloadError.UNKNOWN_ERROR);
                    this.logger.error(
                        `Error while decrypting and importing key backup for session ${request.megolmSessionId}`,
                        e,
                    );
                }
                // now remove the request from the queue as we've processed it.
                this.queuedRequests.shift();
            } else {
                this.emit(KeyDownloaderEvent.QueryKeyError, result.error);
                this.logger.debug(
                    `Error while downloading key backup for session ${request.megolmSessionId}: ${result.error}`,
                );
                switch (result.error) {
                    case KeyDownloadError.VERSION_MISMATCH: {
                        // We don't have the correct decryption key, so stop the loop.
                        // If we get the key later, we will retry.
                        this.pauseLoop();
                        return;
                    }
                    case KeyDownloadError.MISSING_DECRYPTION_KEY: {
                        this.markAsNotFoundInBackup(request.megolmSessionId);
                        // continue for next one
                        this.queuedRequests.shift();
                        break;
                    }
                    case KeyDownloadError.CONFIGURATION_ERROR: {
                        // Backup is not configured correctly, so stop the loop.
                        this.pauseLoop();
                        return;
                    }
                    case KeyDownloadError.RATE_LIMITED: {
                        // we want to retry
                        await sleep(result.retryAfterMs ?? this.maxTimeBetweenRetry);
                        break;
                    }
                    case KeyDownloadError.NETWORK_ERROR: {
                        // We don't want to hammer if there is a problem, so wait a bit.
                        await sleep(this.maxTimeBetweenRetry);
                        break;
                    }
                    case KeyDownloadError.STOPPED:
                        // If the downloader was stopped, we don't want to retry.
                        this.pauseLoop();
                        return;
                }
            }
        }
        this.pauseLoop();
    }
    /**
     * Query the backup for a key.
     *
     * @param targetRoomId - ID of the room that the session is used in.
     * @param targetSessionId - ID of the session for which to check backup.
     */
    private async queryKeyBackup(targetRoomId: string, targetSessionId: string): Promise<KeyDownloadResult> {
        const configuration = await this.getOrCreateBackupDecryptor(false);
        if (!configuration) {
            return { ok: false, error: KeyDownloadError.CONFIGURATION_ERROR };
        }

        this.logger.debug(`Checking key backup for session ${targetSessionId}`);

        let res: KeyBackupSession;

        try {
            res = await this.delegate.requestRoomKeyFromBackup(
                configuration.backupVersion,
                targetRoomId,
                targetSessionId,
            );
        } catch (e) {
            if (this.stopped) return { ok: false, error: KeyDownloadError.STOPPED };

            this.logger.info(`No luck requesting key backup for session ${targetSessionId}: ${e}`);
            if (e instanceof MatrixError) {
                const errCode = e.data.errcode;
                if (errCode == "M_NOT_FOUND") {
                    // Unfortunately the spec doesn't give us a way to differentiate between a missing key and a wrong version.
                    // Synapse will return:
                    //     - "error": "Unknown backup version" if the version is wrong.
                    //     - "error": "No room_keys found" if the key is missing.
                    // For now we check the error message, but this is not ideal.
                    // It's useful to know if the key is missing or if the version is wrong.
                    if (e.data.error == "Unknown backup version") {
                        return { ok: false, error: KeyDownloadError.VERSION_MISMATCH };
                    }
                    return { ok: false, error: KeyDownloadError.MISSING_DECRYPTION_KEY };
                }
                if (errCode == "M_LIMIT_EXCEEDED") {
                    const waitTime = e.data.retry_after_ms;
                    if (waitTime > 0) {
                        this.logger.info(`Rate limited by server, waiting ${waitTime}ms`);
                        return { ok: false, error: KeyDownloadError.RATE_LIMITED, retryAfterMs: waitTime };
                    } else {
                        // apply a backoff time
                        return {
                            ok: false,
                            error: KeyDownloadError.RATE_LIMITED,
                            retryAfterMs: this.maxTimeBetweenRetry,
                        };
                    }
                }
            }
            return { ok: false, error: KeyDownloadError.NETWORK_ERROR };
        }

        if (this.stopped) return { ok: false, error: KeyDownloadError.STOPPED };

        return {
            ok: true,
            value: res,
        };
    }

    private async getOrCreateBackupDecryptor(forceCheck: boolean): Promise<Configuration | null> {
        if (this.configuration) {
            return this.configuration;
        }

        if (this.hasConfigurationProblem && !forceCheck) {
            return null;
        }

        const currentServerVersion = await this.delegate.requestKeyBackupVersion();

        if (currentServerVersion?.algorithm != "m.megolm_backup.v1.curve25519-aes-sha2") {
            this.logger.info(`getBackupDecryptor Unsupported algorithm ${currentServerVersion?.algorithm}`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (!currentServerVersion?.version) {
            this.logger.info(`No current key backup`);
            this.hasConfigurationProblem = true;
            return null;
        }

        const activeVersion = await this.delegate.getActiveBackupVersion();
        if (activeVersion == null || currentServerVersion.version != activeVersion) {
            // case when the server side current version is not trusted or is out of sync with the client side active version.
            this.logger.info(
                `The current backup version ${currentServerVersion.version} is not trusted. Active version=${activeVersion}`,
            );
            this.hasConfigurationProblem = true;
            return null;
        }

        const authData = <Curve25519AuthData>currentServerVersion.auth_data;

        const backupKeys = await this.delegate.getBackupDecryptionKey();
        if (!backupKeys?.decryptionKey) {
            this.logger.debug(`Not checking key backup for session(no decryption key)`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (activeVersion != backupKeys.backupVersion) {
            this.logger.debug(`Cached key version doesn't match active backup version`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (authData.public_key != backupKeys.decryptionKey.megolmV1PublicKey.publicKeyBase64) {
            this.logger.debug(`getBackupDecryptor key mismatch error`);
            this.hasConfigurationProblem = true;
            return null;
        }

        const backupDecryptor = this.delegate.createBackupDecryptor(backupKeys.decryptionKey);
        this.hasConfigurationProblem = false;
        this.configuration = {
            decryptor: backupDecryptor,
            backupVersion: activeVersion,
        };
        return this.configuration;
    }

    private async decryptAndImport(sessionInfo: SessionInfo, data: KeyBackupSession): Promise<void> {
        const configuration = await this.getOrCreateBackupDecryptor(false);

        if (!configuration) {
            throw new Error("Backup: No configuration");
        }

        const sessionsToImport: Record<string, KeyBackupSession> = { [sessionInfo.megolmSessionId]: data };

        const keys = await configuration!.decryptor.decryptSessions(sessionsToImport);
        for (const k of keys) {
            k.room_id = sessionInfo.roomId;
        }
        await this.delegate.importRoomKeys(keys);
    }
}
