import {MatrixEvent} from "../models/event";
import {EventEmitter} from "events";

/**
 * Builds an EncryptionSetupOperation by calling any of the add.. methods.
 * Once done, `buildOperation()` can be called which allows to apply to operation.
 *
 * This is used as a helper by Crypto to keep track of all the network requests
 * and other side-effects of bootstrapping, so it can be applied in one go (and retried in the future)
 * Also keeps track of all the private keys created during bootstrapping, so we don't need to prompt for them
 * more than once.
 */
export class EncryptionSetupBuilder {
    /**
     * @param  {Object.<String, MatrixEvent>} accountData pre-existing account data, will only be read, not written.
     */
    constructor(accountData) {
        this.accountDataClientAdapter = new AccountDataClientAdapter(accountData);
        this.crossSigningCallbacks = new CrossSigningCallbacks();
        this.ssssCryptoCallbacks = new SSSSCryptoCallbacks();
    }
}


/**
 * Catches account data set by SecretStorage during bootstrapping by
 * implementing the methods related to account data in MatrixClient
 */
class AccountDataClientAdapter extends EventEmitter {
    /**
     * @param  {Object.<String, MatrixEvent>} accountData existing account data
     */
    constructor(accountData) {
        super();
        this._existingValues = accountData;
        this._values = new Map();
    }

    /**
     * @param  {String} type
     * @return {Promise<Object>} the content of the account data
     */
    getAccountDataFromServer(type) {
        return Promise.resolve(this.getAccountData(type));
    }

    /**
     * @param  {String} type
     * @return {Object} the content of the account data
     */
    getAccountData(type) {
        const modifiedValue = this._values.get(type);
        if (modifiedValue) {
            return modifiedValue;
        }
        const existingValue = this._existingValues[type];
        if (existingValue) {
            return existingValue.getContent();
        }
        return null;
    }

    /**
     * @param {String} type
     * @param {Object} content
     * @return {Promise}
     */
    setAccountData(type, content) {
        this._values.set(type, content);
        // ensure accountData is emitted on the next tick,
        // as SecretStorage listens for it while calling this method
        // and it seems to rely on this.
        return Promise.resolve().then(() => {
            const event = new MatrixEvent({type, content});
            this.emit("accountData", event);
        });
    }
}

/**
 * Catches the private cross-signing keys set during bootstrapping
 * by both cache callbacks (see createCryptoStoreCacheCallbacks) as non-cache callbacks.
 * See CrossSigningInfo constructor
 */
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

/**
 * Catches the 4S private key set during bootstrapping by implementing
 * the SecretStorage crypto callbacks
 */
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
