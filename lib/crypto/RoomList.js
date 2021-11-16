"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RoomList = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _indexeddbCryptoStore = require("./store/indexeddb-crypto-store");

/*
Copyright 2018 - 2021 The Matrix.org Foundation C.I.C.

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

/* eslint-enable camelcase */

/**
 * @alias module:crypto/RoomList
 */
class RoomList {
  // Object of roomId -> room e2e info object (body of the m.room.encryption event)
  constructor(cryptoStore) {
    this.cryptoStore = cryptoStore;
    (0, _defineProperty2.default)(this, "roomEncryption", {});
  }

  async init() {
    await this.cryptoStore.doTxn('readwrite', [_indexeddbCryptoStore.IndexedDBCryptoStore.STORE_ROOMS], txn => {
      this.cryptoStore.getEndToEndRooms(txn, result => {
        this.roomEncryption = result;
      });
    });
  }

  getRoomEncryption(roomId) {
    return this.roomEncryption[roomId] || null;
  }

  isRoomEncrypted(roomId) {
    return Boolean(this.getRoomEncryption(roomId));
  }

  async setRoomEncryption(roomId, roomInfo) {
    // important that this happens before calling into the store
    // as it prevents the Crypto::setRoomEncryption from calling
    // this twice for consecutive m.room.encryption events
    this.roomEncryption[roomId] = roomInfo;
    await this.cryptoStore.doTxn('readwrite', [_indexeddbCryptoStore.IndexedDBCryptoStore.STORE_ROOMS], txn => {
      this.cryptoStore.storeEndToEndRoom(roomId, roomInfo, txn);
    });
  }

}

exports.RoomList = RoomList;