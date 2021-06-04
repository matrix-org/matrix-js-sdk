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

import { EventEmitter } from 'events';
import { EventStatus } from '../models/event';
import { logger } from '../logger';

/**
 * A container for relation events that supports easy access to common ways of
 * aggregating such events. Each instance holds events that of a single relation
 * type and event type. All of the events also relate to the same original event.
 *
 * The typical way to get one of these containers is via
 * EventTimelineSet#getRelationsForEvent.
 */
export class Relations extends EventEmitter {
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
        this._relationEventIds = new Set();
        this._relations = new Set();
        this._annotationsByKey = {};
        this._annotationsBySender = {};
        this._sortedAnnotationsByKey = [];
        this._targetEvent = null;
        this._room = room;
        this._creationEmitted = false;
    }

    /**
     * Add relation events to this collection.
     *
     * @param {MatrixEvent} event
     * The new relation event to be added.
     */
    async addEvent(event) {
        if (this._relationEventIds.has(event.getId())) {
            return;
        }

        const relation = event.getRelation();
        if (!relation) {
            logger.error("Event must have relation info");
            return;
        }

        const relationType = relation.rel_type;
        const eventType = event.getType();

        if (this.relationType !== relationType || this.eventType !== eventType) {
            logger.error("Event relation info doesn't match this container");
            return;
        }

        // If the event is in the process of being sent, listen for cancellation
        // so we can remove the event from the collection.
        if (event.isSending()) {
            event.on("Event.status", this._onEventStatus);
        }

        this._relations.add(event);
        this._relationEventIds.add(event.getId());

        if (this.relationType === "m.annotation") {
            this._addAnnotationToAggregation(event);
        } else if (this.relationType === "m.replace" && this._targetEvent) {
            const lastReplacement = await this.getLastReplacement();
            this._targetEvent.makeReplaced(lastReplacement);
        }

        event.on("Event.beforeRedaction", this._onBeforeRedaction);

        this.emit("Relations.add", event);

        this._maybeEmitCreated();
    }

    /**
     * Remove relation event from this collection.
     *
     * @param {MatrixEvent} event
     * The relation event to remove.
     */
    async _removeEvent(event) {
        if (!this._relations.has(event)) {
            return;
        }

        const relation = event.getRelation();
        if (!relation) {
            logger.error("Event must have relation info");
            return;
        }

        const relationType = relation.rel_type;
        const eventType = event.getType();

        if (this.relationType !== relationType || this.eventType !== eventType) {
            logger.error("Event relation info doesn't match this container");
            return;
        }

        this._relations.delete(event);

        if (this.relationType === "m.annotation") {
            this._removeAnnotationFromAggregation(event);
        } else if (this.relationType === "m.replace" && this._targetEvent) {
            const lastReplacement = await this.getLastReplacement();
            this._targetEvent.makeReplaced(lastReplacement);
        }

        this.emit("Relations.remove", event);
    }

    /**
     * Listens for event status changes to remove cancelled events.
     *
     * @param {MatrixEvent} event The event whose status has changed
     * @param {EventStatus} status The new status
     */
    _onEventStatus = (event, status) => {
        if (!event.isSending()) {
            // Sending is done, so we don't need to listen anymore
            event.removeListener("Event.status", this._onEventStatus);
            return;
        }
        if (status !== EventStatus.CANCELLED) {
            return;
        }
        // Event was cancelled, remove from the collection
        event.removeListener("Event.status", this._onEventStatus);
        this._removeEvent(event);
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

    _addAnnotationToAggregation(event) {
        const { key } = event.getRelation();
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
            eventsFromSender = this._annotationsBySender[sender] = new Set();
        }
        // Add the new event to the set for this sender
        eventsFromSender.add(event);
    }

    _removeAnnotationFromAggregation(event) {
        const { key } = event.getRelation();
        if (!key) {
            return;
        }

        const eventsForKey = this._annotationsByKey[key];
        if (eventsForKey) {
            eventsForKey.delete(event);

            // Re-sort the [key, events] pairs in descending order of event count
            this._sortedAnnotationsByKey.sort((a, b) => {
                const aEvents = a[1];
                const bEvents = b[1];
                return bEvents.size - aEvents.size;
            });
        }

        const sender = event.getSender();
        const eventsFromSender = this._annotationsBySender[sender];
        if (eventsFromSender) {
            eventsFromSender.delete(event);
        }
    }

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
    _onBeforeRedaction = async (redactedEvent) => {
        if (!this._relations.has(redactedEvent)) {
            return;
        }

        this._relations.delete(redactedEvent);

        if (this.relationType === "m.annotation") {
            // Remove the redacted annotation from aggregation by key
            this._removeAnnotationFromAggregation(redactedEvent);
        } else if (this.relationType === "m.replace" && this._targetEvent) {
            const lastReplacement = await this.getLastReplacement();
            this._targetEvent.makeReplaced(lastReplacement);
        }

        redactedEvent.removeListener("Event.beforeRedaction", this._onBeforeRedaction);

        this.emit("Relations.redaction", redactedEvent);
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
     * An object with each relation sender as a key and the matching Set of
     * events for that sender as a value.
     */
    getAnnotationsBySender() {
        if (this.relationType !== "m.annotation") {
            // Other relation types are not grouped currently.
            return null;
        }

        return this._annotationsBySender;
    }

    /**
     * Returns the most recent (and allowed) m.replace relation, if any.
     *
     * This is currently only supported for the m.replace relation type,
     * once the target event is known, see `addEvent`.
     *
     * @return {MatrixEvent?}
     */
    async getLastReplacement() {
        if (this.relationType !== "m.replace") {
            // Aggregating on last only makes sense for this relation type
            return null;
        }
        if (!this._targetEvent) {
            // Don't know which replacements to accept yet.
            // This method shouldn't be called before the original
            // event is known anyway.
            return null;
        }

        // the all-knowning server tells us that the event at some point had
        // this timestamp for its replacement, so any following replacement should definitely not be less
        const replaceRelation =
            this._targetEvent.getServerAggregatedRelation("m.replace");
        const minTs = replaceRelation && replaceRelation.origin_server_ts;

        const lastReplacement = this.getRelations().reduce((last, event) => {
            if (event.getSender() !== this._targetEvent.getSender()) {
                return last;
            }
            if (minTs && minTs > event.getTs()) {
                return last;
            }
            if (last && last.getTs() > event.getTs()) {
                return last;
            }
            return event;
        }, null);

        if (lastReplacement?.shouldAttemptDecryption()) {
            await lastReplacement.attemptDecryption(this._room._client.crypto);
        } else if (lastReplacement?.isBeingDecrypted()) {
            await lastReplacement._decryptionPromise;
        }

        return lastReplacement;
    }

    /*
     * @param {MatrixEvent} targetEvent the event the relations are related to.
     */
    async setTargetEvent(event) {
        if (this._targetEvent) {
            return;
        }
        this._targetEvent = event;

        if (this.relationType === "m.replace") {
            const replacement = await this.getLastReplacement();
            // this is the initial update, so only call it if we already have something
            // to not emit Event.replaced needlessly
            if (replacement) {
                this._targetEvent.makeReplaced(replacement);
            }
        }

        this._maybeEmitCreated();
    }

    _maybeEmitCreated() {
        if (this._creationEmitted) {
            return;
        }
        // Only emit we're "created" once we have a target event instance _and_
        // at least one related event.
        if (!this._targetEvent || !this._relations.size) {
            return;
        }
        this._creationEmitted = true;
        this._targetEvent.emit(
            "Event.relationsCreated",
            this.relationType,
            this.eventType,
        );
    }
}
