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

import { Curve25519AuthData, KeyBackupSession } from "../crypto-api/keybackup";
import { Logger } from "../logger";
import { ClientPrefix, IHttpOpts, MatrixError, MatrixHttpApi, Method } from "../http-api";
import { RustBackupManager } from "./backup";
import { CryptoEvent } from "../matrix";
import { encodeUri, sleep } from "../utils";
import { BackupDecryptor } from "../common-crypto/CryptoBackend";

/**
 * Enumerates the different kind of errors that can occurs when downloading and importing a key from backup.
 */
enum KeyDownloadError {
    /** The requested key is not in the backup. */
    MISSING_DECRYPTION_KEY = "MISSING_DECRYPTION_KEY",
    /** A network error occurred while trying to get the key. */
    NETWORK_ERROR = "NETWORK_ERROR",
    /** The loop has been stopped. */
    STOPPED = "STOPPED",
    /** An unknown error occurred while decrypting/importing the key */
    UNKNOWN_ERROR = "UNKNOWN_ERROR",
    /** The server is rate limiting us. */
    RATE_LIMITED = "RATE_LIMITED",
    /** The backup is not configured correctly.
     *
     * Example problems can include:
     *   * There is no backup
     *   * Backup is not trusted
     *   * We don't have the correct key in cache
     */
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
}

/** Details of a megolm session whose key we are trying to fetch. */
type SessionInfo = { roomId: string; megolmSessionId: string };

/** Helper type for the result of a key download. */
type KeyDownloadResult =
    | { ok: true; value: KeyBackupSession }
    | { ok: false; error: KeyDownloadError; [key: string]: any };

/** Holds the current backup decryptor and version that should be used. */
type Configuration = {
    backupVersion: string;
    decryptor: BackupDecryptor;
};

/**
 * Used when an 'unable to decrypt' error occurs. It attempts to download the key from the backup.
 *
 * The current backup API lacks pagination, which can lead to lengthy key retrieval times for large histories (several 10s of minutes).
 * To mitigate this, keys are downloaded on demand as decryption errors occurs.
 * While this approach may result in numerous requests, it improves user experience by reducing wait times for message decryption.
 *
 * The PerSessionKeyBackupDownloader is resistant to backup configuration changes: it will automatically resume querying when
 * the backup is configured correctly.
 */
export class PerSessionKeyBackupDownloader {
    private stopped = false;

    /** The version and decryption key to use with current backup if all setup correctly */
    private configuration: Configuration | null = null;

    /** We remember when a session was requested and not found in backup to avoid query again too soon.
     * Map of session_id to timestamp */
    private sessionLastCheckAttemptedTime: Map<string, number> = new Map();

    /** The logger to use */
    private readonly logger: Logger;

    /** Whether the download loop is running. */
    private downloadLoopRunning = false;

    /** The list of requests that are queued. */
    private queuedRequests: SessionInfo[] = [];

    // Remembers if we have a configuration problem.
    private hasConfigurationProblem = false;

    /** The current server backup version check promise. To avoid doing a server call if one is in flight. */
    private currentBackupVersionCheck: Promise<Configuration | null> | null = null;

    /**
     * Creates a new instance of PerSessionKeyBackupDownloader.
     *
     * @param backupManager - The backup manager to use.
     * @param olmMachine - The olm machine to use.
     * @param http - The http instance to use.
     * @param logger - The logger to use.
     * @param backoffDuration - The minimum time to wait between two retries in case of errors. To avoid hammering the server.
     *
     */
    public constructor(
        logger: Logger,
        private readonly olmMachine: OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly backupManager: RustBackupManager,
        private readonly backoffDuration: number,
    ) {
        this.logger = logger.getChild("[PerSessionKeyBackupDownloader]");

        backupManager.on(CryptoEvent.KeyBackupStatus, this.onBackupStatusChanged);
        backupManager.on(CryptoEvent.KeyBackupFailed, this.onBackupStatusChanged);
        backupManager.on(CryptoEvent.KeyBackupDecryptionKeyCached, this.onBackupStatusChanged);
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
            // We already tried to download this session recently and it was not in backup, no need to try again.
            this.logger.trace(
                `Not checking key backup for session ${megolmSessionId} as it was already requested recently`,
            );
            return;
        }

        // We always add the request to the queue, even if we have a configuration problem (can't access backup).
        // This is to make sure that if the configuration problem is resolved, we will try to download the key.
        // This will happen after an initial sync, at this point the backup will not yet be trusted and the decryption
        // key will not be available, but it will be just after the verification.
        // We don't need to persist it because currently on refresh the sdk will retry to decrypt the messages in error.
        this.queuedRequests.push({ roomId, megolmSessionId });

        // Start the download loop if it's not already running.
        this.downloadKeysLoop();
    }

    public stop(): void {
        this.stopped = true;
        this.backupManager.off(CryptoEvent.KeyBackupStatus, this.onBackupStatusChanged);
        this.backupManager.off(CryptoEvent.KeyBackupFailed, this.onBackupStatusChanged);
        this.backupManager.off(CryptoEvent.KeyBackupDecryptionKeyCached, this.onBackupStatusChanged);
    }

    /**
     * Called when the backup status changes (CryptoEvents)
     * This will trigger a check of the backup configuration.
     */
    private onBackupStatusChanged = (): void => {
        // we want to check configuration
        this.hasConfigurationProblem = false;
        this.configuration = null;
        this.getOrCreateBackupConfiguration(true).then((decryptor) => {
            if (decryptor) {
                this.downloadKeysLoop();
            }
        });
    };

    /** Returns true if the megolm session is already queued for download. */
    private isAlreadyInQueue(roomId: string, megolmSessionId: string): boolean {
        return this.queuedRequests.some((info) => {
            return info.roomId == roomId && info.megolmSessionId == megolmSessionId;
        });
    }

    /**
     * Marks the session as not found in backup, to avoid retrying to soon for a key not in backup
     * @param megolmSessionId - The megolm session ID that is missing.
     * */
    private markAsNotFoundInBackup(megolmSessionId: string): void {
        const now = Date.now();
        this.sessionLastCheckAttemptedTime.set(megolmSessionId, now);
        // if too big make some cleaning to keep under control
        if (this.sessionLastCheckAttemptedTime.size > 100) {
            this.sessionLastCheckAttemptedTime = new Map(
                Array.from(this.sessionLastCheckAttemptedTime).filter((sid, ts) => {
                    return Math.max(now - ts, 0) < this.backoffDuration;
                }),
            );
        }
    }

    /** Returns true if the session was requested recently. */
    private wasRequestedRecently(megolmSessionId: string): boolean {
        const lastCheck = this.sessionLastCheckAttemptedTime.get(megolmSessionId);
        if (!lastCheck) return false;
        return Math.max(Date.now() - lastCheck, 0) < this.backoffDuration;
    }

    private pauseLoop(): void {
        this.downloadLoopRunning = false;
    }

    private async getBackupDecryptionKey(): Promise<RustSdkCryptoJs.BackupKeys | null> {
        try {
            return await this.olmMachine.getBackupKeys();
        } catch (e) {
            return null;
        }
    }

    /**
     * Requests a key from the server side backup.
     * @param version - The backup version to use.
     * @param roomId - The room ID of the room where the error occurred.
     * @param sessionId - The megolm session ID that is missing.
     *
     */
    private async requestRoomKeyFromBackup(
        version: string,
        roomId: string,
        sessionId: string,
    ): Promise<KeyBackupSession> {
        const path = encodeUri("/room_keys/keys/$roomId/$sessionId", {
            $roomId: roomId,
            $sessionId: sessionId,
        });

        return await this.http.authedRequest<KeyBackupSession>(Method.Get, path, { version }, undefined, {
            prefix: ClientPrefix.V3,
        });
    }

    private async downloadKeysLoop(): Promise<void> {
        if (this.downloadLoopRunning) return;

        // If we have a configuration problem, we don't want to try to download.
        // If any configuration change is detected, we will retry and restart the loop.
        if (this.hasConfigurationProblem) return;

        this.downloadLoopRunning = true;

        while (this.queuedRequests.length > 0) {
            // we just peek the first one without removing it, so if a new request for same key comes in while we're
            // processing this one, it won't queue another request.
            const request = this.queuedRequests[0];
            const result = await this.queryKeyBackup(request.roomId, request.megolmSessionId);
            if (this.stopped) {
                return;
            }
            if (result.ok) {
                // We got the encrypted key from backup, let's try to decrypt and import it.
                try {
                    await this.decryptAndImport(request, result.value);
                } catch (e) {
                    this.logger.error(
                        `Error while decrypting and importing key backup for session ${request.megolmSessionId}`,
                        e,
                    );
                }
                // now remove the request from the queue as we've processed it.
                this.queuedRequests.shift();
            } else {
                this.logger.debug(
                    `Error while downloading key backup for session ${request.megolmSessionId}: ${result.error}`,
                );
                switch (result.error) {
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
                        await sleep(result.retryAfterMs ?? this.backoffDuration);
                        break;
                    }
                    case KeyDownloadError.NETWORK_ERROR: {
                        // We don't want to hammer if there is a problem, so wait a bit.
                        await sleep(this.backoffDuration);
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
        const configuration = await this.getOrCreateBackupConfiguration(false);
        if (!configuration) {
            return { ok: false, error: KeyDownloadError.CONFIGURATION_ERROR };
        }

        this.logger.debug(`Checking key backup for session ${targetSessionId}`);

        try {
            const res = await this.requestRoomKeyFromBackup(configuration.backupVersion, targetRoomId, targetSessionId);
            if (this.stopped) return { ok: false, error: KeyDownloadError.STOPPED };
            this.logger.debug(`<-- Got key from backup ${targetSessionId}`);
            return {
                ok: true,
                value: res,
            };
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
                    // As it's not spec'ed, we fallback on considering the key has not in backup,
                    // notice that this request will be lost if the backup is not configured correctly.
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
                            retryAfterMs: this.backoffDuration,
                        };
                    }
                }
            }
            return { ok: false, error: KeyDownloadError.NETWORK_ERROR };
        }
    }

    private async decryptAndImport(sessionInfo: SessionInfo, data: KeyBackupSession): Promise<void> {
        const configuration = await this.getOrCreateBackupConfiguration(false);

        if (!configuration) {
            throw new Error("Backup: No configuration");
        }

        const sessionsToImport: Record<string, KeyBackupSession> = { [sessionInfo.megolmSessionId]: data };

        const keys = await configuration!.decryptor.decryptSessions(sessionsToImport);
        for (const k of keys) {
            k.room_id = sessionInfo.roomId;
        }
        await this.backupManager.importRoomKeys(keys);
    }

    /**
     * Gets the current backup configuration or create one if it doesn't exist.
     *
     * When a valid configuration is found it is cached and returned for subsequent calls.
     * If a check is forced or a check has not yet been done, a new check is done.
     *
     * @param forceCheck - If true, force a check of the backup configuration.
     *
     * @returns The current backup configuration or null if there is a configuration problem.
     */
    private async getOrCreateBackupConfiguration(forceCheck: boolean): Promise<Configuration | null> {
        if (this.configuration) {
            return this.configuration;
        }

        if (this.hasConfigurationProblem && !forceCheck) {
            return null;
        }

        // This method can be called rapidly by several emitted CryptoEvent, so we need to make sure that we don't
        // query the server several times.
        if (this.currentBackupVersionCheck != null) {
            this.logger.debug(`Already checking server version, use current promise`);
            return await this.currentBackupVersionCheck;
        }

        this.currentBackupVersionCheck = this.internalCheckFromServer();
        try {
            return await this.currentBackupVersionCheck;
        } finally {
            this.currentBackupVersionCheck = null;
        }
    }

    private async internalCheckFromServer(): Promise<Configuration | null> {
        let currentServerVersion = null;
        try {
            currentServerVersion = await this.backupManager.requestKeyBackupVersion();
        } catch (e) {
            this.logger.debug(`Backup: error while checking server version: ${e}`);
            this.hasConfigurationProblem = true;
            return null;
        }
        this.logger.debug(`Got current backup version from server: ${currentServerVersion?.version}`);

        if (currentServerVersion?.algorithm != "m.megolm_backup.v1.curve25519-aes-sha2") {
            this.logger.info(`Unsupported algorithm ${currentServerVersion?.algorithm}`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (!currentServerVersion?.version) {
            this.logger.info(`No current key backup`);
            this.hasConfigurationProblem = true;
            return null;
        }

        const activeVersion = await this.backupManager.getActiveBackupVersion();
        if (activeVersion == null || currentServerVersion.version != activeVersion) {
            // Either the current backup version on server side is not trusted, or it is out of sync with the active version on the client side.
            this.logger.info(
                `The current backup version on the server (${currentServerVersion.version}) is not trusted. Version we are currently backing up to: ${activeVersion}`,
            );
            this.hasConfigurationProblem = true;
            return null;
        }

        const authData = currentServerVersion.auth_data as Curve25519AuthData;

        const backupKeys = await this.getBackupDecryptionKey();
        if (!backupKeys?.decryptionKey) {
            this.logger.debug(`Not checking key backup for session (no decryption key)`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (activeVersion != backupKeys.backupVersion) {
            this.logger.debug(
                `Version for which we have a decryption key (${backupKeys.backupVersion}) doesn't match the version we are backing up to (${activeVersion})`,
            );
            this.hasConfigurationProblem = true;
            return null;
        }

        if (authData.public_key != backupKeys.decryptionKey.megolmV1PublicKey.publicKeyBase64) {
            this.logger.debug(`getBackupDecryptor key mismatch error`);
            this.hasConfigurationProblem = true;
            return null;
        }

        const backupDecryptor = this.backupManager.createBackupDecryptor(backupKeys.decryptionKey);
        this.hasConfigurationProblem = false;
        this.configuration = {
            decryptor: backupDecryptor,
            backupVersion: activeVersion,
        };
        return this.configuration;
    }
}
