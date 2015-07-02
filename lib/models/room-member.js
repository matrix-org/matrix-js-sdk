"use strict";
/**
 * @module models/room-member
 */
var EventEmitter = require("events").EventEmitter;

var utils = require("../utils");

/**
 * Construct a new room member.
 * @constructor
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
}
utils.inherits(RoomMember, EventEmitter);

/**
 * Get the avatar URL for this member.
 * @return {?string} the avatar URL or null.
 */
RoomMember.prototype.getAvatarUrl = function() {
    if (!this.events.member) {
        return null;
    }
    return this.events.member.getContent().avatar_url || null;
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
    this.events.member = event;

    var oldMembership = this.membership;
    this.membership = event.getDirectionalContent().membership;

    var oldName = this.name;
    this.name = calculateDisplayName(this, event, roomState);
    if (oldMembership !== this.membership) {
        this.emit("RoomMember.membership", event, this);
    }
    if (oldName !== this.name) {
        this.emit("RoomMember.name", event, this);
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
    this.powerLevel = (
        powerLevelEvent.getContent().users[this.userId] ||
        powerLevelEvent.getContent().users_default ||
        0
    );
    this.powerLevelNorm = 0;
    if (maxLevel > 0) {
        this.powerLevelNorm = (this.powerLevel * 100) / maxLevel;
    }

    // emit for changes in powerLevelNorm as well (since the app will need to
    // redraw everyone's level if the max has changed)
    if (oldPowerLevel !== this.powerLevel || oldPowerLevelNorm !== this.powerLevelNorm) {
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
        this.emit("RoomMember.typing", event, this);
    }
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

    var stateEvents = utils.filter(
        roomState.getStateEvents("m.room.member"),
        function(e) {
            return e.getContent().displayname === displayName &&
                e.getSender() !== selfUserId;
        }
    );
    if (stateEvents.length > 0) {
        // need to disambiguate
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
 * @example
 * matrixClient.on("RoomMember.membership", function(event, member){
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
