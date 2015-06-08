"use strict";
/**
 * @module models/room-member
 */

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
 * @throws If the event provided is not <code>m.room.member</code>
 */
function RoomMember(event) {
    if (event.getType() !== "m.room.member") {
        throw new Error("Invalid event type: " + event.getType());
    }
    this.roomId = event.getRoomId();
    this.userId = event.getSender();
    this.event = event;
    this.typing = false;
    this.name = this.userId;
    this.powerLevel = 0;
    this.powerLevelNorm = 0;
}

/**
 * The RoomMember class.
 */
module.exports = RoomMember;
