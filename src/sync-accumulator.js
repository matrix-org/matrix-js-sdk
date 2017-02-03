/*
Copyright 2017 Vector Creations Ltd

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
"use strict";


/**
 * Internal class.
 *
 * The purpose of this class is to accumulate /sync responses such that a
 * complete "initial" JSON response can be returned which accurately represents
 * the sum total of the /sync responses accumulated to date. It only handles
 * room data: that is, everything under the "rooms" top-level key.
 *
 * This class is used when persisting room data so a complete /sync response can
 * be loaded from disk and incremental syncs can be performed on the server,
 * rather than asking the server to do an initial sync on startup.
 */
class SyncAccumulator {

    constructor() {
        this.rooms = {
            // $room_id : {
            //   category: invite|join|leave,
            //   data: { ... sync json data ... }
            // }
        };
    }

    /**
     * Accumulate incremental /sync data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    accumulate(syncResponse) {
        if (!syncResponse.rooms) {
            return;
        }
        if (syncResponse.rooms.invite) {
            Object.keys(syncResponse.rooms.invite).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "invite", syncResponse.rooms.invite[roomId],
                );
            });
        }
        if (syncResponse.rooms.join) {
            Object.keys(syncResponse.rooms.join).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "join", syncResponse.rooms.join[roomId],
                );
            });
        }
        if (syncResponse.rooms.leave) {
            Object.keys(syncResponse.rooms.leave).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "leave", syncResponse.rooms.leave[roomId],
                );
            });
        }
    }

    _accumulateRoom(roomId, category, data) {
        return;
    }

    /**
     * Return everything under the 'rooms' key from a /sync response which
     * accurately represents all room data.
     * @return {Object} A JSON object which has the same API shape as /sync.
     */
    getJSON() {
        const data = {
            join: {},
            invite: {},
            leave: {},
        };
        Object.keys(this.rooms).forEach((roomId) => {
            switch (this.rooms[roomId].category) {
                case "join":
                    data.join[roomId] = this.rooms[roomId].data;
                    break;
                case "invite":
                    data.invite[roomId] = this.rooms[roomId].data;
                    break;
                case "leave":
                    data.leave[roomId] = this.rooms[roomId].data;
                    break;
            }
        });
        return data;
    }
}

module.exports = SyncAccumulator;
