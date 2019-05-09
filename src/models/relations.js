/*
Copyright 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import EventEmitter from 'events';

/**
 * A container for relation events that supports easy access to common ways of
 * aggregating such events. Each instance holds events that of a single relation
 * type and event type. All of the events also relate to the same original event.
 *
 * The typical way to get one of these containers is via
 * EventTimelineSet#getRelationsForEvent.
 */
export default class Relations extends EventEmitter {
    /**
     * @param {String} relationType
     * The type of relation involved, such as "m.annotation", "m.reference",
     * "m.replace", etc.
     * @param {String} eventType
     * The relation event's type, such as "m.reaction", etc.
     * @param {?Room} room
     * Room for this container. May be null for non-room cases, such as the
     * notification timeline.
     */
    constructor(relationType, eventType, room) {
        super();
        this.relationType = relationType;
        this.eventType = eventType;
        this._relations = new Set();
        this._annotationsByKey = {};
        this._annotationsBySender = {};
        this._sortedAnnotationsByKey = [];

        if (room) {
            room.on("Room.beforeRedaction", this._onBeforeRedaction);
        }
    }

    /**
     * Add relation events to this collection.
     *
     * @param {MatrixEvent} event
     * The new relation event to be aggregated.
     */
    addEvent(event) {
        const content = event.getContent();
        const relation = content && content["m.relates_to"];
        if (!relation || !relation.rel_type || !relation.event_id) {
            console.error("Event must have relation info");
            return;
        }

        const relationType = relation.rel_type;
        const eventType = event.getType();

        if (this.relationType !== relationType || this.eventType !== eventType) {
            console.error("Event relation info doesn't match this container");
            return;
        }

        if (this.relationType === "m.annotation") {
            const key = relation.key;
            this._aggregateAnnotation(key, event);
        }

        this._relations.add(event);

        this.emit("Relations.add", event);
    }

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
    getRelations() {
        return [...this._relations];
    }

    _aggregateAnnotation(key, event) {
        if (!key) {
            return;
        }

        let eventsForKey = this._annotationsByKey[key];
        if (!eventsForKey) {
            eventsForKey = this._annotationsByKey[key] = new Set();
            this._sortedAnnotationsByKey.push([key, eventsForKey]);
        }
        // Add the new event to the set for this key
        eventsForKey.add(event);
        // Re-sort the [key, events] pairs in descending order of event count
        this._sortedAnnotationsByKey.sort((a, b) => {
            const aEvents = a[1];
            const bEvents = b[1];
            return bEvents.size - aEvents.size;
        });

        const sender = event.getSender();
        let eventsFromSender = this._annotationsBySender[sender];
        if (!eventsFromSender) {
            eventsFromSender = this._annotationsBySender[sender] = [];
        }
        // Add the new event to the list for this sender
        eventsFromSender.push(event);
    }

    /**
     * For relations that are about to be redacted, remove them from aggregation
     * data sets and emit an update event.
     *
     * @param {MatrixEvent} redactedEvent
     * The original relation event that is about to be redacted.
     */
    _onBeforeRedaction = (redactedEvent) => {
        if (!this._relations.has(redactedEvent)) {
            return;
        }

        if (this.relationType === "m.annotation") {
            // Remove the redacted annotation from aggregation by key
            const content = redactedEvent.getContent();
            const relation = content && content["m.relates_to"];
            if (!relation) {
                return;
            }

            const key = relation.key;
            const eventsForKey = this._annotationsByKey[key];
            if (!eventsForKey) {
                return;
            }
            eventsForKey.delete(redactedEvent);

            // Re-sort the [key, events] pairs in descending order of event count
            this._sortedAnnotationsByKey.sort((a, b) => {
                const aEvents = a[1];
                const bEvents = b[1];
                return bEvents.size - aEvents.size;
            });
        }

        // Dispatch a redaction event on this collection. `setTimeout` is used
        // to wait until the next event loop iteration by which time the event
        // has actually been marked as redacted.
        setTimeout(() => {
            this.emit("Relations.redaction");
        }, 0);
    }

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
    getSortedAnnotationsByKey() {
        if (this.relationType !== "m.annotation") {
            // Other relation types are not grouped currently.
            return null;
        }

        return this._sortedAnnotationsByKey;
    }

    /**
     * Get all events in this collection grouped by sender.
     *
     * This is currently only supported for the annotation relation type.
     *
     * @return {Object}
     * An object with each relation sender as a key and the matching list of
     * events for that sender as a value.
     */
    getAnnotationsBySender() {
        if (this.relationType !== "m.annotation") {
            // Other relation types are not grouped currently.
            return null;
        }

        return this._annotationsBySender;
    }
}
