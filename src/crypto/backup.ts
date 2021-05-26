/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
 * @module crypto/backup
 *
 * Classes for dealing with key backup.
 */

import {MatrixClient} from "../client";
import {logger} from "../logger";
import {MEGOLM_ALGORITHM, verifySignature} from "./olmlib";
import {DeviceInfo} from "./deviceinfo"
import {DeviceTrustLevel} from './CrossSigning';
import {keyFromPassphrase} from './key_passphrase';
import {sleep} from "../utils";
import {IndexedDBCryptoStore} from './store/indexeddb-crypto-store';
import {encodeRecoveryKey} from './recoverykey';

const KEY_BACKUP_KEYS_PER_REQUEST = 200;

type AuthData = Record<string, any>;

type BackupInfo = {
    algorithm: string,
    auth_data: AuthData, // eslint-disable-line camelcase
    [properties: string]: any,
};

type SigInfo = {
    deviceId: string,
    valid?: boolean | null, // true: valid, false: invalid, null: cannot attempt validation
    device?: DeviceInfo | null,
    crossSigningId?: boolean,
    deviceTrust?: DeviceTrustLevel,
};

type TrustInfo = {
    usable: boolean, // is the backup trusted, true iff there is a sig that is valid & from a trusted device
    sigs: SigInfo[],
};

/** A function used to get the secret key for a backup.
 */
type GetKey = () => Promise<Uint8Array>;

interface BackupAlgorithmClass {
    algorithmName: string;
    // initialize from an existing backup
    init(authData: AuthData, getKey: GetKey): Promise<BackupAlgorithm>;

    // prepare a brand new backup
    prepare(
        key: string | Uint8Array | null,
    ): Promise<[Uint8Array, AuthData]>;
}

interface BackupAlgorithm {
    encryptSession(data: Record<string, any>): Promise<any>;
    decryptSessions(ciphertexts: Record<string, any>): Promise<Record<string, any>[]>;
    authData: AuthData;
    keyMatches(key: Uint8Array): Promise<boolean>;
    free(): void;
}

/**
 * Manages the key backup.
 */
export class BackupManager {
    private algorithm: BackupAlgorithm | undefined;
    private backupInfo: BackupInfo | undefined; // The info dict from /room_keys/version
    public checkedForBackup: boolean; // Have we checked the server for a backup we can use?
    private sendingBackups: boolean; // Are we currently sending backups?
    constructor(private readonly baseApis, readonly getKey: GetKey) {
        this.checkedForBackup = false;
        this.sendingBackups = false;
    }

    get version(): string | undefined {
        return this.backupInfo && this.backupInfo.version;
    }

    static async makeAlgorithm(info: BackupInfo, getKey: GetKey): Promise<BackupAlgorithm> {
        const Algorithm = algorithmsByName[info.algorithm];
        if (!Algorithm) {
            throw new Error("Unknown backup algorithm");
        }
        return await Algorithm.init(info.auth_data, getKey);
    }

    async enableKeyBackup(info: BackupInfo): Promise<void> {
        this.backupInfo = info;
        if (this.algorithm) {
            this.algorithm.free();
        }

        this.algorithm = await BackupManager.makeAlgorithm(info, this.getKey);

        this.baseApis.emit('crypto.keyBackupStatus', true);

        // There may be keys left over from a partially completed backup, so
        // schedule a send to check.
        this.scheduleKeyBackupSend();
    }

    /**
     * Disable backing up of keys.
     */
    disableKeyBackup(): void {
        if (this.algorithm) {
            this.algorithm.free();
        }
        this.algorithm = undefined;

        this.backupInfo = undefined;

        this.baseApis.emit('crypto.keyBackupStatus', false);
    }

    getKeyBackupEnabled(): boolean | null {
        if (!this.checkedForBackup) {
            return null;
        }
        return Boolean(this.algorithm);
    }

    async prepareKeyBackupVersion(
        key?: string | Uint8Array | null,
        algorithm?: string | undefined,
    ): Promise<BackupInfo> {
        const Algorithm = algorithm ? algorithmsByName[algorithm] : DefaultAlgorithm;
        if (!Algorithm) {
            throw new Error("Unknown backup algorithm");
        }

        const [privateKey, authData] = await Algorithm.prepare(key);
        const recoveryKey = encodeRecoveryKey(privateKey);
        return {
            algorithm: Algorithm.algorithmName,
            auth_data: authData,
            recovery_key: recoveryKey,
            privateKey,
        };
    }

    async createKeyBackupVersion(info: BackupInfo): Promise<void> {
        this.algorithm = await BackupManager.makeAlgorithm(info, this.getKey);
    }

    /**
     * Check the server for an active key backup and
     * if one is present and has a valid signature from
     * one of the user's verified devices, start backing up
     * to it.
     */
    async checkAndStart(): Promise<{backupInfo: BackupInfo, trustInfo: TrustInfo}> {
        logger.log("Checking key backup status...");
        if (this.baseApis.isGuest()) {
            logger.log("Skipping key backup check since user is guest");
            this.checkedForBackup = true;
            return null;
        }
        let backupInfo: BackupInfo;
        try {
            backupInfo = await this.baseApis.getKeyBackupVersion();
        } catch (e) {
            logger.log("Error checking for active key backup", e);
            if (e.httpStatus === 404) {
                // 404 is returned when the key backup does not exist, so that
                // counts as successfully checking.
                this.checkedForBackup = true;
            }
            return null;
        }
        this.checkedForBackup = true;

        const trustInfo = await this.isKeyBackupTrusted(backupInfo);

        if (trustInfo.usable && !this.backupInfo) {
            logger.log(
                "Found usable key backup v" + backupInfo.version +
                    ": enabling key backups",
            );
            await this.enableKeyBackup(backupInfo);
        } else if (!trustInfo.usable && this.backupInfo) {
            logger.log("No usable key backup: disabling key backup");
            this.disableKeyBackup();
        } else if (!trustInfo.usable && !this.backupInfo) {
            logger.log("No usable key backup: not enabling key backup");
        } else if (trustInfo.usable && this.backupInfo) {
            // may not be the same version: if not, we should switch
            if (backupInfo.version !== this.backupInfo.version) {
                logger.log(
                    "On backup version " + this.backupInfo.version + " but found " +
                        "version " + backupInfo.version + ": switching.",
                );
                this.disableKeyBackup();
                await this.enableKeyBackup(backupInfo);
                // We're now using a new backup, so schedule all the keys we have to be
                // uploaded to the new backup. This is a bit of a workaround to upload
                // keys to a new backup in *most* cases, but it won't cover all cases
                // because we don't remember what backup version we uploaded keys to:
                // see https://github.com/vector-im/element-web/issues/14833
                await this.scheduleAllGroupSessionsForBackup();
            } else {
                logger.log("Backup version " + backupInfo.version + " still current");
            }
        }

        return {backupInfo, trustInfo};
    }

    /**
     * Forces a re-check of the key backup and enables/disables it
     * as appropriate.
     *
     * @return {Object} Object with backup info (as returned by
     *     getKeyBackupVersion) in backupInfo and
     *     trust information (as returned by isKeyBackupTrusted)
     *     in trustInfo.
     */
    async checkKeyBackup(): Promise<{backupInfo: BackupInfo, trustInfo: TrustInfo}> {
        this.checkedForBackup = false;
        return this.checkAndStart();
    }

    /**
     * @param {object} backupInfo key backup info dict from /room_keys/version
     * @return {object} {
     *     usable: [bool], // is the backup trusted, true iff there is a sig that is valid & from a trusted device
     *     sigs: [
     *         valid: [bool || null], // true: valid, false: invalid, null: cannot attempt validation
     *         deviceId: [string],
     *         device: [DeviceInfo || null],
     *     ]
     * }
     */
    async isKeyBackupTrusted(backupInfo: BackupInfo): Promise<TrustInfo> {
        const ret = {
            usable: false,
            trusted_locally: false,
            sigs: [],
        };

        if (
            !backupInfo ||
                !backupInfo.algorithm ||
                !backupInfo.auth_data ||
                !backupInfo.auth_data.public_key ||
                !backupInfo.auth_data.signatures
        ) {
            logger.info("Key backup is absent or missing required data");
            return ret;
        }

        const trustedPubkey = this.baseApis._crypto._sessionStore.getLocalTrustedBackupPubKey();

        if (backupInfo.auth_data.public_key === trustedPubkey) {
            logger.info("Backup public key " + trustedPubkey + " is trusted locally");
            ret.trusted_locally = true;
        }

        const mySigs = backupInfo.auth_data.signatures[this.baseApis.getUserId()] || [];

        for (const keyId of Object.keys(mySigs)) {
            const keyIdParts = keyId.split(':');
            if (keyIdParts[0] !== 'ed25519') {
                logger.log("Ignoring unknown signature type: " + keyIdParts[0]);
                continue;
            }
            // Could be a cross-signing master key, but just say this is the device
            // ID for backwards compat
            const sigInfo: SigInfo = { deviceId: keyIdParts[1] };

            // first check to see if it's from our cross-signing key
            const crossSigningId = this.baseApis._crypto._crossSigningInfo.getId();
            if (crossSigningId === sigInfo.deviceId) {
                sigInfo.crossSigningId = true;
                try {
                    await verifySignature(
                        this.baseApis._crypto._olmDevice,
                        backupInfo.auth_data,
                        this.baseApis.getUserId(),
                        sigInfo.deviceId,
                        crossSigningId,
                    );
                    sigInfo.valid = true;
                } catch (e) {
                    logger.warn(
                        "Bad signature from cross signing key " + crossSigningId, e,
                    );
                    sigInfo.valid = false;
                }
                ret.sigs.push(sigInfo);
                continue;
            }

            // Now look for a sig from a device
            // At some point this can probably go away and we'll just support
            // it being signed by the cross-signing master key
            const device = this.baseApis._crypto._deviceList.getStoredDevice(
                this.baseApis.getUserId(), sigInfo.deviceId,
            );
            if (device) {
                sigInfo.device = device;
                sigInfo.deviceTrust = await this.baseApis.checkDeviceTrust(
                    this.baseApis.getUserId(), sigInfo.deviceId,
                );
                try {
                    await verifySignature(
                        this.baseApis._crypto._olmDevice,
                        backupInfo.auth_data,
                        this.baseApis.getUserId(),
                        device.deviceId,
                        device.getFingerprint(),
                    );
                    sigInfo.valid = true;
                } catch (e) {
                    logger.info(
                        "Bad signature from key ID " + keyId + " userID " + this.baseApis.getUserId() +
                            " device ID " + device.deviceId + " fingerprint: " +
                            device.getFingerprint(), backupInfo.auth_data, e,
                    );
                    sigInfo.valid = false;
                }
            } else {
                sigInfo.valid = null; // Can't determine validity because we don't have the signing device
                logger.info("Ignoring signature from unknown key " + keyId);
            }
            ret.sigs.push(sigInfo);
        }

        ret.usable = ret.sigs.some((s) => {
            return (
                s.valid && (
                    (s.device && s.deviceTrust.isVerified()) ||
                        (s.crossSigningId)
                )
            );
        });
        ret.usable ||= ret.trusted_locally;
        return ret;
    }

    /**
     * Schedules sending all keys waiting to be sent to the backup, if not already
     * scheduled. Retries if necessary.
     *
     * @param maxDelay Maximum delay to wait in ms. 0 means no delay.
     */
    async scheduleKeyBackupSend(maxDelay = 10000): Promise<void> {
        if (this.sendingBackups) return;

        this.sendingBackups = true;

        try {
            // wait between 0 and `maxDelay` seconds, to avoid backup
            // requests from different clients hitting the server all at
            // the same time when a new key is sent
            const delay = Math.random() * maxDelay;
            await sleep(delay, undefined);
            let numFailures = 0; // number of consecutive failures
            for (;;) {
                if (!this.algorithm) {
                    return;
                }
                try {
                    const numBackedUp =
                        await this.backupPendingKeys(KEY_BACKUP_KEYS_PER_REQUEST);
                    if (numBackedUp === 0) {
                        // no sessions left needing backup: we're done
                        return;
                    }
                    numFailures = 0;
                } catch (err) {
                    numFailures++;
                    logger.log("Key backup request failed", err);
                    if (err.data) {
                        if (
                            err.data.errcode == 'M_NOT_FOUND' ||
                                err.data.errcode == 'M_WRONG_ROOM_KEYS_VERSION'
                        ) {
                            // Re-check key backup status on error, so we can be
                            // sure to present the current situation when asked.
                            await this.checkKeyBackup();
                            // Backup version has changed or this backup version
                            // has been deleted
                            this.baseApis._crypto.emit("crypto.keyBackupFailed", err.data.errcode);
                            throw err;
                        }
                    }
                }
                if (numFailures) {
                    // exponential backoff if we have failures
                    await sleep(1000 * Math.pow(2, Math.min(numFailures - 1, 4)), undefined);
                }
            }
        } finally {
            this.sendingBackups = false;
        }
    }

    /**
     * Take some e2e keys waiting to be backed up and send them
     * to the backup.
     *
     * @param {integer} limit Maximum number of keys to back up
     * @returns {integer} Number of sessions backed up
     */
    private async backupPendingKeys(limit: number): Promise<number> {
        const sessions = await this.baseApis._crypto._cryptoStore.getSessionsNeedingBackup(limit);
        if (!sessions.length) {
            return 0;
        }

        let remaining = await this.baseApis._crypto._cryptoStore.countSessionsNeedingBackup();
        this.baseApis._crypto.emit("crypto.keyBackupSessionsRemaining", remaining);

        const data = {};
        for (const session of sessions) {
            const roomId = session.sessionData.room_id;
            if (data[roomId] === undefined) {
                data[roomId] = {sessions: {}};
            }

            const sessionData = await this.baseApis._crypto._olmDevice.exportInboundGroupSession(
                session.senderKey, session.sessionId, session.sessionData,
            );
            sessionData.algorithm = MEGOLM_ALGORITHM;

            const forwardedCount =
                (sessionData.forwarding_curve25519_key_chain || []).length;

            const userId = this.baseApis._crypto._deviceList.getUserByIdentityKey(
                MEGOLM_ALGORITHM, session.senderKey,
            );
            const device = this.baseApis._crypto._deviceList.getDeviceByIdentityKey(
                MEGOLM_ALGORITHM, session.senderKey,
            );
            const verified = this.baseApis._crypto._checkDeviceInfoTrust(userId, device).isVerified();

            data[roomId]['sessions'][session.sessionId] = {
                first_message_index: sessionData.first_known_index,
                forwarded_count: forwardedCount,
                is_verified: verified,
                session_data: await this.algorithm.encryptSession(sessionData),
            };
        }

        await this.baseApis.sendKeyBackup(
            undefined, undefined, this.backupInfo.version,
            {rooms: data},
        );

        await this.baseApis._crypto._cryptoStore.unmarkSessionsNeedingBackup(sessions);
        remaining = await this.baseApis._crypto._cryptoStore.countSessionsNeedingBackup();
        this.baseApis._crypto.emit("crypto.keyBackupSessionsRemaining", remaining);

        return sessions.length;
    }

    async backupGroupSession(
        senderKey: string, sessionId: string,
    ): Promise<void> {
        await this.baseApis._crypto._cryptoStore.markSessionsNeedingBackup([{
            senderKey: senderKey,
            sessionId: sessionId,
        }]);

        if (this.backupInfo) {
            // don't wait for this to complete: it will delay so
            // happens in the background
            this.scheduleKeyBackupSend();
        }
        // if this.backupInfo is not set, then the keys will be backed up when
        // this.enableKeyBackup is called
    }

    /**
     * Marks all group sessions as needing to be backed up and schedules them to
     * upload in the background as soon as possible.
     */
    async scheduleAllGroupSessionsForBackup(): Promise<void> {
        await this.flagAllGroupSessionsForBackup();

        // Schedule keys to upload in the background as soon as possible.
        this.scheduleKeyBackupSend(0 /* maxDelay */);
    }

    /**
     * Marks all group sessions as needing to be backed up without scheduling
     * them to upload in the background.
     * @returns {Promise<int>} Resolves to the number of sessions now requiring a backup
     *     (which will be equal to the number of sessions in the store).
     */
    async flagAllGroupSessionsForBackup(): Promise<number> {
        await this.baseApis._crypto._cryptoStore.doTxn(
            'readwrite',
            [
                IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS,
                IndexedDBCryptoStore.STORE_BACKUP,
            ],
            (txn) => {
                this.baseApis._crypto._cryptoStore.getAllEndToEndInboundGroupSessions(txn, (session) => {
                    if (session !== null) {
                        this.baseApis._crypto._cryptoStore.markSessionsNeedingBackup([session], txn);
                    }
                });
            },
        );

        const remaining = await this.baseApis._crypto._cryptoStore.countSessionsNeedingBackup();
        this.baseApis.emit("crypto.keyBackupSessionsRemaining", remaining);
        return remaining;
    }

    /**
     * Counts the number of end to end session keys that are waiting to be backed up
     * @returns {Promise<int>} Resolves to the number of sessions requiring backup
     */
    countSessionsNeedingBackup(): Promise<number> {
        return this.baseApis._crypto._cryptoStore.countSessionsNeedingBackup();
    }
}

export class Curve25519 implements BackupAlgorithm {
    static algorithmName = "m.megolm_backup.v1.curve25519-aes-sha2";

    constructor(
        public authData: AuthData,
        private publicKey: any, // FIXME: PkEncryption
        private getKey: () => Promise<Uint8Array>,
    ) {}

    static async init(
        authData: AuthData,
        getKey: () => Promise<Uint8Array>,
    ): Promise<Curve25519> {
        if (!authData || !authData.public_key) {
            throw new Error("auth_data missing required information");
        }
        const publicKey = new global.Olm.PkEncryption();
        publicKey.set_recipient_key(authData.public_key);
        return new Curve25519(authData, publicKey, getKey);
    }

    static async prepare(
        key: string | Uint8Array | null,
    ): Promise<[Uint8Array, AuthData]> {
        const decryption = new global.Olm.PkDecryption();
        try {
            const authData: AuthData = {};
            if (!key) {
                authData.public_key = decryption.generate_key();
            } else if (key instanceof Uint8Array) {
                authData.public_key = decryption.init_with_private_key(key);
            } else {
                const derivation = await keyFromPassphrase(key);
                authData.private_key_salt = derivation.salt;
                authData.private_key_iterations = derivation.iterations;
                // FIXME: algorithm?
                authData.public_key = decryption.init_with_private_key(derivation.key);
            }
            const publicKey = new global.Olm.PkEncryption();
            publicKey.set_recipient_key(authData.public_key);

            return [
                decryption.get_private_key(),
                authData,
            ]
        } finally {
            decryption.free();
        }
    }

    async encryptSession(data: Record<string, any>): Promise<any> {
        const plainText: Record<string, any> = Object.assign({}, data);
        delete plainText.session_id;
        delete plainText.room_id;
        delete plainText.first_known_index;
        return this.publicKey.encrypt(JSON.stringify(plainText));
    }

    async decryptSessions(sessions: Record<string, Record<string, any>>): Promise<Record<string, any>[]> {
        const privKey = await this.getKey();
        const decryption = new global.Olm.PkDecryption();
        try {
            const backupPubKey = decryption.init_with_private_key(privKey);

            if (backupPubKey !== this.authData.public_key) {
                // eslint-disable-next-line no-throw-literal
                throw {errcode: MatrixClient.RESTORE_BACKUP_ERROR_BAD_KEY};
            }

            const keys = [];

            for (const [sessionId, sessionData] of Object.entries(sessions)) {
                try {
                    const decrypted = JSON.parse(decryption.decrypt(
                        sessionData.session_data.ephemeral,
                        sessionData.session_data.mac,
                        sessionData.session_data.ciphertext,
                    ));
                    decrypted.session_id = sessionId;
                    keys.push(decrypted);
                } catch (e) {
                    logger.log("Failed to decrypt megolm session from backup", e, sessionData);
                }
            }
            return keys;
        } finally {
            decryption.free();
        }
    }

    async keyMatches(key: Uint8Array): Promise<boolean> {
        const decryption = new global.Olm.PkDecryption();
        let pubKey;
        try {
            pubKey = decryption.init_with_private_key(key);
        } finally {
            decryption.free();
        }

        return pubKey === this.authData.public_key;
    }

    free(): void {
        this.publicKey.free();
    }
}

export const algorithmsByName: Record<string, BackupAlgorithmClass> = {
    [Curve25519.algorithmName]: Curve25519,
};

export const DefaultAlgorithm: BackupAlgorithmClass = Curve25519;
