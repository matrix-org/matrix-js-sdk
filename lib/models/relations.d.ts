/// <reference types="node" />
import { EventEmitter } from 'events';
import { MatrixEvent } from './event';
import { Room } from './room';
import { RelationType } from "../@types/event";
/**
 * A container for relation events that supports easy access to common ways of
 * aggregating such events. Each instance holds events that of a single relation
 * type and event type. All of the events also relate to the same original event.
 *
 * The typical way to get one of these containers is via
 * EventTimelineSet#getRelationsForEvent.
 */
export declare class Relations extends EventEmitter {
    readonly relationType: RelationType | string;
    readonly eventType: string;
    private readonly room;
    private relationEventIds;
    private relations;
    private annotationsByKey;
    private annotationsBySender;
    private sortedAnnotationsByKey;
    private targetEvent;
    private creationEmitted;
    /**
     * @param {RelationType} relationType
     * The type of relation involved, such as "m.annotation", "m.reference",
     * "m.replace", etc.
     * @param {String} eventType
     * The relation event's type, such as "m.reaction", etc.
     * @param {?Room} room
     * Room for this container. May be null for non-room cases, such as the
     * notification timeline.
     */
    constructor(relationType: RelationType | string, eventType: string, room: Room);
    /**
     * Add relation events to this collection.
     *
     * @param {MatrixEvent} event
     * The new relation event to be added.
     */
    addEvent(event: MatrixEvent): Promise<void>;
    /**
     * Remove relation event from this collection.
     *
     * @param {MatrixEvent} event
     * The relation event to remove.
     */
    private removeEvent;
    /**
     * Listens for event status changes to remove cancelled events.
     *
     * @param {MatrixEvent} event The event whose status has changed
     * @param {EventStatus} status The new status
     */
    private onEventStatus;
    /**
     * Get all relation events in this collection.
     *
     * These are currently in the order of insertion to this collection, which
     * won't match timeline order in the case of scrollback.
     * TODO: Tweak `addEvent` to insert correctly for scrollback.
     *
     * @return {Array}
     * Relation events in insertion order.
     */
    getRelations(): MatrixEvent[];
    private addAnnotationToAggregation;
    private removeAnnotationFromAggregation;
    /**
     * For relations that have been redacted, we want to remove them from
     * aggregation data sets and emit an update event.
     *
     * To do so, we listen for `Event.beforeRedaction`, which happens:
     *   - after the server accepted the redaction and remote echoed back to us
     *   - before the original event has been marked redacted in the client
     *
     * @param {MatrixEvent} redactedEvent
     * The original relation event that is about to be redacted.
     */
    private onBeforeRedaction;
    /**
     * Get all events in this collection grouped by key and sorted by descending
     * event count in each group.
     *
     * This is currently only supported for the annotation relation type.
     *
     * @return {Array}
     * An array of [key, events] pairs sorted by descending event count.
     * The events are stored in a Set (which preserves insertion order).
     */
    getSortedAnnotationsByKey(): [string, Set<MatrixEvent>][];
    /**
     * Get all events in this collection grouped by sender.
     *
     * This is currently only supported for the annotation relation type.
     *
     * @return {Object}
     * An object with each relation sender as a key and the matching Set of
     * events for that sender as a value.
     */
    getAnnotationsBySender(): Record<string, Set<MatrixEvent>>;
    /**
     * Returns the most recent (and allowed) m.replace relation, if any.
     *
     * This is currently only supported for the m.replace relation type,
     * once the target event is known, see `addEvent`.
     *
     * @return {MatrixEvent?}
     */
    getLastReplacement(): Promise<MatrixEvent | null>;
    setTargetEvent(event: MatrixEvent): Promise<void>;
    private maybeEmitCreated;
}
//# sourceMappingURL=relations.d.ts.map