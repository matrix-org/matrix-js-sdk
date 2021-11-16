/**
 * @module filter
 */
import { FilterComponent, IFilterComponent } from "./filter-component";
import { MatrixEvent } from "./models/event";
export interface IFilterDefinition {
    event_fields?: string[];
    event_format?: "client" | "federation";
    presence?: IFilterComponent;
    account_data?: IFilterComponent;
    room?: IRoomFilter;
}
export interface IRoomEventFilter extends IFilterComponent {
    lazy_load_members?: boolean;
    include_redundant_members?: boolean;
}
interface IStateFilter extends IRoomEventFilter {
}
interface IRoomFilter {
    not_rooms?: string[];
    rooms?: string[];
    ephemeral?: IRoomEventFilter;
    include_leave?: boolean;
    state?: IStateFilter;
    timeline?: IRoomEventFilter;
    account_data?: IRoomEventFilter;
}
/**
 * Construct a new Filter.
 * @constructor
 * @param {string} userId The user ID for this filter.
 * @param {string=} filterId The filter ID if known.
 * @prop {string} userId The user ID of the filter
 * @prop {?string} filterId The filter ID
 */
export declare class Filter {
    readonly userId: string;
    filterId?: string;
    static LAZY_LOADING_MESSAGES_FILTER: {
        lazy_load_members: boolean;
    };
    /**
     * Create a filter from existing data.
     * @static
     * @param {string} userId
     * @param {string} filterId
     * @param {Object} jsonObj
     * @return {Filter}
     */
    static fromJson(userId: string, filterId: string, jsonObj: IFilterDefinition): Filter;
    private definition;
    private roomFilter;
    private roomTimelineFilter;
    constructor(userId: string, filterId?: string);
    /**
     * Get the ID of this filter on your homeserver (if known)
     * @return {?string} The filter ID
     */
    getFilterId(): string | null;
    /**
     * Get the JSON body of the filter.
     * @return {Object} The filter definition
     */
    getDefinition(): IFilterDefinition;
    /**
     * Set the JSON body of the filter
     * @param {Object} definition The filter definition
     */
    setDefinition(definition: IFilterDefinition): void;
    /**
     * Get the room.timeline filter component of the filter
     * @return {FilterComponent} room timeline filter component
     */
    getRoomTimelineFilterComponent(): FilterComponent;
    /**
     * Filter the list of events based on whether they are allowed in a timeline
     * based on this filter
     * @param {MatrixEvent[]} events  the list of events being filtered
     * @return {MatrixEvent[]} the list of events which match the filter
     */
    filterRoomTimeline(events: MatrixEvent[]): MatrixEvent[];
    /**
     * Set the max number of events to return for each room's timeline.
     * @param {Number} limit The max number of events to return for each room.
     */
    setTimelineLimit(limit: number): void;
    setLazyLoadMembers(enabled: boolean): void;
    /**
     * Control whether left rooms should be included in responses.
     * @param {boolean} includeLeave True to make rooms the user has left appear
     * in responses.
     */
    setIncludeLeaveRooms(includeLeave: boolean): void;
}
export {};
//# sourceMappingURL=filter.d.ts.map