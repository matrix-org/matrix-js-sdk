import { IndexedDBCryptoStore } from '../../../src/crypto/store/indexeddb-crypto-store';

// needs to be phased out and replaced with bootstrapSecretStorage,
// but that is doing too much extra stuff for it to be an easy transition.
export async function resetCrossSigningKeys(client, {
    level,
    authUploadDeviceSigningKeys = async func => await func(),
} = {}) {
    const crypto = client.crypto;

    const oldKeys = Object.assign({}, crypto.crossSigningInfo.keys);
    try {
        await crypto.crossSigningInfo.resetKeys(level);
        await crypto.signObject(crypto.crossSigningInfo.keys.master);
        // write a copy locally so we know these are trusted keys
        await crypto.cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                crypto.cryptoStore.storeCrossSigningKeys(
                    txn, crypto.crossSigningInfo.keys);
            },
        );
    } catch (e) {
        // If anything failed here, revert the keys so we know to try again from the start
        // next time.
        crypto.crossSigningInfo.keys = oldKeys;
        throw e;
    }
    crypto.emit("crossSigning.keysChanged", {});
    await crypto.afterCrossSigningLocalKeyChange();
}

export async function createSecretStorageKey() {
    const decryption = new global.Olm.PkDecryption();
    const storagePublicKey = decryption.generate_key();
    const storagePrivateKey = decryption.get_private_key();
    decryption.free();
    return {
        // `pubkey` not used anymore with symmetric 4S
        keyInfo: { pubkey: storagePublicKey },
        privateKey: storagePrivateKey,
    };
}
