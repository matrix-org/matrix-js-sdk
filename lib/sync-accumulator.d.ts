import { IContent, IUnsigned } from "./models/event";
import { IRoomSummary } from "./models/room-summary";
import { EventType } from "./@types/event";
interface IOpts {
    maxTimelineEntries?: number;
}
export interface IMinimalEvent {
    content: IContent;
    type: EventType | string;
}
export interface IEphemeral {
    events: IMinimalEvent[];
}
interface IUnreadNotificationCounts {
    highlight_count?: number;
    notification_count?: number;
}
export interface IRoomEvent extends IMinimalEvent {
    event_id: string;
    sender: string;
    origin_server_ts: number;
    unsigned?: IUnsigned;
    /** @deprecated - legacy field */
    age?: number;
}
export interface IStateEvent extends IRoomEvent {
    prev_content?: IContent;
    state_key: string;
}
interface IState {
    events: IStateEvent[];
}
export interface ITimeline {
    events: Array<IRoomEvent | IStateEvent>;
    limited?: boolean;
    prev_batch: string;
}
export interface IJoinedRoom {
    summary: IRoomSummary;
    state: IState;
    timeline: ITimeline;
    ephemeral: IEphemeral;
    account_data: IAccountData;
    unread_notifications: IUnreadNotificationCounts;
}
export interface IStrippedState {
    content: IContent;
    state_key: string;
    type: EventType | string;
    sender: string;
}
export interface IInviteState {
    events: IStrippedState[];
}
export interface IInvitedRoom {
    invite_state: IInviteState;
}
export interface ILeftRoom {
    state: IState;
    timeline: ITimeline;
    account_data: IAccountData;
}
export interface IRooms {
    [Category.Join]: Record<string, IJoinedRoom>;
    [Category.Invite]: Record<string, IInvitedRoom>;
    [Category.Leave]: Record<string, ILeftRoom>;
}
interface IPresence {
    events: IMinimalEvent[];
}
interface IAccountData {
    events: IMinimalEvent[];
}
interface IToDeviceEvent {
    content: IContent;
    sender: string;
    type: string;
}
interface IToDevice {
    events: IToDeviceEvent[];
}
interface IDeviceLists {
    changed: string[];
    left: string[];
}
export interface IGroups {
    [Category.Join]: object;
    [Category.Invite]: object;
    [Category.Leave]: object;
}
export interface ISyncResponse {
    next_batch: string;
    rooms: IRooms;
    presence?: IPresence;
    account_data: IAccountData;
    to_device?: IToDevice;
    device_lists?: IDeviceLists;
    device_one_time_keys_count?: Record<string, number>;
    groups: IGroups;
}
export declare enum Category {
    Invite = "invite",
    Leave = "leave",
    Join = "join"
}
export interface ISyncData {
    nextBatch: string;
    accountData: IMinimalEvent[];
    roomsData: IRooms;
    groupsData: IGroups;
}
/**
 * The purpose of this class is to accumulate /sync responses such that a
 * complete "initial" JSON response can be returned which accurately represents
 * the sum total of the /sync responses accumulated to date. It only handles
 * room data: that is, everything under the "rooms" top-level key.
 *
 * This class is used when persisting room data so a complete /sync response can
 * be loaded from disk and incremental syncs can be performed on the server,
 * rather than asking the server to do an initial sync on startup.
 */
export declare class SyncAccumulator {
    private readonly opts;
    private accountData;
    private inviteRooms;
    private joinRooms;
    private nextBatch;
    private groups;
    /**
     * @param {Object} opts
     * @param {Number=} opts.maxTimelineEntries The ideal maximum number of
     * timeline entries to keep in the sync response. This is best-effort, as
     * clients do not always have a back-pagination token for each event, so
     * it's possible there may be slightly *less* than this value. There will
     * never be more. This cannot be 0 or else it makes it impossible to scroll
     * back in a room. Default: 50.
     */
    constructor(opts?: IOpts);
    accumulate(syncResponse: ISyncResponse, fromDatabase?: boolean): void;
    private accumulateAccountData;
    /**
     * Accumulate incremental /sync room data.
     * @param {Object} syncResponse the complete /sync JSON
     * @param {boolean} fromDatabase True if the sync response is one saved to the database
     */
    private accumulateRooms;
    private accumulateRoom;
    private accumulateInviteState;
    private accumulateJoinState;
    /**
     * Accumulate incremental /sync group data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    private accumulateGroups;
    private accumulateGroup;
    /**
     * Return everything under the 'rooms' key from a /sync response which
     * represents all room data that should be stored. This should be paired
     * with the sync token which represents the most recent /sync response
     * provided to accumulate().
     * @param {boolean} forDatabase True to generate a sync to be saved to storage
     * @return {Object} An object with a "nextBatch", "roomsData" and "accountData"
     * keys.
     * The "nextBatch" key is a string which represents at what point in the
     * /sync stream the accumulator reached. This token should be used when
     * restarting a /sync stream at startup. Failure to do so can lead to missing
     * events. The "roomsData" key is an Object which represents the entire
     * /sync response from the 'rooms' key onwards. The "accountData" key is
     * a list of raw events which represent global account data.
     */
    getJSON(forDatabase?: boolean): ISyncData;
    getNextBatchToken(): string;
}
export {};
//# sourceMappingURL=sync-accumulator.d.ts.map