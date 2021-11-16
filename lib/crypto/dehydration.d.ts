import { ISecretStorageKeyInfo } from "./api";
import { Crypto } from "./index";
declare type Signatures = Record<string, Record<string, string>>;
export interface IDehydratedDevice {
    device_id: string;
    device_data: ISecretStorageKeyInfo & {
        algorithm: string;
        account: string;
    };
}
export interface IDehydratedDeviceKeyInfo {
    passphrase?: string;
}
export interface IDeviceKeys {
    algorithms: Array<string>;
    device_id: string;
    user_id: string;
    keys: Record<string, string>;
    signatures?: Signatures;
}
export interface IOneTimeKey {
    key: string;
    fallback?: boolean;
    signatures?: Signatures;
}
export declare const DEHYDRATION_ALGORITHM = "org.matrix.msc2697.v1.olm.libolm_pickle";
export declare class DehydrationManager {
    private readonly crypto;
    private inProgress;
    private timeoutId;
    private key;
    private keyInfo;
    private deviceDisplayName;
    constructor(crypto: Crypto);
    getDehydrationKeyFromCache(): Promise<void>;
    /** set the key, and queue periodic dehydration to the server in the background */
    setKeyAndQueueDehydration(key: Uint8Array, keyInfo?: {
        [props: string]: any;
    }, deviceDisplayName?: string): Promise<void>;
    setKey(key: Uint8Array, keyInfo?: {
        [props: string]: any;
    }, deviceDisplayName?: string): Promise<boolean>;
    /** returns the device id of the newly created dehydrated device */
    dehydrateDevice(): Promise<string>;
    stop(): void;
}
export {};
//# sourceMappingURL=dehydration.d.ts.map