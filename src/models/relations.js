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

/**
 * A container for relation events that supports easy access to common ways of
 * aggregating such events. Each instance holds events that of a single relation
 * type and event type. All of the events also relate to the same original event.
 *
 * The typical way to get one of these containers is via
 * EventTimelineSet#getRelationsForEvent.
 */
export default class Relations {
    /**
     * @param {String} relationType
     * The type of relation involved, such as "m.annotation", "m.reference",
     * "m.replace", etc.
     * @param {String} eventType
     * The relation event's type, such as "m.reaction", etc.
     */
    constructor(relationType, eventType) {
        this.relationType = relationType;
        this.eventType = eventType;
        this._events = [];
        this._annotationsByKey = {};
        this._annotationsBySender = {};
        this._sortedAnnotationsByKey = [];
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

        this._events.push(event);
    }

    /**
     * Get all events in this collection.
     *
     * These are currently in the order of insertion to this collection, which
     * won't match timeline order in the case of scrollback.
     * TODO: Tweak `addEvent` to insert correctly for scrollback.
     *
     * @return {Array}
     * Relation events in insertion order.
     */
    getEvents() {
        return this._events;
    }

    _aggregateAnnotation(key, event) {
        if (!key) {
            return;
        }

        let eventsForKey = this._annotationsByKey[key];
        if (!eventsForKey) {
            eventsForKey = this._annotationsByKey[key] = [];
            this._sortedAnnotationsByKey.push([key, eventsForKey]);
        }
        // Add the new event to the list for this key
        eventsForKey.push(event);
        // Re-sort the [key, events] pairs in descending order of event count
        this._sortedAnnotationsByKey.sort((a, b) => {
            const aEvents = a[1];
            const bEvents = b[1];
            return bEvents.length - aEvents.length;
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
     * Get all events in this collection grouped by key and sorted by descending
     * event count in each group.
     *
     * This is currently only supported for the annotation relation type.
     *
     * @return {Array}
     * An array of [key, events] pairs sorted by descending event count.
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
