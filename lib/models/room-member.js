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
 * @module models/room-member
 */
var EventEmitter = require("events").EventEmitter;
var ContentRepo = require("../content-repo");

var utils = require("../utils");

/**
 * Construct a new room member.
 *
 * @constructor
 * @alias module:models/room-member
 *
 * @param {string} roomId The room ID of the member.
 * @param {string} userId The user ID of the member.
 * @prop {string} roomId The room ID for this member.
 * @prop {string} userId The user ID of this member.
 * @prop {boolean} typing True if the room member is currently typing.
 * @prop {string} name The human-readable name for this room member.
 * @prop {Number} powerLevel The power level for this room member.
 * @prop {Number} powerLevelNorm The normalised power level (0-100) for this
 * room member.
 * @prop {User} user The User object for this room member, if one exists.
 * @prop {string} membership The membership state for this room member e.g. 'join'.
 * @prop {Object} events The events describing this RoomMember.
 * @prop {MatrixEvent} events.member The m.room.member event for this RoomMember.
 */
function RoomMember(roomId, userId) {
    this.roomId = roomId;
    this.userId = userId;
    this.typing = false;
    this.name = userId;
    this.powerLevel = 0;
    this.powerLevelNorm = 0;
    this.user = null;
    this.membership = null;
    this.events = {
        member: null
    };
    this._updateModifiedTime();
}
utils.inherits(RoomMember, EventEmitter);

/**
 * Update this room member's membership event. May fire "RoomMember.name" if
 * this event updates this member's name.
 * @param {MatrixEvent} event The <code>m.room.member</code> event
 * @param {RoomState} roomState Optional. The room state to take into account
 * when calculating (e.g. for disambiguating users with the same name).
 * @fires module:client~MatrixClient#event:"RoomMember.name"
 * @fires module:client~MatrixClient#event:"RoomMember.membership"
 */
RoomMember.prototype.setMembershipEvent = function(event, roomState) {
    if (event.getType() !== "m.room.member") {
        return;
    }
    this.events.member = event;

    var oldMembership = this.membership;
    this.membership = event.getDirectionalContent().membership;

    var oldName = this.name;
    this.name = calculateDisplayName(this, event, roomState);
    if (oldMembership !== this.membership) {
        this._updateModifiedTime();
        this.emit("RoomMember.membership", event, this, oldMembership);
    }
    if (oldName !== this.name) {
        this._updateModifiedTime();
        this.emit("RoomMember.name", event, this, oldName);
    }
};

/**
 * Update this room member's power level event. May fire
 * "RoomMember.powerLevel" if this event updates this member's power levels.
 * @param {MatrixEvent} powerLevelEvent The <code>m.room.power_levels</code>
 * event
 * @fires module:client~MatrixClient#event:"RoomMember.powerLevel"
 */
RoomMember.prototype.setPowerLevelEvent = function(powerLevelEvent) {
    if (powerLevelEvent.getType() !== "m.room.power_levels") {
        return;
    }
    var maxLevel = powerLevelEvent.getContent().users_default || 0;
    utils.forEach(utils.values(powerLevelEvent.getContent().users), function(lvl) {
        maxLevel = Math.max(maxLevel, lvl);
    });
    var oldPowerLevel = this.powerLevel;
    var oldPowerLevelNorm = this.powerLevelNorm;

    if (powerLevelEvent.getContent().users[this.userId] !== undefined) {
        this.powerLevel = powerLevelEvent.getContent().users[this.userId];
    } else if (powerLevelEvent.getContent().users_default !== undefined) {
        this.powerLevel = powerLevelEvent.getContent().users_default;
    } else {
        this.powerLevel = 0;
    }
    this.powerLevelNorm = 0;
    if (maxLevel > 0) {
        this.powerLevelNorm = (this.powerLevel * 100) / maxLevel;
    }

    // emit for changes in powerLevelNorm as well (since the app will need to
    // redraw everyone's level if the max has changed)
    if (oldPowerLevel !== this.powerLevel || oldPowerLevelNorm !== this.powerLevelNorm) {
        this._updateModifiedTime();
        this.emit("RoomMember.powerLevel", powerLevelEvent, this);
    }
};

/**
 * Update this room member's typing event. May fire "RoomMember.typing" if
 * this event changes this member's typing state.
 * @param {MatrixEvent} event The typing event
 * @fires module:client~MatrixClient#event:"RoomMember.typing"
 */
RoomMember.prototype.setTypingEvent = function(event) {
    if (event.getType() !== "m.typing") {
        return;
    }
    var oldTyping = this.typing;
    this.typing = false;
    var typingList = event.getContent().user_ids;
    if (!utils.isArray(typingList)) {
        // malformed event :/ bail early. TODO: whine?
        return;
    }
    if (typingList.indexOf(this.userId) !== -1) {
        this.typing = true;
    }
    if (oldTyping !== this.typing) {
        this._updateModifiedTime();
        this.emit("RoomMember.typing", event, this);
    }
};

/**
 * Update the last modified time to the current time.
 */
RoomMember.prototype._updateModifiedTime = function() {
    this._modified = Date.now();
};

/**
 * Get the timestamp when this RoomMember was last updated. This timestamp is
 * updated when properties on this RoomMember are updated.
 * It is updated <i>before</i> firing events.
 * @return {number} The timestamp
 */
RoomMember.prototype.getLastModifiedTime = function() {
    return this._modified;
};

/**
 * Get the avatar URL for a room member.
 * @param {string} baseUrl The base homeserver URL See
 * {@link module:client~MatrixClient#getHomeserverUrl}.
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {Boolean} allowDefault (optional) Passing false causes this method to
 * return null if the user has no avatar image. Otherwise, a default image URL
 * will be returned. Default: true.
 * @param {Boolean} allowDirectLinks (optional) If true, the avatar URL will be
 * returned even if it is a direct hyperlink rather than a matrix content URL.
 * If false, any non-matrix content URLs will be ignored. Setting this option to
 * true will expose URLs that, if fetched, will leak information about the user
 * to anyone who they share a room with.
 * @return {?string} the avatar URL or null.
 */
RoomMember.prototype.getAvatarUrl =
        function(baseUrl, width, height, resizeMethod, allowDefault, allowDirectLinks) {
    if (allowDefault === undefined) { allowDefault = true; }
    if (!this.events.member && !allowDefault) {
        return null;
    }
    var rawUrl = this.events.member ? this.events.member.getContent().avatar_url : null;
    var httpUrl = ContentRepo.getHttpUriForMxc(
        baseUrl, rawUrl, width, height, resizeMethod, allowDirectLinks
    );
    if (httpUrl) {
        return httpUrl;
    }
    else if (allowDefault) {
        return ContentRepo.getIdenticonUri(
            baseUrl, this.userId, width, height
        );
    }
    return null;
};

function calculateDisplayName(member, event, roomState) {
    var displayName = event.getDirectionalContent().displayname;
    var selfUserId = member.userId;

    if (!displayName) {
        return selfUserId;
    }

    if (!roomState) {
        return displayName;
    }

    var userIds = roomState.getUserIdsWithDisplayName(displayName);
    var otherUsers = userIds.filter(function(u) {
        return u !== selfUserId;
    });
    if (otherUsers.length > 0) {
        return displayName + " (" + selfUserId + ")";
    }
    return displayName;
}

/**
 * The RoomMember class.
 */
module.exports = RoomMember;

/**
 * Fires whenever any room member's name changes.
 * @event module:client~MatrixClient#"RoomMember.name"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.name changed.
 * @param {string?} oldName The previous name. Null if the member didn't have a
 *    name previously.
 * @example
 * matrixClient.on("RoomMember.name", function(event, member){
 *   var newName = member.name;
 * });
 */

/**
 * Fires whenever any room member's membership state changes.
 * @event module:client~MatrixClient#"RoomMember.membership"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.membership changed.
 * @param {string?} oldMembership The previous membership state. Null if it's a
 *    new member.
 * @example
 * matrixClient.on("RoomMember.membership", function(event, member, oldMembership){
 *   var newState = member.membership;
 * });
 */

/**
 * Fires whenever any room member's typing state changes.
 * @event module:client~MatrixClient#"RoomMember.typing"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.typing changed.
 * @example
 * matrixClient.on("RoomMember.typing", function(event, member){
 *   var isTyping = member.typing;
 * });
 */

/**
 * Fires whenever any room member's power level changes.
 * @event module:client~MatrixClient#"RoomMember.powerLevel"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.powerLevel changed.
 * @example
 * matrixClient.on("RoomMember.powerLevel", function(event, member){
 *   var newPowerLevel = member.powerLevel;
 *   var newNormPowerLevel = member.powerLevelNorm;
 * });
 */
