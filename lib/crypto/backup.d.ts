/**
 * @module crypto/backup
 *
 * Classes for dealing with key backup.
 */
import { MatrixClient } from "../client";
import { DeviceInfo } from "./deviceinfo";
import { DeviceTrustLevel } from './CrossSigning';
import { ICurve25519AuthData, IAes256AuthData, IKeyBackupInfo, IKeyBackupSession } from "./keybackup";
declare type AuthData = IKeyBackupInfo["auth_data"];
declare type SigInfo = {
    deviceId: string;
    valid?: boolean | null;
    device?: DeviceInfo | null;
    crossSigningId?: boolean;
    deviceTrust?: DeviceTrustLevel;
};
export declare type TrustInfo = {
    usable: boolean;
    sigs: SigInfo[];
    trusted_locally?: boolean;
};
export interface IKeyBackupCheck {
    backupInfo: IKeyBackupInfo;
    trustInfo: TrustInfo;
}
export interface IPreparedKeyBackupVersion {
    algorithm: string;
    auth_data: AuthData;
    recovery_key: string;
    privateKey: Uint8Array;
}
/** A function used to get the secret key for a backup.
 */
declare type GetKey = () => Promise<ArrayLike<number>>;
interface BackupAlgorithmClass {
    algorithmName: string;
    init(authData: AuthData, getKey: GetKey): Promise<BackupAlgorithm>;
    prepare(key: string | Uint8Array | null): Promise<[Uint8Array, AuthData]>;
    checkBackupVersion(info: IKeyBackupInfo): void;
}
interface BackupAlgorithm {
    untrusted: boolean;
    encryptSession(data: Record<string, any>): Promise<any>;
    decryptSessions(ciphertexts: Record<string, IKeyBackupSession>): Promise<Record<string, any>[]>;
    authData: AuthData;
    keyMatches(key: ArrayLike<number>): Promise<boolean>;
    free(): void;
}
export interface IKeyBackup {
    rooms: {
        [roomId: string]: {
            sessions: {
                [sessionId: string]: IKeyBackupSession;
            };
        };
    };
}
/**
 * Manages the key backup.
 */
export declare class BackupManager {
    private readonly baseApis;
    readonly getKey: GetKey;
    private algorithm;
    backupInfo: IKeyBackupInfo | undefined;
    checkedForBackup: boolean;
    private sendingBackups;
    constructor(baseApis: MatrixClient, getKey: GetKey);
    get version(): string | undefined;
    /**
     * Performs a quick check to ensure that the backup info looks sane.
     *
     * Throws an error if a problem is detected.
     *
     * @param {IKeyBackupInfo} info the key backup info
     */
    static checkBackupVersion(info: IKeyBackupInfo): void;
    static makeAlgorithm(info: IKeyBackupInfo, getKey: GetKey): Promise<BackupAlgorithm>;
    enableKeyBackup(info: IKeyBackupInfo): Promise<void>;
    /**
     * Disable backing up of keys.
     */
    disableKeyBackup(): void;
    getKeyBackupEnabled(): boolean | null;
    prepareKeyBackupVersion(key?: string | Uint8Array | null, algorithm?: string | undefined): Promise<IPreparedKeyBackupVersion>;
    createKeyBackupVersion(info: IKeyBackupInfo): Promise<void>;
    /**
     * Check the server for an active key backup and
     * if one is present and has a valid signature from
     * one of the user's verified devices, start backing up
     * to it.
     */
    checkAndStart(): Promise<IKeyBackupCheck>;
    /**
     * Forces a re-check of the key backup and enables/disables it
     * as appropriate.
     *
     * @return {Object} Object with backup info (as returned by
     *     getKeyBackupVersion) in backupInfo and
     *     trust information (as returned by isKeyBackupTrusted)
     *     in trustInfo.
     */
    checkKeyBackup(): Promise<IKeyBackupCheck>;
    /**
     * Check if the given backup info is trusted.
     *
     * @param {IKeyBackupInfo} backupInfo key backup info dict from /room_keys/version
     * @return {object} {
     *     usable: [bool], // is the backup trusted, true iff there is a sig that is valid & from a trusted device
     *     sigs: [
     *         valid: [bool || null], // true: valid, false: invalid, null: cannot attempt validation
     *         deviceId: [string],
     *         device: [DeviceInfo || null],
     *     ]
     * }
     */
    isKeyBackupTrusted(backupInfo: IKeyBackupInfo): Promise<TrustInfo>;
    /**
     * Schedules sending all keys waiting to be sent to the backup, if not already
     * scheduled. Retries if necessary.
     *
     * @param maxDelay Maximum delay to wait in ms. 0 means no delay.
     */
    scheduleKeyBackupSend(maxDelay?: number): Promise<void>;
    /**
     * Take some e2e keys waiting to be backed up and send them
     * to the backup.
     *
     * @param {integer} limit Maximum number of keys to back up
     * @returns {integer} Number of sessions backed up
     */
    private backupPendingKeys;
    backupGroupSession(senderKey: string, sessionId: string): Promise<void>;
    /**
     * Marks all group sessions as needing to be backed up and schedules them to
     * upload in the background as soon as possible.
     */
    scheduleAllGroupSessionsForBackup(): Promise<void>;
    /**
     * Marks all group sessions as needing to be backed up without scheduling
     * them to upload in the background.
     * @returns {Promise<int>} Resolves to the number of sessions now requiring a backup
     *     (which will be equal to the number of sessions in the store).
     */
    flagAllGroupSessionsForBackup(): Promise<number>;
    /**
     * Counts the number of end to end session keys that are waiting to be backed up
     * @returns {Promise<int>} Resolves to the number of sessions requiring backup
     */
    countSessionsNeedingBackup(): Promise<number>;
}
export declare class Curve25519 implements BackupAlgorithm {
    authData: ICurve25519AuthData;
    private publicKey;
    private getKey;
    static algorithmName: string;
    constructor(authData: ICurve25519AuthData, publicKey: any, // FIXME: PkEncryption
    getKey: () => Promise<Uint8Array>);
    static init(authData: AuthData, getKey: () => Promise<Uint8Array>): Promise<Curve25519>;
    static prepare(key: string | Uint8Array | null): Promise<[Uint8Array, AuthData]>;
    static checkBackupVersion(info: IKeyBackupInfo): void;
    get untrusted(): boolean;
    encryptSession(data: Record<string, any>): Promise<any>;
    decryptSessions(sessions: Record<string, IKeyBackupSession>): Promise<Record<string, any>[]>;
    keyMatches(key: Uint8Array): Promise<boolean>;
    free(): void;
}
export declare class Aes256 implements BackupAlgorithm {
    readonly authData: IAes256AuthData;
    private readonly key;
    static algorithmName: "org.matrix.msc3270.v1.aes-hmac-sha2";
    constructor(authData: IAes256AuthData, key: Uint8Array);
    static init(authData: IAes256AuthData, getKey: () => Promise<Uint8Array>): Promise<Aes256>;
    static prepare(key: string | Uint8Array | null): Promise<[Uint8Array, AuthData]>;
    static checkBackupVersion(info: IKeyBackupInfo): void;
    get untrusted(): boolean;
    encryptSession(data: Record<string, any>): Promise<any>;
    decryptSessions(sessions: Record<string, IKeyBackupSession>): Promise<Record<string, any>[]>;
    keyMatches(key: Uint8Array): Promise<boolean>;
    free(): void;
}
export declare const algorithmsByName: Record<string, BackupAlgorithmClass>;
export declare const DefaultAlgorithm: BackupAlgorithmClass;
export {};
//# sourceMappingURL=backup.d.ts.map