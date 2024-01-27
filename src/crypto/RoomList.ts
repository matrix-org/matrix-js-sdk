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
 * Manages the list of encrypted rooms
 */

import { CryptoStore } from "./store/base";
import { IndexedDBCryptoStore } from "./store/indexeddb-crypto-store";

/* eslint-disable camelcase */
export interface IRoomEncryption {
    algorithm: string;
    rotation_period_ms?: number;
    rotation_period_msgs?: number;
}
/* eslint-enable camelcase */

/**
 * Information about the encryption settings of rooms. Loads this information
 * from the supplied crypto store when `init()` is called, and saves it to the
 * crypto store whenever it is updated via `setRoomEncryption()`. Can supply
 * full information about a room's encryption via `getRoomEncryption()`, or just
 * answer whether or not a room has encryption via `isRoomEncrypted`.
 */
export class RoomList {
    // Object of roomId -> room e2e info object (body of the m.room.encryption event)
    private roomEncryption: Record<string, IRoomEncryption> = {};

    public constructor(private readonly cryptoStore?: CryptoStore) {}

    public async init(): Promise<void> {
        await this.cryptoStore!.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
            this.cryptoStore!.getEndToEndRooms(txn, (result) => {
                this.roomEncryption = result;
            });
        });
    }

    public getRoomEncryption(roomId: string): IRoomEncryption | null {
        return this.roomEncryption[roomId] || null;
    }

    public isRoomEncrypted(roomId: string): boolean {
        return Boolean(this.getRoomEncryption(roomId));
    }

    public async setRoomEncryption(roomId: string, roomInfo: IRoomEncryption): Promise<void> {
        // important that this happens before calling into the store
        // as it prevents the Crypto::setRoomEncryption from calling
        // this twice for consecutive m.room.encryption events
        this.roomEncryption[roomId] = roomInfo;
        await this.cryptoStore!.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ROOMS], (txn) => {
            this.cryptoStore!.storeEndToEndRoom(roomId, roomInfo, txn);
        });
    }
}
