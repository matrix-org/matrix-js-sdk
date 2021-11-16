/**
 * @module models/event-timeline
 */
import { RoomState } from "./room-state";
import { EventTimelineSet } from "./event-timeline-set";
import { MatrixEvent } from "./event";
import { Filter } from "../filter";
export declare enum Direction {
    Backward = "b",
    Forward = "f"
}
export declare class EventTimeline {
    private readonly eventTimelineSet;
    /**
     * Symbolic constant for methods which take a 'direction' argument:
     * refers to the start of the timeline, or backwards in time.
     */
    static BACKWARDS: Direction;
    /**
     * Symbolic constant for methods which take a 'direction' argument:
     * refers to the end of the timeline, or forwards in time.
     */
    static FORWARDS: Direction;
    /**
     * Static helper method to set sender and target properties
     *
     * @param {MatrixEvent} event   the event whose metadata is to be set
     * @param {RoomState} stateContext  the room state to be queried
     * @param {boolean} toStartOfTimeline  if true the event's forwardLooking flag is set false
     */
    static setEventMetadata(event: MatrixEvent, stateContext: RoomState, toStartOfTimeline: boolean): void;
    private readonly roomId;
    private readonly name;
    private events;
    private baseIndex;
    private startState;
    private endState;
    private prevTimeline?;
    private nextTimeline?;
    paginationRequests: Record<Direction, Promise<boolean>>;
    /**
     * Construct a new EventTimeline
     *
     * <p>An EventTimeline represents a contiguous sequence of events in a room.
     *
     * <p>As well as keeping track of the events themselves, it stores the state of
     * the room at the beginning and end of the timeline, and pagination tokens for
     * going backwards and forwards in the timeline.
     *
     * <p>In order that clients can meaningfully maintain an index into a timeline,
     * the EventTimeline object tracks a 'baseIndex'. This starts at zero, but is
     * incremented when events are prepended to the timeline. The index of an event
     * relative to baseIndex therefore remains constant.
     *
     * <p>Once a timeline joins up with its neighbour, they are linked together into a
     * doubly-linked list.
     *
     * @param {EventTimelineSet} eventTimelineSet the set of timelines this is part of
     * @constructor
     */
    constructor(eventTimelineSet: EventTimelineSet);
    /**
     * Initialise the start and end state with the given events
     *
     * <p>This can only be called before any events are added.
     *
     * @param {MatrixEvent[]} stateEvents list of state events to initialise the
     * state with.
     * @throws {Error} if an attempt is made to call this after addEvent is called.
     */
    initialiseState(stateEvents: MatrixEvent[]): void;
    /**
     * Forks the (live) timeline, taking ownership of the existing directional state of this timeline.
     * All attached listeners will keep receiving state updates from the new live timeline state.
     * The end state of this timeline gets replaced with an independent copy of the current RoomState,
     * and will need a new pagination token if it ever needs to paginate forwards.

     * @param {string} direction   EventTimeline.BACKWARDS to get the state at the
     *   start of the timeline; EventTimeline.FORWARDS to get the state at the end
     *   of the timeline.
     *
     * @return {EventTimeline} the new timeline
     */
    forkLive(direction: Direction): EventTimeline;
    /**
     * Creates an independent timeline, inheriting the directional state from this timeline.
     *
     * @param {string} direction   EventTimeline.BACKWARDS to get the state at the
     *   start of the timeline; EventTimeline.FORWARDS to get the state at the end
     *   of the timeline.
     *
     * @return {EventTimeline} the new timeline
     */
    fork(direction: Direction): EventTimeline;
    /**
     * Get the ID of the room for this timeline
     * @return {string} room ID
     */
    getRoomId(): string;
    /**
     * Get the filter for this timeline's timelineSet (if any)
     * @return {Filter} filter
     */
    getFilter(): Filter;
    /**
     * Get the timelineSet for this timeline
     * @return {EventTimelineSet} timelineSet
     */
    getTimelineSet(): EventTimelineSet;
    /**
     * Get the base index.
     *
     * <p>This is an index which is incremented when events are prepended to the
     * timeline. An individual event therefore stays at the same index in the array
     * relative to the base index (although note that a given event's index may
     * well be less than the base index, thus giving that event a negative relative
     * index).
     *
     * @return {number}
     */
    getBaseIndex(): number;
    /**
     * Get the list of events in this context
     *
     * @return {MatrixEvent[]} An array of MatrixEvents
     */
    getEvents(): MatrixEvent[];
    /**
     * Get the room state at the start/end of the timeline
     *
     * @param {string} direction   EventTimeline.BACKWARDS to get the state at the
     *   start of the timeline; EventTimeline.FORWARDS to get the state at the end
     *   of the timeline.
     *
     * @return {RoomState} state at the start/end of the timeline
     */
    getState(direction: Direction): RoomState;
    /**
     * Get a pagination token
     *
     * @param {string} direction   EventTimeline.BACKWARDS to get the pagination
     *   token for going backwards in time; EventTimeline.FORWARDS to get the
     *   pagination token for going forwards in time.
     *
     * @return {?string} pagination token
     */
    getPaginationToken(direction: Direction): string | null;
    /**
     * Set a pagination token
     *
     * @param {?string} token       pagination token
     *
     * @param {string} direction    EventTimeline.BACKWARDS to set the pagination
     *   token for going backwards in time; EventTimeline.FORWARDS to set the
     *   pagination token for going forwards in time.
     */
    setPaginationToken(token: string, direction: Direction): void;
    /**
     * Get the next timeline in the series
     *
     * @param {string} direction EventTimeline.BACKWARDS to get the previous
     *   timeline; EventTimeline.FORWARDS to get the next timeline.
     *
     * @return {?EventTimeline} previous or following timeline, if they have been
     * joined up.
     */
    getNeighbouringTimeline(direction: Direction): EventTimeline;
    /**
     * Set the next timeline in the series
     *
     * @param {EventTimeline} neighbour previous/following timeline
     *
     * @param {string} direction EventTimeline.BACKWARDS to set the previous
     *   timeline; EventTimeline.FORWARDS to set the next timeline.
     *
     * @throws {Error} if an attempt is made to set the neighbouring timeline when
     * it is already set.
     */
    setNeighbouringTimeline(neighbour: EventTimeline, direction: Direction): void;
    /**
     * Add a new event to the timeline, and update the state
     *
     * @param {MatrixEvent} event   new event
     * @param {boolean}  atStart     true to insert new event at the start
     */
    addEvent(event: MatrixEvent, atStart: boolean, stateContext?: RoomState): void;
    /**
     * Remove an event from the timeline
     *
     * @param {string} eventId  ID of event to be removed
     * @return {?MatrixEvent} removed event, or null if not found
     */
    removeEvent(eventId: string): MatrixEvent | null;
    /**
     * Return a string to identify this timeline, for debugging
     *
     * @return {string} name for this timeline
     */
    toString(): string;
}
//# sourceMappingURL=event-timeline.d.ts.map