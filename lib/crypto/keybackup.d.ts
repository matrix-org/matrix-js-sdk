import { ISigned } from "../@types/signed";
export interface IKeyBackupSession {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: {
        ciphertext: string;
        ephemeral: string;
        mac: string;
        iv: string;
    };
}
export interface IKeyBackupRoomSessions {
    [sessionId: string]: IKeyBackupSession;
}
export interface ICurve25519AuthData {
    public_key: string;
    private_key_salt?: string;
    private_key_iterations?: number;
    private_key_bits?: number;
}
export interface IAes256AuthData {
    iv: string;
    mac: string;
    private_key_salt?: string;
    private_key_iterations?: number;
}
export interface IKeyBackupInfo {
    algorithm: string;
    auth_data: ISigned & (ICurve25519AuthData | IAes256AuthData);
    count?: number;
    etag?: string;
    version?: string;
}
export interface IKeyBackupPrepareOpts {
    secureSecretStorage: boolean;
}
export interface IKeyBackupRestoreResult {
    total: number;
    imported: number;
}
export interface IKeyBackupRestoreOpts {
    cacheCompleteCallback?: () => void;
    progressCallback?: ({ stage: string }: {
        stage: any;
    }) => void;
}
//# sourceMappingURL=keybackup.d.ts.map