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
import { RustBackupCryptoEventMap, RustBackupCryptoEvents, RustBackupDecryptor, RustBackupManager } from "./backup";
import { CryptoEvent, TypedEventEmitter } from "../matrix";
import { encodeUri, sleep } from "../utils";

/**
 * Enumerates the different kind of errors that can occurs when downloading and importing a key from backup.
 */
export enum KeyDownloadError {
    /** The backup version in use is out of sync with the server version. */
    VERSION_MISMATCH = "VERSION_MISMATCH",
    /** The requested key is not in the backup. */
    MISSING_DECRYPTION_KEY = "MISSING_DECRYPTION_KEY",
    /** A network error occurred while trying to get the key. */
    NETWORK_ERROR = "NETWORK_ERROR",
    /** The loop as been stopped. */
    STOPPED = "STOPPED",
    /** An unknown error occurred while decrypting/importing the key */
    UNKNOWN_ERROR = "UNKNOWN_ERROR",
    /** The server is rate limiting us. */
    RATE_LIMITED = "RATE_LIMITED",
    /** The backup is not configured correctly, can be that there is no backup, that it's not trusted
     * , that we don't have the correct key in cache... */
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
}

/** Helper type for requested session*/
type SessionInfo = { roomId: string; megolmSessionId: string };

/** Helper type for the result of a key download. */
type KeyDownloadResult =
    | { ok: true; value: KeyBackupSession }
    | { ok: false; error: KeyDownloadError; [key: string]: any };

/** Holds the current backup decryptor and version that should be used. */
type Configuration = {
    backupVersion: string;
    decryptor: RustBackupDecryptor;
};

/**
 * Signaling for the Downloader loop.
 * Not yet used by API, yet useful for testing.
 */
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
 * This function is called when an 'unable to decrypt' error occurs. It attempts to download the key from the backup.
 *
 * The current backup API lacks pagination, which can lead to lengthy key retrieval times for large histories (several 10s of minutes).
 * To mitigate this, keys are downloaded on demand as decryption errors occurs.
 * While this approach may result in numerous requests, it improves user experience by reducing wait times for message decryption.
 *
 * The PerSessionKeyBackupDownloader is resistant to backup configuration changes, it will automatically resume querying when
 * the backup is configured correctly.
 *
 */
export class PerSessionKeyBackupDownloader extends TypedEventEmitter<KeyDownloaderEvent, KeyDownloaderEventMap> {
    private stopped = false;

    private configuration: Configuration | null = null;

    /** We remember when a session was requested and not found in backup to avoid query again too soon. */
    private sessionLastCheckAttemptedTime: Record<string, number> = {};

    private readonly configurationChangeHandler = (): void => {
        this.onBackupStatusChanged();
    };

    private readonly logger: Logger;

    /**
     * Creates a new instance of PerSessionKeyBackupDownloader.
     *
     * @param backupManager - The backup manager to use.
     * @param olmMachine - The olm machine to use.
     * @param http - The http instance to use.
     * @param cryptoEventEmitter - The crypto event emitter to use.
     * @param logger - The logger to use.
     * @param maxTimeBetweenRetry - The maximum time to wait between two retries. This is to avoid hammering the server.
     *
     */
    public constructor(
        private readonly backupManager: RustBackupManager,
        private readonly olmMachine: OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly cryptoEventEmitter: TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>,
        logger: Logger,
        private readonly maxTimeBetweenRetry: number,
    ) {
        super();

        this.logger = logger.getChild("[PerSessionKeyBackupDownloader]");

        cryptoEventEmitter.on(CryptoEvent.KeyBackupStatus, this.configurationChangeHandler);
        cryptoEventEmitter.on(CryptoEvent.KeyBackupFailed, this.configurationChangeHandler);
        cryptoEventEmitter.on(CryptoEvent.KeyBackupDecryptionKeyCached, this.configurationChangeHandler);
    }

    public stop(): void {
        this.stopped = true;
        this.cryptoEventEmitter.off(CryptoEvent.KeyBackupStatus, this.configurationChangeHandler);
        this.cryptoEventEmitter.off(CryptoEvent.KeyBackupFailed, this.configurationChangeHandler);
        this.cryptoEventEmitter.off(CryptoEvent.KeyBackupDecryptionKeyCached, this.configurationChangeHandler);
    }

    private onBackupStatusChanged(): void {
        this.logger.info(`Key backup status change => check configuration`);
        // we want to check configuration
        this.hasConfigurationProblem = false;
        this.configuration = null;
        this.getOrCreateBackupDecryptor(true).then((decryptor) => {
            if (decryptor) {
                this.downloadKeysLoop();
            } else {
                this.emit(KeyDownloaderEvent.QueryKeyError, KeyDownloadError.CONFIGURATION_ERROR);
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

    private async getBackupDecryptionKey(): Promise<RustSdkCryptoJs.BackupKeys | null> {
        try {
            return await this.olmMachine.getBackupKeys();
        } catch (e) {
            return null;
        }
    }

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

        this.logger.debug(`--> Checking key backup for session ${targetSessionId}`);

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
                    // As it's not spec'ed, will work only with synapse, but it's better than nothing?
                    // Other implementations will consider this as a missing key, but soon after a backup status
                    // change will trigger a configuration check for future keys (this one won't be retied though)
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
    }

    private currentBackupVersionCheck: Promise<Configuration | null> | null = null;

    private async getOrCreateBackupDecryptor(forceCheck: boolean): Promise<Configuration | null> {
        if (this.configuration) {
            return this.configuration;
        }

        if (this.hasConfigurationProblem && !forceCheck) {
            return null;
        }

        // This method can be called rapidly by several emitted CryptoEvent, so we need to make sure that we don't
        // query the server several times.
        if (this.currentBackupVersionCheck != null) {
            this.logger.debug(`Backup: already checking server version, use current promise`);
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
        this.logger.debug(`Got current version from server:${currentServerVersion?.version}`);

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

        const activeVersion = await this.backupManager.getActiveBackupVersion();
        if (activeVersion == null || currentServerVersion.version != activeVersion) {
            // case when the server side current version is not trusted or is out of sync with the client side active version.
            this.logger.info(
                `The current backup version ${currentServerVersion.version} is not trusted. Active version=${activeVersion}`,
            );
            this.hasConfigurationProblem = true;
            return null;
        }

        const authData = <Curve25519AuthData>currentServerVersion.auth_data;

        const backupKeys = await this.getBackupDecryptionKey();
        if (!backupKeys?.decryptionKey) {
            this.logger.debug(`Not checking key backup for session(no decryption key)`);
            this.hasConfigurationProblem = true;
            return null;
        }

        if (activeVersion != backupKeys.backupVersion) {
            this.logger.debug(
                `Cached key version <${backupKeys.backupVersion}> doesn't match active backup version <${activeVersion}>`,
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
        await this.backupManager.importRoomKeys(keys);
    }
}
