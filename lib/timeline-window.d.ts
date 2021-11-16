/** @module timeline-window */
import { Direction, EventTimeline } from './models/event-timeline';
import { MatrixClient } from "./client";
import { EventTimelineSet } from "./models/event-timeline-set";
import { MatrixEvent } from "./models/event";
interface IOpts {
    windowLimit?: number;
}
export declare class TimelineWindow {
    private readonly client;
    private readonly timelineSet;
    private readonly windowLimit;
    private start?;
    private end?;
    private eventCount;
    /**
     * Construct a TimelineWindow.
     *
     * <p>This abstracts the separate timelines in a Matrix {@link
        * module:models/room|Room} into a single iterable thing. It keeps track of
     * the start and endpoints of the window, which can be advanced with the help
     * of pagination requests.
     *
     * <p>Before the window is useful, it must be initialised by calling {@link
        * module:timeline-window~TimelineWindow#load|load}.
     *
     * <p>Note that the window will not automatically extend itself when new events
     * are received from /sync; you should arrange to call {@link
        * module:timeline-window~TimelineWindow#paginate|paginate} on {@link
        * module:client~MatrixClient.event:"Room.timeline"|Room.timeline} events.
     *
     * @param {MatrixClient} client   MatrixClient to be used for context/pagination
     *   requests.
     *
     * @param {EventTimelineSet} timelineSet  The timelineSet to track
     *
     * @param {Object} [opts] Configuration options for this window
     *
     * @param {number} [opts.windowLimit = 1000] maximum number of events to keep
     *    in the window. If more events are retrieved via pagination requests,
     *    excess events will be dropped from the other end of the window.
     *
     * @constructor
     */
    constructor(client: MatrixClient, timelineSet: EventTimelineSet, opts?: IOpts);
    /**
     * Initialise the window to point at a given event, or the live timeline
     *
     * @param {string} [initialEventId]   If given, the window will contain the
     *    given event
     * @param {number} [initialWindowSize = 20]   Size of the initial window
     *
     * @return {Promise}
     */
    load(initialEventId: string, initialWindowSize?: number): Promise<any>;
    /**
     * Get the TimelineIndex of the window in the given direction.
     *
     * @param {string} direction   EventTimeline.BACKWARDS to get the TimelineIndex
     * at the start of the window; EventTimeline.FORWARDS to get the TimelineIndex at
     * the end.
     *
     * @return {TimelineIndex} The requested timeline index if one exists, null
     * otherwise.
     */
    getTimelineIndex(direction: Direction): TimelineIndex;
    /**
     * Try to extend the window using events that are already in the underlying
     * TimelineIndex.
     *
     * @param {string} direction   EventTimeline.BACKWARDS to try extending it
     *   backwards; EventTimeline.FORWARDS to try extending it forwards.
     * @param {number} size   number of events to try to extend by.
     *
     * @return {boolean} true if the window was extended, false otherwise.
     */
    extend(direction: Direction, size: number): boolean;
    /**
     * Check if this window can be extended
     *
     * <p>This returns true if we either have more events, or if we have a
     * pagination token which means we can paginate in that direction. It does not
     * necessarily mean that there are more events available in that direction at
     * this time.
     *
     * @param {string} direction   EventTimeline.BACKWARDS to check if we can
     *   paginate backwards; EventTimeline.FORWARDS to check if we can go forwards
     *
     * @return {boolean} true if we can paginate in the given direction
     */
    canPaginate(direction: Direction): boolean;
    /**
     * Attempt to extend the window
     *
     * @param {string} direction   EventTimeline.BACKWARDS to extend the window
     *    backwards (towards older events); EventTimeline.FORWARDS to go forwards.
     *
     * @param {number} size   number of events to try to extend by. If fewer than this
     *    number are immediately available, then we return immediately rather than
     *    making an API call.
     *
     * @param {boolean} [makeRequest = true] whether we should make API calls to
     *    fetch further events if we don't have any at all. (This has no effect if
     *    the room already knows about additional events in the relevant direction,
     *    even if there are fewer than 'size' of them, as we will just return those
     *    we already know about.)
     *
     * @param {number} [requestLimit = 5] limit for the number of API requests we
     *    should make.
     *
     * @return {Promise} Resolves to a boolean which is true if more events
     *    were successfully retrieved.
     */
    paginate(direction: Direction, size: number, makeRequest?: boolean, requestLimit?: number): Promise<boolean>;
    /**
     * Remove `delta` events from the start or end of the timeline.
     *
     * @param {number}  delta           number of events to remove from the timeline
     * @param {boolean} startOfTimeline if events should be removed from the start
     *     of the timeline.
     */
    unpaginate(delta: number, startOfTimeline: boolean): void;
    /**
     * Get a list of the events currently in the window
     *
     * @return {MatrixEvent[]} the events in the window
     */
    getEvents(): MatrixEvent[];
}
/**
 * a thing which contains a timeline reference, and an index into it.
 *
 * @constructor
 * @param {EventTimeline} timeline
 * @param {number} index
 * @private
 */
export declare class TimelineIndex {
    timeline: EventTimeline;
    index: number;
    pendingPaginate?: Promise<boolean>;
    constructor(timeline: EventTimeline, index: number);
    /**
     * @return {number} the minimum possible value for the index in the current
     *    timeline
     */
    minIndex(): number;
    /**
     * @return {number} the maximum possible value for the index in the current
     *    timeline (exclusive - ie, it actually returns one more than the index
     *    of the last element).
     */
    maxIndex(): number;
    /**
     * Try move the index forward, or into the neighbouring timeline
     *
     * @param {number} delta  number of events to advance by
     * @return {number} number of events successfully advanced by
     */
    advance(delta: number): number;
    /**
     * Try move the index backwards, or into the neighbouring timeline
     *
     * @param {number} delta  number of events to retreat by
     * @return {number} number of events successfully retreated by
     */
    retreat(delta: number): number;
}
export {};
//# sourceMappingURL=timeline-window.d.ts.map