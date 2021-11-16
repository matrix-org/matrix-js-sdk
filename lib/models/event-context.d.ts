import { MatrixEvent } from "./event";
/**
 * @module models/event-context
 */
export declare class EventContext {
    private timeline;
    private ourEventIndex;
    private paginateTokens;
    /**
     * Construct a new EventContext
     *
     * An eventcontext is used for circumstances such as search results, when we
     * have a particular event of interest, and a bunch of events before and after
     * it.
     *
     * It also stores pagination tokens for going backwards and forwards in the
     * timeline.
     *
     * @param {MatrixEvent} ourEvent  the event at the centre of this context
     *
     * @constructor
     */
    constructor(ourEvent: MatrixEvent);
    /**
     * Get the main event of interest
     *
     * This is a convenience function for getTimeline()[getOurEventIndex()].
     *
     * @return {MatrixEvent} The event at the centre of this context.
     */
    getEvent(): MatrixEvent;
    /**
     * Get the list of events in this context
     *
     * @return {Array} An array of MatrixEvents
     */
    getTimeline(): MatrixEvent[];
    /**
     * Get the index in the timeline of our event
     *
     * @return {Number}
     */
    getOurEventIndex(): number;
    /**
     * Get a pagination token.
     *
     * @param {boolean} backwards   true to get the pagination token for going
     *                                  backwards in time
     * @return {string}
     */
    getPaginateToken(backwards?: boolean): string;
    /**
     * Set a pagination token.
     *
     * Generally this will be used only by the matrix js sdk.
     *
     * @param {string} token        pagination token
     * @param {boolean} backwards   true to set the pagination token for going
     *                                   backwards in time
     */
    setPaginateToken(token: string, backwards?: boolean): void;
    /**
     * Add more events to the timeline
     *
     * @param {Array} events      new events, in timeline order
     * @param {boolean} atStart   true to insert new events at the start
     */
    addEvents(events: MatrixEvent[], atStart?: boolean): void;
}
//# sourceMappingURL=event-context.d.ts.map