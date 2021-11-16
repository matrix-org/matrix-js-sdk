/**
 * @module models/room-summary
 */
export interface IRoomSummary {
    "m.heroes": string[];
    "m.joined_member_count": number;
    "m.invited_member_count": number;
}
interface IInfo {
    title: string;
    desc?: string;
    numMembers?: number;
    aliases?: string[];
    timestamp?: number;
}
/**
 * Construct a new Room Summary. A summary can be used for display on a recent
 * list, without having to load the entire room list into memory.
 * @constructor
 * @param {string} roomId Required. The ID of this room.
 * @param {Object} info Optional. The summary info. Additional keys are supported.
 * @param {string} info.title The title of the room (e.g. <code>m.room.name</code>)
 * @param {string} info.desc The description of the room (e.g.
 * <code>m.room.topic</code>)
 * @param {Number} info.numMembers The number of joined users.
 * @param {string[]} info.aliases The list of aliases for this room.
 * @param {Number} info.timestamp The timestamp for this room.
 */
export declare class RoomSummary {
    readonly roomId: string;
    constructor(roomId: string, info?: IInfo);
}
export {};
//# sourceMappingURL=room-summary.d.ts.map