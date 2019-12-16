/*
Copyright 2018, 2019 New Vector Ltd

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
    constructor(cryptoStore) {
        this._cryptoStore = cryptoStore;

        // Object of roomId -> room e2e info object (body of the m.room.encryption event)
        this._roomEncryption = {};
    }

    async init() {
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
                this._cryptoStore.getEndToEndRooms(txn, (result) => {
                    this._roomEncryption = result;
                });
            },
        );
    }

    getRoomEncryption(roomId) {
        return this._roomEncryption[roomId] || null;
    }

    isRoomEncrypted(roomId) {
        return Boolean(this.getRoomEncryption(roomId));
    }

    async setRoomEncryption(roomId, roomInfo) {
        // important that this happens before calling into the store
        // as it prevents the Crypto::setRoomEncryption from calling
        // this twice for consecutive m.room.encryption events
        this._roomEncryption[roomId] = roomInfo;
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
                this._cryptoStore.storeEndToEndRoom(roomId, roomInfo, txn);
            },
        );
    }
}
