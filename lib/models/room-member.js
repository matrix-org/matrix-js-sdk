"use strict";
/**
 * @module models/room-member
 */
var utils = require("../utils");

/**
 * Construct a new room member.
 * @constructor
 * @param {MatrixEvent} event The <code>m.room.member</code> event.
 * @prop {string} roomId The room ID for this member.
 * @prop {string} userId The user ID of this member.
 * @prop {MatrixEvent} event The <code>m.room.member</code> event.
 * @prop {boolean} typing True if the room member is currently typing.
 * @prop {string} name The human-readable name for this room member.
 * @prop {Number} powerLevel The power level for this room member.
 * @prop {Number} powerLevelNorm The normalised power level (0-100) for this
 * room member.
 * @prop {User} user The User object for this room member, if one exists.
 * @throws If the event provided is not <code>m.room.member</code>
 */
function RoomMember(event) {
    if (event.getType() !== "m.room.member") {
        throw new Error("Invalid event type: " + event.getType());
    }
    this.roomId = event.getRoomId();
    this.userId = event.getStateKey();
    this.event = event;
    this.typing = false;
    this.name = this.calculateDisplayName();
    this.powerLevel = 0;
    this.powerLevelNorm = 0;
    this.user = null;
}
RoomMember.prototype = {

    /**
     * Get the membership state of this room member.
     * @return {string} The membership state e.g. 'join'.
     */
    getMembershipState: function() {
        return this.event.getContent().membership;
    },

    /**
     * Calculates the display name for this room member.
     * @param {RoomState} roomState Optional. The room state to take into
     * account when calculating (e.g. for disambiguating users with the same
     * name).
     * @return {string} The calculated display name.
     */
    calculateDisplayName: function(roomState) {
        var displayName = this.event.getContent().displayname;
        var selfUserId = this.userId;
        if (!displayName) {
            return selfUserId;
        }
        if (!roomState) {
            return displayName;
        }

        var stateEvents = utils.filter(
            roomState.getStateEvents("m.room.member"),
            function(event) {
                return event.getContent().displayname === displayName &&
                    event.getSender() !== selfUserId;
            }
        );
        if (stateEvents.length > 1) {
            return displayName + " (" + selfUserId + ")";
        }

        return displayName;
    }
};

/**
 * The RoomMember class.
 */
module.exports = RoomMember;
