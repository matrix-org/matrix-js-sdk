/// <reference types="node" />
/**
 * @module models/user
 */
import { EventEmitter } from "events";
import { MatrixEvent } from "./event";
export declare class User extends EventEmitter {
    readonly userId: string;
    private modified;
    displayName: string;
    rawDisplayName: string;
    avatarUrl: string;
    presenceStatusMsg: string;
    presence: string;
    lastActiveAgo: number;
    lastPresenceTs: number;
    currentlyActive: boolean;
    events: {
        presence?: MatrixEvent;
        profile?: MatrixEvent;
    };
    unstable_statusMessage: string;
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
     * @prop {string} unstable_statusMessage The status message for the user, if known. This is
     *                different from the presenceStatusMsg in that this is not tied to
     *                the user's presence, and should be represented differently.
     * @prop {Object} events The events describing this user.
     * @prop {MatrixEvent} events.presence The m.presence event for this user.
     */
    constructor(userId: string);
    /**
     * Update this User with the given presence event. May fire "User.presence",
     * "User.avatarUrl" and/or "User.displayName" if this event updates this user's
     * properties.
     * @param {MatrixEvent} event The <code>m.presence</code> event.
     * @fires module:client~MatrixClient#event:"User.presence"
     * @fires module:client~MatrixClient#event:"User.displayName"
     * @fires module:client~MatrixClient#event:"User.avatarUrl"
     */
    setPresenceEvent(event: MatrixEvent): void;
    /**
     * Manually set this user's display name. No event is emitted in response to this
     * as there is no underlying MatrixEvent to emit with.
     * @param {string} name The new display name.
     */
    setDisplayName(name: string): void;
    /**
     * Manually set this user's non-disambiguated display name. No event is emitted
     * in response to this as there is no underlying MatrixEvent to emit with.
     * @param {string} name The new display name.
     */
    setRawDisplayName(name: string): void;
    /**
     * Manually set this user's avatar URL. No event is emitted in response to this
     * as there is no underlying MatrixEvent to emit with.
     * @param {string} url The new avatar URL.
     */
    setAvatarUrl(url: string): void;
    /**
     * Update the last modified time to the current time.
     */
    private updateModifiedTime;
    /**
     * Get the timestamp when this User was last updated. This timestamp is
     * updated when this User receives a new Presence event which has updated a
     * property on this object. It is updated <i>before</i> firing events.
     * @return {number} The timestamp
     */
    getLastModifiedTime(): number;
    /**
     * Get the absolute timestamp when this User was last known active on the server.
     * It is *NOT* accurate if this.currentlyActive is true.
     * @return {number} The timestamp
     */
    getLastActiveTs(): number;
    /**
     * Manually set the user's status message.
     * @param {MatrixEvent} event The <code>im.vector.user_status</code> event.
     * @fires module:client~MatrixClient#event:"User.unstable_statusMessage"
     */
    unstable_updateStatusMessage(event: MatrixEvent): void;
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
//# sourceMappingURL=user.d.ts.map