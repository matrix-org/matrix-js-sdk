/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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
 * @module models/user
 */

import { MatrixEvent } from "./event";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum UserEvent {
    DisplayName = "User.displayName",
    AvatarUrl = "User.avatarUrl",
    Presence = "User.presence",
    CurrentlyActive = "User.currentlyActive",
    LastPresenceTs = "User.lastPresenceTs",
}

export type UserEventHandlerMap = {
    [UserEvent.DisplayName]: (event: MatrixEvent | undefined, user: User) => void;
    [UserEvent.AvatarUrl]: (event: MatrixEvent | undefined, user: User) => void;
    [UserEvent.Presence]: (event: MatrixEvent | undefined, user: User) => void;
    [UserEvent.CurrentlyActive]: (event: MatrixEvent | undefined, user: User) => void;
    [UserEvent.LastPresenceTs]: (event: MatrixEvent | undefined, user: User) => void;
};

export class User extends TypedEventEmitter<UserEvent, UserEventHandlerMap> {
    private modified = -1;

    // XXX these should be read-only
    public displayName?: string;
    public rawDisplayName?: string;
    public avatarUrl?: string;
    public presenceStatusMsg?: string;
    public presence = "offline";
    public lastActiveAgo = 0;
    public lastPresenceTs = 0;
    public currentlyActive = false;
    public events: {
        presence?: MatrixEvent;
        profile?: MatrixEvent;
    } = {};

    /**
     * Construct a new User. A User must have an ID and can optionally have extra
     * information associated with it.
     * @constructor
     * @param {string} userId Required. The ID of this user.
     * @prop {string} userId The ID of the user.
     * @prop {Object} info The info object supplied in the constructor.
     * @prop {string} displayName The 'displayname' of the user if known.
     * @prop {string} avatarUrl The 'avatar_url' of the user if known.
     * @prop {string} presence The presence enum if known.
     * @prop {string} presenceStatusMsg The presence status message if known.
     * @prop {Number} lastActiveAgo The time elapsed in ms since the user interacted
     *                proactively with the server, or we saw a message from the user
     * @prop {Number} lastPresenceTs Timestamp (ms since the epoch) for when we last
     *                received presence data for this user.  We can subtract
     *                lastActiveAgo from this to approximate an absolute value for
     *                when a user was last active.
     * @prop {Boolean} currentlyActive Whether we should consider lastActiveAgo to be
     *               an approximation and that the user should be seen as active 'now'
     * @prop {Object} events The events describing this user.
     * @prop {MatrixEvent} events.presence The m.presence event for this user.
     */
    constructor(public readonly userId: string) {
        super();
        this.displayName = userId;
        this.rawDisplayName = userId;
        this.updateModifiedTime();
    }

    /**
     * Update this User with the given presence event. May fire "User.presence",
     * "User.avatarUrl" and/or "User.displayName" if this event updates this user's
     * properties.
     * @param {MatrixEvent} event The <code>m.presence</code> event.
     * @fires module:client~MatrixClient#event:"User.presence"
     * @fires module:client~MatrixClient#event:"User.displayName"
     * @fires module:client~MatrixClient#event:"User.avatarUrl"
     */
    public setPresenceEvent(event: MatrixEvent): void {
        if (event.getType() !== "m.presence") {
            return;
        }
        const firstFire = this.events.presence === null;
        this.events.presence = event;

        const eventsToFire: UserEvent[] = [];
        if (event.getContent().presence !== this.presence || firstFire) {
            eventsToFire.push(UserEvent.Presence);
        }
        if (event.getContent().avatar_url &&
            event.getContent().avatar_url !== this.avatarUrl) {
            eventsToFire.push(UserEvent.AvatarUrl);
        }
        if (event.getContent().displayname &&
            event.getContent().displayname !== this.displayName) {
            eventsToFire.push(UserEvent.DisplayName);
        }
        if (event.getContent().currently_active !== undefined &&
            event.getContent().currently_active !== this.currentlyActive) {
            eventsToFire.push(UserEvent.CurrentlyActive);
        }

        this.presence = event.getContent().presence;
        eventsToFire.push(UserEvent.LastPresenceTs);

        if (event.getContent().status_msg) {
            this.presenceStatusMsg = event.getContent().status_msg;
        }
        if (event.getContent().displayname) {
            this.displayName = event.getContent().displayname;
        }
        if (event.getContent().avatar_url) {
            this.avatarUrl = event.getContent().avatar_url;
        }
        this.lastActiveAgo = event.getContent().last_active_ago;
        this.lastPresenceTs = Date.now();
        this.currentlyActive = event.getContent().currently_active;

        this.updateModifiedTime();

        for (const eventToFire of eventsToFire) {
            this.emit(eventToFire, event, this);
        }
    }

    /**
     * Manually set this user's display name. No event is emitted in response to this
     * as there is no underlying MatrixEvent to emit with.
     * @param {string} name The new display name.
     */
    public setDisplayName(name: string): void {
        const oldName = this.displayName;
        this.displayName = name;
        if (name !== oldName) {
            this.updateModifiedTime();
        }
    }

    /**
     * Manually set this user's non-disambiguated display name. No event is emitted
     * in response to this as there is no underlying MatrixEvent to emit with.
     * @param {string} name The new display name.
     */
    public setRawDisplayName(name?: string): void {
        this.rawDisplayName = name;
    }

    /**
     * Manually set this user's avatar URL. No event is emitted in response to this
     * as there is no underlying MatrixEvent to emit with.
     * @param {string} url The new avatar URL.
     */
    public setAvatarUrl(url?: string): void {
        const oldUrl = this.avatarUrl;
        this.avatarUrl = url;
        if (url !== oldUrl) {
            this.updateModifiedTime();
        }
    }

    /**
     * Update the last modified time to the current time.
     */
    private updateModifiedTime(): void {
        this.modified = Date.now();
    }

    /**
     * Get the timestamp when this User was last updated. This timestamp is
     * updated when this User receives a new Presence event which has updated a
     * property on this object. It is updated <i>before</i> firing events.
     * @return {number} The timestamp
     */
    public getLastModifiedTime(): number {
        return this.modified;
    }

    /**
     * Get the absolute timestamp when this User was last known active on the server.
     * It is *NOT* accurate if this.currentlyActive is true.
     * @return {number} The timestamp
     */
    public getLastActiveTs(): number {
        return this.lastPresenceTs - this.lastActiveAgo;
    }
}

/**
 * Fires whenever any user's lastPresenceTs changes,
 * ie. whenever any presence event is received for a user.
 * @event module:client~MatrixClient#"User.lastPresenceTs"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {User} user The user whose User.lastPresenceTs changed.
 * @example
 * matrixClient.on("User.lastPresenceTs", function(event, user){
 *   var newlastPresenceTs = user.lastPresenceTs;
 * });
 */

/**
 * Fires whenever any user's presence changes.
 * @event module:client~MatrixClient#"User.presence"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {User} user The user whose User.presence changed.
 * @example
 * matrixClient.on("User.presence", function(event, user){
 *   var newPresence = user.presence;
 * });
 */

/**
 * Fires whenever any user's currentlyActive changes.
 * @event module:client~MatrixClient#"User.currentlyActive"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {User} user The user whose User.currentlyActive changed.
 * @example
 * matrixClient.on("User.currentlyActive", function(event, user){
 *   var newCurrentlyActive = user.currentlyActive;
 * });
 */

/**
 * Fires whenever any user's display name changes.
 * @event module:client~MatrixClient#"User.displayName"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {User} user The user whose User.displayName changed.
 * @example
 * matrixClient.on("User.displayName", function(event, user){
 *   var newName = user.displayName;
 * });
 */

/**
 * Fires whenever any user's avatar URL changes.
 * @event module:client~MatrixClient#"User.avatarUrl"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {User} user The user whose User.avatarUrl changed.
 * @example
 * matrixClient.on("User.avatarUrl", function(event, user){
 *   var newUrl = user.avatarUrl;
 * });
 */
