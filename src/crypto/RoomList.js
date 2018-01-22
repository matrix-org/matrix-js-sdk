/*
Copyright 2018 New Vector Ltd

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
 * @module crypto/RoomList
 *
 * Manages the list of encrypted rooms
 */

import IndexedDBCryptoStore from './store/indexeddb-crypto-store';

/**
 * @alias module:crypto/RoomList
 */
export default class RoomList {
    constructor(cryptoStore, sessionStore) {
        this._cryptoStore = cryptoStore;
        this._sessionStore = sessionStore;

        // Object of roomId -> room e2e info object
        this._roomEncryption = {};
    }

    async init() {
        let removeSessionStoreRooms = false;
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
                this._cryptoStore.getEndToEndRooms(txn, (result) => {
                    if (result === null || Object.keys(result).length === 0) {
                        // migrate rom session store, if there's data there
                        const sessionStoreRooms = this._sessionStore.getAllEndToEndRooms();
                        if (sessionStoreRooms !== null) {
                            for (const roomId of Object.keys(sessionStoreRooms)) {
                                this._cryptoStore.storeEndToEndRoom(roomId, sessionStoreRooms[roomId], txn);
                            }
                        }
                        this._roomEncryption = sessionStoreRooms;
                        removeSessionStoreRooms = true;
                    } else {
                        this._roomEncryption = result;
                    }
                });
            },
        );
        if (removeSessionStoreRooms) {
            this._sessionStore.removeAllEndToEndRooms();
        }
    }

    getRoomEncryption(roomId) {
        return this._roomEncryption[roomId] || null;
    }

    isRoomEncrypted(roomId) {
        return Boolean(this.getRoomEncryption(roomId));
    }

    async setRoomEncryption(roomId, roomInfo) {
        this._roomEncryption[roomId] = roomInfo;
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
                this._cryptoStore.storeEndToEndRoom(roomId, roomInfo, txn);
            },
        );
    }
}
