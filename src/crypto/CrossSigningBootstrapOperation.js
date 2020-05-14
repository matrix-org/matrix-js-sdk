import {MatrixEvent} from "../models/event";
import {EventEmitter} from "events";

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
            if (this._privateKeys[keyId]) {
                return [keyId, this._privateKeys[keyId]];
            }
        }
    }

    addPrivateKey(keyId, privKey) {
        this._privateKeys.set(keyId, privKey);
    }
}

export default class CrossSigningBootstrapOperation {
    constructor() {
        // do we need to put in the previous 4S account data as well? so we can detect colliding id's?
        this.accountDataClientAdapter = new AccountDataClientAdapter();
        this.crossSigningCallbacks = new CrossSigningCallbacks();
        this.ssssCryptoCallbacks = new SSSSCryptoCallbacks();

        this._publishKeys = null;
        this._sessionBackupSignature = null;
    }

    addCrossSigningKeys(auth, keys) {
        this._publishKeys = {auth, keys};
    }

    addSessionBackupSignature(keyBackupInfo) {
        this._sessionBackupSignature = {
            version: keyBackupInfo.version,
            signatures: keyBackupInfo.auth_data.signatures,
        };
    }

    async run(baseApis, cryptoStore) {
        // set account data
        const accountData = this.accountDataClientAdapter._values;
        for (const [type, content] of accountData) {
            await baseApis.setAccountData(type, content);
        }

        // add 4S private keys to cache

        // session backup signature, first do get?
            await baseApis._http.authedRequest(
                undefined, "PUT", "/room_keys/version/" + keyBackupInfo.version,
                undefined, keyBackupInfo,
                {prefix: httpApi.PREFIX_UNSTABLE},
            );
        // upload cross-signing keys
        if (this._publishKeys) {
            const keys = {};
            for (const [name, key] of Object.entries(this._publishKeys.keys)) {
                keys[name + "_key"] = key;
            }
            await baseApis.uploadDeviceSigningKeys(
                this._publishKeys.auth,
                keys,
            );
            await cryptoStore.doTxn(
                'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT],
                (txn) => {
                    this._cryptoStore.storeCrossSigningKeys(txn, this._publishKeys.keys);
                },
            );
        }
    }
}
