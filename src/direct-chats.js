/*
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/** @module direct-chats */

import logger from '../src/logger';

// TODO: TravisR - Handle members leaving direct chats, including ourselves.
// TODO: TravisR - Handle accepting invites to direct chats
// TODO: TravisR - Add backwards compatibility (update both account data events)

/**
 * Manages direct chats for a given MatrixClient
 */
export class DirectChats {
    /**
     * Creates a new DirectChats manager for a client. It is usually recommended
     * to use the manager offered by the client itself, rather than creating your
     * own.
     * @param {MatrixClient} client The client to manage direct chats of.
     */
    constructor(client) {
        this._client = client;

        this._direct = this._client.getAccountData("m.direct_chats");
        this._legacy = this._client.getAccountData("m.direct");

        this._usersToRooms = {}; // {userIds: roomId}
        this._roomsToUsers = {}; // {roomId: userIds}
        this._remapRooms(this._direct ? this._direct.getContent()['rooms'] : null);

        this._client.on("accountData", (data) => {
            if (data.getType() === 'm.direct_chats') {
                this._remapRooms(data.getContent()['rooms']);
            } else if (data.getType() === 'm.direct') {
                logger.warn("Received update to old m.direct data - possible migration needed");
            }
        });
    }

    /**
     * Determines if there is enough data to migrate.
     * @returns {boolean} True if data can be migrated, false otherwise.
     */
    get canMigrate() {
        return !this._direct && !!this._legacy;
    }

    /**
     * Gets the room IDs for all known direct chats. Does not include legacy data.
     * @returns {string[]} The room IDs for known direct chats.
     */
    get roomIds() {
        return Object.keys(this._roomsToUsers);
    }

    /**
     * Adds a room as a direct chat. If the room does not meet the requirements
     * for a direct chat, this will do nothing.
     * @param {string} roomId The room ID to add a direct chat.
     */
    addDirectChat(roomId) {
        this._remapRooms([roomId, ...this.roomIds]);
    }

    /**
     * Removes a direct chat. If the room was previously not a direct chat, this
     * does nothing.
     * @param {string} roomId The room ID to remove as a direct chat.
     */
    removeDirectChat(roomId) {
        this._remapRooms(this.roomIds.filter(r => r !== roomId));
    }

    /**
     * Determines if a given room ID is a direct chat.
     * @param {string} roomId The room ID to test.
     * @returns {boolean} True if the room is a direct chat, false otherwise.
     */
    isDirectChat(roomId) {
        return this.roomIds.includes(roomId);
    }

    /**
     * Gets an existing chat for a given set of users.
     * @param {string[]} partnerIds The user IDs to find a DM for.
     * @returns {null|Room} The room for the existing chat, or null if none was found.
     */
    getChatForUsers(...partnerIds) {
        partnerIds.sort();
        const userKey = partnerIds.join(' ');

        if (this._usersToRooms[userKey]) {
            return this._client.getRoom(this._usersToRooms[userKey]);
        }

        return null;
    }

    /**
     * Gets or creates a direct chat for a given set of users.
     * @param {string[]} partnerIds The user IDs to find or create a DM for.
     * @returns {Promise<Room>} Resolves to the found or created DM room.
     */
    async getOrCreateChatForUsers(...partnerIds) {
        const existingRoom = this.getChatForUsers(...partnerIds);
        if (existingRoom) return existingRoom;

        const response = await this._client.createRoom({
            preset_pref: "immutable_dm",
            preset: "trusted_private_chat",
            invite: partnerIds,
            is_direct: true,
        });
        await this._client.setAccountData(
            "m.direct_chats",
            {rooms: [response['room_id'], ...this.roomIds]},
            undefined,
        );
        return this._client.getRoom(response['room_id']);
    }

    /**
     * Gets the user IDs which are involved in a direct chat. Useful
     * for naming the direct chat appropriately in an application.
     * @param {string} roomId The room ID to get the users of.
     * @returns {string[]} The user IDs for the chat or an empty array if there are none.
     */
    getUsersInChat(roomId) {
        if (this._roomsToUsers[roomId]) {
            return this._roomsToUsers[roomId].split(' ');
        }

        return [];
    }

    /**
     * Performs a best effort migration of legacy data. Legacy data will be
     * imported without considering if it has been imported before, however
     * duplicate rooms are excluded from the direct chats.
     *
     * The migration will attempt to guess who the DMs are with, not trusting
     * the legacy data to be correctly mapped. The new direct chats data will
     * be populated in the user's account data.
     * @returns {Promise<*>} Resolves when the migration is complete.
     */
    async migrateOldChatsByGuessing() {
        const legacy = this._legacy ? this._legacy.getContent() : {};
        const allRoomIds = [];
        for (const key of Object.keys(legacy)) {
            const roomIds = legacy[key];
            allRoomIds.push(...roomIds);
        }
        this._remapRooms(allRoomIds);
        await this._client.setAccountData("m.direct_chats", {rooms: this.roomIds}, undefined);
    }

    /**
     * Consumes an array of room IDs to map them within this class. This will
     * determine which DMs need to be added or removed, and will assume that
     * DMs do not change who they are with. Raises `DirectChats.change` from
     * the MatrixClient if the direct chats change.
     * @param {string[]} roomIds The room IDs to now consider as DMs.
     * @private
     */
    _remapRooms(roomIds) {
        logger.info("Updating DMs for " + roomIds.length + " room IDs");

        if (!roomIds) {
            // We have no more DMs for users
            const removedIds = this.roomIds;
            this._usersToRooms = {};
            this._roomsToUsers = {};
            this._client.emit("DirectChats.change", [], removedIds);
            return;
        }

        const currentRoomIds = this.roomIds;
        const added = roomIds.filter(r => !currentRoomIds.includes(r));
        const removed = currentRoomIds.filter(r => !roomIds.includes(r));

        const actuallyAddedIds = [];
        const actuallyRemovedIds = [];

        for (const newRoomId of added) {
            const room = this._client.getRoom(newRoomId);
            if (!room) return;

            // TODO: TravisR - Check join rules for DM

            const tombstone = room.currentState.getStateEvents('m.room.tombstone', '');
            if (tombstone) continue;

            const involvedUsers = this._getInvolvedUsersInRoom(room);
            if (!involvedUsers) continue;

            const userKeys = involvedUsers.join(' ');

            if (this._usersToRooms[userKeys]) {
                logger.warn("Already have a direct chat with (by user): ", userKeys);
                continue;
            }
            if (this._roomsToUsers[newRoomId]) {
                logger.warn("Already have a direct chat with (by room): ", userKeys);
                continue;
            }

            this._usersToRooms[userKeys] = newRoomId;
            this._roomsToUsers[newRoomId] = userKeys;
            actuallyAddedIds.push(newRoomId);
        }

        for (const oldRoomId of removed) {
            delete this._roomsToUsers[oldRoomId];

            const userKeys = Object.keys(this._usersToRooms);
            for (const userKey of userKeys) {
                if (this._usersToRooms[userKey] === oldRoomId) {
                    delete this._usersToRooms[userKey];
                }
            }

            actuallyRemovedIds.push(oldRoomId);
        }

        if (removed || added) {
            this._client.emit("DirectChats.change", actuallyAddedIds, actuallyRemovedIds);
        }
    }

    /**
     * Gets which users are involved in a given room by looking at the
     * power levels. Users with enough power are considered important and
     * returned here - unimportant users (everyone else) are not returned.
     * @param {Room} room The room to get users of.
     * @returns {string[]} The important user IDs in the room.
     * @private
     */
    _getInvolvedUsersInRoom(room) {
        const powerLevels = room.currentState.getStateEvents('m.room.power_levels', '');
        const minimumPowerLevel = this._getMinimumPowerLevel(powerLevels);
        const usersWithPower = this._findPowerfulUsers(powerLevels, minimumPowerLevel)
            .filter(u => u !== this._client.getUserId());

        const practicalUsersInRoom = usersWithPower.filter(u => {
            const member = room.getMember(u);
            if (!member) return false;
            return member.membership === 'join' || member.membership === 'invite';
        });

        practicalUsersInRoom.sort();
        return practicalUsersInRoom;
    }

    /**
     * Gets the minimum useful power level from the given power level event.
     * This is used to determine who is important in the room.
     * @param {MatrixEvent} powerLevelEvent The power level event to read.
     * @returns {number} The minimum useful power level represented by the event.
     * @private
     */
    _getMinimumPowerLevel(powerLevelEvent) {
        const stateDefault = powerLevelEvent.getContent()['state_default'];
        if (!isNaN(stateDefault) && stateDefault !== null) {
            return stateDefault;
        }
        return 50;
    }

    /**
     * Finds all users with the minimum power level in the room.
     * @param {MatrixEvent} powerLevelEvent The power level event to read.
     * @param {number} minimumPower The minimum inclusive power level to consider.
     * @returns {string[]} The user IDs which have enough power in the room.
     * @private
     */
    _findPowerfulUsers(powerLevelEvent, minimumPower) {
        const users = powerLevelEvent.getContent()['users'];
        if (!users) return [];
        return Object.keys(users).filter(u => users[u] >= minimumPower);
    }
}
