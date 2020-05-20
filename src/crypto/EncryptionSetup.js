import {MatrixEvent} from "../models/event";
import {EventEmitter} from "events";
import {createCryptoStoreCacheCallbacks} from "./CrossSigning";
import {IndexedDBCryptoStore} from './store/indexeddb-crypto-store';
import {
    PREFIX_UNSTABLE,
} from "../http-api";

class AccountDataClientAdapter extends EventEmitter {
    constructor() {
        super();
        this._values = new Map();
    }

    getAccountDataFromServer(type) {
        return Promise.resolve(this._values.get(type) || null);
    }

    setAccountData(type, content) {
        this._values.set(type, content);
        Promise.resolve().then(() => {
            const event = new MatrixEvent({type, content});
            this.emit("accountData", event);
        });
    }
}

// implements both cache callbacks as non-cache callbacks
class CrossSigningCallbacks {
    constructor() {
        this.privateKeys = new Map();
    }

    // cache callbacks
    getCrossSigningKeyCache(type, expectedPublicKey) {
        return this.getCrossSigningKey(type, expectedPublicKey);
    }

    storeCrossSigningKeyCache(type, key) {
        this.privateKeys.set(type, key);
        return Promise.resolve();
    }

    // non-cache callbacks
    getCrossSigningKey(type, _expectedPubkey) {
        return Promise.resolve(this.privateKeys.get(type));
    }

    saveCrossSigningKeys(privateKeys) {
        for (const [type, privateKey] of Object.entries(privateKeys)) {
            this.privateKeys.set(type, privateKey);
        }
    }
}

class SSSSCryptoCallbacks {
    constructor() {
        this._privateKeys = new Map();
    }

    getSecretStorageKey({ keys }, name) {
        for (const keyId of Object.keys(keys)) {
            const privateKey = this._privateKeys.get(keyId);
            if (privateKey) {
                return [keyId, privateKey];
            }
        }
    }

    addPrivateKey(keyId, privKey) {
        this._privateKeys.set(keyId, privKey);
    }
}

export class EncryptionSetupBuilder {
    constructor() {
        // TODO: do we need to put in the previous 4S account data as well? so we can detect colliding id's?
        this.accountDataClientAdapter = new AccountDataClientAdapter();
        this.crossSigningCallbacks = new CrossSigningCallbacks();
        this.ssssCryptoCallbacks = new SSSSCryptoCallbacks();

        this._crossSigningKeys = null;
        this._keySignatures = null;
        this._keyBackupInfo = null;
    }

    addCrossSigningKeys(auth, keys) {
        this._crossSigningKeys = {auth, keys};
    }

    addSessionBackup(keyBackupInfo) {
        this._keyBackupInfo = keyBackupInfo;
    }

    addSessionBackupPrivateKeyToCache(privateKey) {
        this._sessionBackupPrivateKey = privateKey;
    }

    addKeySignature(userId, deviceId, signature) {
        if (!this._keySignatures) {
            this._keySignatures = {};
        }
        const userSignatures = this._keySignatures[userId] || {};
        this._keySignatures[userId] = userSignatures;
        userSignatures[deviceId] = signature;
    }

    buildOperation() {
        const accountData = this.accountDataClientAdapter._values;
        return new EncryptionSetupOperation(
            accountData,
            this._crossSigningKeys,
            this._keyBackupInfo,
            this._keySignatures,
        );
    }

    async persist(crypto) {
        // store self_signing and user_signing private key in cache
        const cacheCallbacks = createCryptoStoreCacheCallbacks(crypto._cryptoStore);
        for (const type of ["self_signing", "user_signing"]) {
            // logger.log(`Cache ${type} cross-signing private key locally`);
            const privateKey = this.crossSigningCallbacks.privateKeys.get(type);
            await cacheCallbacks.storeCrossSigningKeyCache(type, privateKey);
        }
        // store session backup key in cache
        if (this._sessionBackupPrivateKey) {
            await crypto.storeSessionBackupPrivateKey(this._sessionBackupPrivateKey);
        }
        // store own cross-sign pubkeys as trusted
        await crypto._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                console.log("EncryptionSetup: storing public keys as trusted locally", this._crossSigningKeys);
                crypto._cryptoStore.storeCrossSigningKeys(
                    txn, this._crossSigningKeys.keys);
            },
        );
    }
}

// this will be restored from idb in a future PR for retrying,
// it does not have knowledge of any private keys, unlike the builder.
export class EncryptionSetupOperation {
    constructor(accountData, crossSigningKeys, keyBackupInfo, keySignatures) {
        this._accountData = accountData;
        this._crossSigningKeys = crossSigningKeys;
        this._keyBackupInfo = keyBackupInfo;
        this._keySignatures = keySignatures;
    }

    hasAnythingToDo() {
        if (this._accountData.size > 0) {
            return true;
        }
        if (this._crossSigningKeys) {
            return true;
        }
        if (this._keyBackupInfo) {
            return true;
        }
        if (this._keySignatures) {
            return true;
        }
        return false;
    }

    async apply(crypto) {
        const baseApis = crypto._baseApis;
        // set account data
        // (convert from Map to object for logging)
        const adData = Array.from(this._accountData.entries()).
            reduce((obj, [key, value]) => {
                obj[key] = value;
                return obj;
            }, {});
        console.log("EncryptionSetup: apply account data", adData);
        for (const [type, content] of this._accountData) {
            await baseApis.setAccountData(type, content);
        }
        // upload cross-signing keys
        console.log("EncryptionSetup: uploading keys", this._crossSigningKeys);
        if (this._crossSigningKeys) {
            const keys = {};
            for (const [name, key] of Object.entries(this._crossSigningKeys.keys)) {
                keys[name + "_key"] = key;
            }
            await baseApis.uploadDeviceSigningKeys(
                this._crossSigningKeys.auth,
                keys,
            );
            // pass the new keys to the main instance of our own CrossSigningInfo.
            crypto._crossSigningInfo.setKeys(this._crossSigningKeys.keys);
        }
        // upload first cross-signing signatures with the new key
        // (e.g. signing our own device)
        if (this._keySignatures) {
            await baseApis.uploadKeySignatures(this._keySignatures);
        }
        // session backup signature
        // The backup is trusted because the user provided the private key.
        // Sign the backup with the cross signing key so the key backup can
        // be trusted via cross-signing.
        //
        console.log("EncryptionSetup: key backup", this._keyBackupInfo);
        if (this._keyBackupInfo.version) {
            // update signatures on key backup
            await baseApis._http.authedRequest(
                undefined, "PUT", "/room_keys/version/" + this._keyBackupInfo.version,
                undefined, {
                    algorithm: this._keyBackupInfo.algorithm,
                    auth_data: this._keyBackupInfo.auth_data,
                },
                {prefix: PREFIX_UNSTABLE},
            );
        } else {
            // add new key backup
            await baseApis._http.authedRequest(
                undefined, "POST", "/room_keys/version", undefined, this._keyBackupInfo,
                {prefix: PREFIX_UNSTABLE},
            );
        }
    }
}
