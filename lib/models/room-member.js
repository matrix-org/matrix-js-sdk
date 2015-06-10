"use strict";
/**
 * @module models/room-member
 */
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
 * @throws If the event provided is not <code>m.room.member</code>
 */
function RoomMember(roomId, userId) {
    this.roomId = roomId;
    this.userId = userId;
    this.typing = false;
    this.name = userId;
    this.powerLevel = 0;
    this.powerLevelNorm = 0;
    this.user = null;
}
RoomMember.prototype = {

    /**
     * Update this room member's membership event. May fire "RoomMember.name" if
     * this event updates this member's name.
     * @param {MatrixEvent} event The <code>m.room.member</code> event
     * @param {RoomState} roomState Optional. The room state to take into account
     * when calculating (e.g. for disambiguating users with the same name).
     * @fires module:client~MatrixClient#event:"RoomMember.name"
     */
    setMembershipEvent: function(event, roomState) {
        if (event.getType() !== "m.room.member") {
            return;
        }
        var displayName = event.getContent().displayname;
        var selfUserId = this.userId;
        if (!displayName) {
            this.name = selfUserId;
            return;
        }
        if (!roomState) {
            this.name = displayName;
            return;
        }

        var stateEvents = utils.filter(
            roomState.getStateEvents("m.room.member"),
            function(e) {
                return e.getContent().displayname === displayName &&
                    e.getSender() !== selfUserId;
            }
        );
        if (stateEvents.length > 1) {
            this.name = displayName + " (" + selfUserId + ")";
            return;
        }

        this.name = displayName;
    },

    /**
     * Update this room member's power level event. May fire
     * "RoomMember.powerLevel" if this event updates this member's power levels.
     * @param {MatrixEvent} powerLevelEvent The <code>m.room.power_levels</code>
     * event
     * @fires module:client~MatrixClient#event:"RoomMember.powerLevel"
     */
    setPowerLevelEvent: function(powerLevelEvent) {
        if (powerLevelEvent.getType() !== "m.room.power_levels") {
            return;
        }
        var maxLevel = powerLevelEvent.getContent().users_default || 0;
        utils.forEach(utils.values(powerLevelEvent.getContent().users), function(lvl) {
            maxLevel = Math.max(maxLevel, lvl);
        });
        this.powerLevel = (
            powerLevelEvent.getContent().users[this.userId] ||
            powerLevelEvent.getContent().users_default ||
            0
        );
        this.powerLevelNorm = 0;
        if (maxLevel > 0) {
            this.powerLevelNorm = (this.powerLevel * 100) / maxLevel;
        }
    },

    /**
     * Update this room member's typing event. May fire "RoomMember.typing" if
     * this event changes this member's typing state.
     * @param {MatrixEvent} event The typing event
     * @fires module:client~MatrixClient#event:"RoomMember.typing"
     */
    setTypingEvent: function(event) {
        if (event.getType() !== "m.typing") {
            return;
        }
        this.typing = false;
        var typingList = event.getContent().user_ids;
        if (!utils.isArray(typingList)) {
            // malformed event :/ bail early. TODO: whine?
            return;
        }
        if (typingList.indexOf(this.userId) !== -1) {
            this.typing = true;
        }
    },

    /**
     * Get the membership state of this room member.
     * @return {string} The membership state e.g. 'join'.
     */
    getMembershipState: function() {
        return this.event.getContent().membership;
    }
};

/**
 * The RoomMember class.
 */
module.exports = RoomMember;
