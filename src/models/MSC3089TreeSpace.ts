/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { MatrixClient } from "../client";
import { EventType } from "../@types/event";
import { Room } from "./room";

/**
 * The recommended defaults for a tree space's power levels. Note that this
 * is UNSTABLE and subject to breaking changes without notice.
 */
export const DEFAULT_TREE_POWER_LEVELS_TEMPLATE = {
    // Owner
    invite: 100,
    kick: 100,
    ban: 100,

    // Editor
    redact: 50,
    state_default: 50,
    events_default: 50,

    // Viewer
    users_default: 0,

    // Mixed
    events: {
        [EventType.RoomPowerLevels]: 100,
        [EventType.RoomHistoryVisibility]: 100,
        [EventType.RoomTombstone]: 100,
        [EventType.RoomEncryption]: 100,
        [EventType.RoomName]: 50,
        [EventType.RoomMessage]: 50,
        [EventType.RoomMessageEncrypted]: 50,
        [EventType.Sticker]: 50,
    },
    users: {}, // defined by calling code
};

/**
 * Ease-of-use representation for power levels represented as simple roles.
 * Note that this is UNSTABLE and subject to breaking changes without notice.
 */
export enum TreePermissions {
    Viewer = "viewer", // Default
    Editor = "editor", // "Moderator" or ~PL50
    Owner = "owner", // "Admin" or PL100
}

/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089)
 * file tree Space. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */
export class MSC3089TreeSpace {
    public readonly room: Room;

    public constructor(private client: MatrixClient, public readonly roomId: string) {
        this.room = this.client.getRoom(this.roomId);
    }

    /**
     * Syntactic sugar for room ID of the Space.
     */
    public get id(): string {
        return this.roomId;
    }

    /**
     * Sets the name of the tree space.
     * @param {string} name The new name for the space.
     * @returns {Promise<void>} Resolves when complete.
     */
    public setName(name: string): Promise<void> {
        return this.client.sendStateEvent(this.roomId, EventType.RoomName, {name}, "");
    }

    /**
     * Invites a user to the tree space. They will be given the default Viewer
     * permission level unless specified elsewhere.
     * @param {string} userId The user ID to invite.
     * @returns {Promise<void>} Resolves when complete.
     */
    public invite(userId: string): Promise<void> {
        // TODO: [@@TR] Reliable invites
        // TODO: [@@TR] Share keys
        return this.client.invite(this.roomId, userId);
    }

    /**
     * Sets the permissions of a user to the given role. Note that if setting a user
     * to Owner then they will NOT be able to be demoted. If the user does not have
     * permission to change the power level of the target, an error will be thrown.
     * @param {string} userId The user ID to change the role of.
     * @param {TreePermissions} role The role to assign.
     * @returns {Promise<void>} Resolves when complete.
     */
    public async setPermissions(userId: string, role: TreePermissions): Promise<void> {
        const currentPls = this.room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
        if (Array.isArray(currentPls)) throw new Error("Unexpected return type for power levels");

        const pls = currentPls.getContent() || {};
        const viewLevel = pls['users_default'] || 0;
        const editLevel = pls['events_default'] || 50;
        const adminLevel = pls['events']?.[EventType.RoomPowerLevels] || 100;

        const users = pls['users'] || {};
        switch (role) {
            case TreePermissions.Viewer:
                users[userId] = viewLevel;
                break;
            case TreePermissions.Editor:
                users[userId] = editLevel;
                break;
            case TreePermissions.Owner:
                users[userId] = adminLevel;
                break;
            default:
                throw new Error("Invalid role: " + role);
        }
        pls['users'] = users;

        return this.client.sendStateEvent(this.roomId, EventType.RoomPowerLevels, pls, "");
    }
}
