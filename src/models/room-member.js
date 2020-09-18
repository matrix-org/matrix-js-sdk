/*
Copyright 2015, 2016 OpenMarket Ltd
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

/**
 * @module models/room-member
 */

import {EventEmitter} from "events";
import {getHttpUriForMxc} from "../content-repo";
import * as utils from "../utils";

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
 * @prop {string} name The human-readable name for this room member. This will be
 * disambiguated with a suffix of " (@user_id:matrix.org)" if another member shares the
 * same displayname.
 * @prop {string} rawDisplayName The ambiguous displayname of this room member.
 * @prop {Number} powerLevel The power level for this room member.
 * @prop {Number} powerLevelNorm The normalised power level (0-100) for this
 * room member.
 * @prop {User} user The User object for this room member, if one exists.
 * @prop {string} membership The membership state for this room member e.g. 'join'.
 * @prop {Object} events The events describing this RoomMember.
 * @prop {MatrixEvent} events.member The m.room.member event for this RoomMember.
 */
export function RoomMember(roomId, userId) {
    this.roomId = roomId;
    this.userId = userId;
    this.typing = false;
    this.name = userId;
    this.rawDisplayName = userId;
    this.powerLevel = 0;
    this.powerLevelNorm = 0;
    this.user = null;
    this.membership = null;
    this.events = {
        member: null,
    };
    this._isOutOfBand = false;
    this._updateModifiedTime();
}
utils.inherits(RoomMember, EventEmitter);

/**
 * Mark the member as coming from a channel that is not sync
 */
RoomMember.prototype.markOutOfBand = function() {
    this._isOutOfBand = true;
};

/**
 * @return {bool} does the member come from a channel that is not sync?
 * This is used to store the member seperately
 * from the sync state so it available across browser sessions.
 */
RoomMember.prototype.isOutOfBand = function() {
    return this._isOutOfBand;
};

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

    this._isOutOfBand = false;

    this.events.member = event;

    const oldMembership = this.membership;
    this.membership = event.getDirectionalContent().membership;

    const oldName = this.name;
    this.name = calculateDisplayName(
        this.userId,
        event.getDirectionalContent().displayname,
        roomState);

    this.rawDisplayName = event.getDirectionalContent().displayname || this.userId;
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

    const evContent = powerLevelEvent.getDirectionalContent();

    let maxLevel = evContent.users_default || 0;
    utils.forEach(utils.values(evContent.users), function(lvl) {
        maxLevel = Math.max(maxLevel, lvl);
    });
    const oldPowerLevel = this.powerLevel;
    const oldPowerLevelNorm = this.powerLevelNorm;

    if (evContent.users && evContent.users[this.userId] !== undefined) {
        this.powerLevel = evContent.users[this.userId];
    } else if (evContent.users_default !== undefined) {
        this.powerLevel = evContent.users_default;
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
    const oldTyping = this.typing;
    this.typing = false;
    const typingList = event.getContent().user_ids;
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


RoomMember.prototype.isKicked = function() {
    return this.membership === "leave" &&
        this.events.member.getSender() !== this.events.member.getStateKey();
};

/**
 * If this member was invited with the is_direct flag set, return
 * the user that invited this member
 * @return {string} user id of the inviter
 */
RoomMember.prototype.getDMInviter = function() {
    // when not available because that room state hasn't been loaded in,
    // we don't really know, but more likely to not be a direct chat
    if (this.events.member) {
        // TODO: persist the is_direct flag on the member as more member events
        //       come in caused by displayName changes.

        // the is_direct flag is set on the invite member event.
        // This is copied on the prev_content section of the join member event
        // when the invite is accepted.

        const memberEvent = this.events.member;
        let memberContent = memberEvent.getContent();
        let inviteSender = memberEvent.getSender();

        if (memberContent.membership === "join") {
            memberContent = memberEvent.getPrevContent();
            inviteSender = memberEvent.getUnsigned().prev_sender;
        }

        if (memberContent.membership === "invite" && memberContent.is_direct) {
            return inviteSender;
        }
    }
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
 * will be returned. Default: true. (Deprecated)
 * @param {Boolean} allowDirectLinks (optional) If true, the avatar URL will be
 * returned even if it is a direct hyperlink rather than a matrix content URL.
 * If false, any non-matrix content URLs will be ignored. Setting this option to
 * true will expose URLs that, if fetched, will leak information about the user
 * to anyone who they share a room with.
 * @return {?string} the avatar URL or null.
 */
RoomMember.prototype.getAvatarUrl =
        function(baseUrl, width, height, resizeMethod, allowDefault, allowDirectLinks) {
    if (allowDefault === undefined) {
        allowDefault = true;
    }

    const rawUrl = this.getMxcAvatarUrl();

    if (!rawUrl && !allowDefault) {
        return null;
    }
    const httpUrl = getHttpUriForMxc(
        baseUrl, rawUrl, width, height, resizeMethod, allowDirectLinks,
    );
    if (httpUrl) {
        return httpUrl;
    }
    return null;
};
/**
 * get the mxc avatar url, either from a state event, or from a lazily loaded member
 * @return {string} the mxc avatar url
 */
RoomMember.prototype.getMxcAvatarUrl = function() {
    if (this.events.member) {
        return this.events.member.getDirectionalContent().avatar_url;
    } else if (this.user) {
        return this.user.avatarUrl;
    }
    return null;
};

function calculateDisplayName(selfUserId, displayName, roomState) {
    if (!displayName || displayName === selfUserId) {
        return selfUserId;
    }

    // First check if the displayname is something we consider truthy
    // after stripping it of zero width characters and padding spaces
    if (!utils.removeHiddenChars(displayName)) {
        return selfUserId;
    }

    if (!roomState) {
        return displayName;
    }

    // Next check if the name contains something that look like a mxid
    // If it does, it may be someone trying to impersonate someone else
    // Show full mxid in this case
    let disambiguate = /@.+:.+/.test(displayName);

    if (!disambiguate) {
        // Also show mxid if the display name contains any LTR/RTL characters as these
        // make it very difficult for us to find similar *looking* display names
        // E.g "Mark" could be cloned by writing "kraM" but in RTL.
        disambiguate = /[\u200E\u200F\u202A-\u202F]/.test(displayName);
    }

    if (!disambiguate) {
        // Also show mxid if there are other people with the same or similar
        // displayname, after hidden character removal.
        const userIds = roomState.getUserIdsWithDisplayName(displayName);
        disambiguate = userIds.some((u) => u !== selfUserId);
    }

    if (disambiguate) {
        return displayName + " (" + selfUserId + ")";
    }
    return displayName;
}

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
