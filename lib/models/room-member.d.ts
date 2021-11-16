/// <reference types="node" />
/**
 * @module models/room-member
 */
import { EventEmitter } from "events";
import { User } from "./user";
import { MatrixEvent } from "./event";
import { RoomState } from "./room-state";
export declare class RoomMember extends EventEmitter {
    readonly roomId: string;
    readonly userId: string;
    private _isOutOfBand;
    private _modified;
    _requestedProfileInfo: boolean;
    typing: boolean;
    name: string;
    rawDisplayName: string;
    powerLevel: number;
    powerLevelNorm: number;
    user?: User;
    membership: string;
    disambiguate: boolean;
    events: {
        member?: MatrixEvent;
    };
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
     * @prop {boolean} disambiguate True if the member's name is disambiguated.
     */
    constructor(roomId: string, userId: string);
    /**
     * Mark the member as coming from a channel that is not sync
     */
    markOutOfBand(): void;
    /**
     * @return {boolean} does the member come from a channel that is not sync?
     * This is used to store the member seperately
     * from the sync state so it available across browser sessions.
     */
    isOutOfBand(): boolean;
    /**
     * Update this room member's membership event. May fire "RoomMember.name" if
     * this event updates this member's name.
     * @param {MatrixEvent} event The <code>m.room.member</code> event
     * @param {RoomState} roomState Optional. The room state to take into account
     * when calculating (e.g. for disambiguating users with the same name).
     * @fires module:client~MatrixClient#event:"RoomMember.name"
     * @fires module:client~MatrixClient#event:"RoomMember.membership"
     */
    setMembershipEvent(event: MatrixEvent, roomState?: RoomState): void;
    /**
     * Update this room member's power level event. May fire
     * "RoomMember.powerLevel" if this event updates this member's power levels.
     * @param {MatrixEvent} powerLevelEvent The <code>m.room.power_levels</code>
     * event
     * @fires module:client~MatrixClient#event:"RoomMember.powerLevel"
     */
    setPowerLevelEvent(powerLevelEvent: MatrixEvent): void;
    /**
     * Update this room member's typing event. May fire "RoomMember.typing" if
     * this event changes this member's typing state.
     * @param {MatrixEvent} event The typing event
     * @fires module:client~MatrixClient#event:"RoomMember.typing"
     */
    setTypingEvent(event: MatrixEvent): void;
    /**
     * Update the last modified time to the current time.
     */
    private updateModifiedTime;
    /**
     * Get the timestamp when this RoomMember was last updated. This timestamp is
     * updated when properties on this RoomMember are updated.
     * It is updated <i>before</i> firing events.
     * @return {number} The timestamp
     */
    getLastModifiedTime(): number;
    isKicked(): boolean;
    /**
     * If this member was invited with the is_direct flag set, return
     * the user that invited this member
     * @return {string} user id of the inviter
     */
    getDMInviter(): string;
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
    getAvatarUrl(baseUrl: string, width: number, height: number, resizeMethod: string, allowDefault: boolean, allowDirectLinks: boolean): string | null;
    /**
     * get the mxc avatar url, either from a state event, or from a lazily loaded member
     * @return {string} the mxc avatar url
     */
    getMxcAvatarUrl(): string | null;
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
//# sourceMappingURL=room-member.d.ts.map