/*
Copyright 2015, 2016 OpenMarket Ltd

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
 * @module models/user
 */
 var EventEmitter = require("events").EventEmitter;
 var utils = require("../utils");

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
 * @prop {Number} lastActiveAgo The last time the user performed some action in ms.
 * @prop {Object} events The events describing this user.
 * @prop {MatrixEvent} events.presence The m.presence event for this user.
 */
function User(userId) {
    this.userId = userId;
    this.presence = "offline";
    this.displayName = userId;
    this.avatarUrl = null;
    this.lastActiveAgo = 0;
    this.events = {
        presence: null,
        profile: null
    };
    this._updateModifiedTime();
}
utils.inherits(User, EventEmitter);

/**
 * Update this User with the given presence event. May fire "User.presence",
 * "User.avatarUrl" and/or "User.displayName" if this event updates this user's
 * properties.
 * @param {MatrixEvent} event The <code>m.presence</code> event.
 * @fires module:client~MatrixClient#event:"User.presence"
 * @fires module:client~MatrixClient#event:"User.displayName"
 * @fires module:client~MatrixClient#event:"User.avatarUrl"
 */
User.prototype.setPresenceEvent = function(event) {
    if (event.getType() !== "m.presence") {
        return;
    }
    var firstFire = this.events.presence === null;
    this.events.presence = event;

    var eventsToFire = [];
    if (event.getContent().presence !== this.presence || firstFire) {
        eventsToFire.push("User.presence");
    }
    if (event.getContent().avatar_url !== this.avatarUrl) {
        eventsToFire.push("User.avatarUrl");
    }
    if (event.getContent().displayname !== this.displayName) {
        eventsToFire.push("User.displayName");
    }

    this.presence = event.getContent().presence;
    this.displayName = event.getContent().displayname;
    this.avatarUrl = event.getContent().avatar_url;
    this.lastActiveAgo = event.getContent().last_active_ago;

    if (eventsToFire.length > 0) {
        this._updateModifiedTime();
    }

    for (var i = 0; i < eventsToFire.length; i++) {
        this.emit(eventsToFire[i], event, this);
    }
};

/**
 * Update the last modified time to the current time.
 */
User.prototype._updateModifiedTime = function() {
    this._modified = Date.now();
};

/**
 * Get the timestamp when this User was last updated. This timestamp is
 * updated when this User receives a new Presence event which has updated a
 * property on this object. It is updated <i>before</i> firing events.
 * @return {number} The timestamp
 */
User.prototype.getLastModifiedTime = function() {
    return this._modified;
};

/**
 * The User class.
 */
module.exports = User;

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
