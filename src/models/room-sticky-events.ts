import { logger as loggerInstance } from "../logger.ts";
import { type MatrixEvent } from "./event.ts";
import { TypedEventEmitter } from "./typed-event-emitter.ts";

const logger = loggerInstance.getChild("RoomStickyEvents");

export enum RoomStickyEventsEvent {
    Update = "RoomStickyEvents.Update",
}

export type StickyMatrixEvent = MatrixEvent & { unstableStickyExpiresAt: number };

export type RoomStickyEventsMap = {
    /**
     * Fires when any sticky event changes happen in a room.
     * @param added Any new sticky events with no predecessor events (matching sender, type, and sticky_key)
     * @param updated Any sticky events that supersede an existing event (matching sender, type, and sticky_key)
     * @param removed The events that were removed from the map due to expiry.
     */
    [RoomStickyEventsEvent.Update]: (
        added: StickyMatrixEvent[],
        updated: { current: StickyMatrixEvent; previous: StickyMatrixEvent }[],
        removed: StickyMatrixEvent[],
    ) => void;
};

type UserId = `@${string}`;

function assertIsUserId(value: unknown): asserts value is UserId {
    if (typeof value !== "string") throw new Error("Not a string");
    if (!value.startsWith("@")) throw new Error("Not a userId");
}

/**
 * Tracks sticky events on behalf of one room, and fires an event
 * whenever a sticky event is updated or replaced.
 */
export class RoomStickyEventsStore extends TypedEventEmitter<RoomStickyEventsEvent, RoomStickyEventsMap> {
    /**
     * Sticky event map is a nested map of:
     *  eventType -> `content.sticky_key sender` -> StickyMatrixEvent[]
     *
     * The events are ordered in latest to earliest expiry, so that the first event
     * in the array will always be the "current" one.
     */
    private readonly stickyEventsMap = new Map<string, Map<string, StickyMatrixEvent[]>>();
    /**
     * These are sticky events that have no sticky key and therefore exist outside the tuple
     * system above. They are just held in this Set until they expire.
     */
    private readonly unkeyedStickyEvents = new Set<StickyMatrixEvent>();

    private stickyEventTimer?: ReturnType<typeof setTimeout>;
    private nextStickyEventExpiryTs: number = Number.MAX_SAFE_INTEGER;

    /**
     * Sort two sticky events by order of expiry. This assumes the sticky events have the same
     * `type`, `sticky_key` and `sender`.
     * @returns A positive value if event A will expire sooner, or a negative value if event B will expire sooner.
     */
    private static sortStickyEvent(eventA: StickyMatrixEvent, eventB: StickyMatrixEvent): number {
        // Sticky events with the same key have to use the same expiration duration.
        // Hence, comparing via `origin_server_ts` yields the exact same result as comparing their expiration time.
        if (eventB.getTs() !== eventA.getTs()) {
            return eventB.getTs() - eventA.getTs();
        }

        if ((eventB.getId() ?? "") > (eventA.getId() ?? "")) {
            return 1;
        }

        // This should fail as we've got corruption in our sticky array.
        throw Error("Comparing two sticky events with the same event ID is not allowed.");
    }

    /**
     * Generate the correct key for an event to be found in the inner maps of `stickyEventsMap`.
     * @param stickyKey The sticky key of an event.
     * @param sender The sender of the event.
     */
    private static stickyMapKey(stickyKey: string, sender: UserId): string {
        return `${stickyKey}${sender}`;
    }

    /**
     * Get all sticky events that are currently active.
     * @returns An iterable set of events.
     */
    public *getStickyEvents(): Iterable<StickyMatrixEvent> {
        yield* this.unkeyedStickyEvents;
        for (const innerMap of this.stickyEventsMap.values()) {
            // Inner map contains a map of sender+stickykeys => all sticky events
            for (const events of innerMap.values()) {
                // The first sticky event is the "current" one in the sticky map.
                yield events[0];
            }
        }
    }

    /**
     * Get an active sticky event that match the given `type`, `sender`, and `stickyKey`
     * @param type The event `type`.
     * @param sender The sender of the sticky event.
     * @param stickyKey The sticky key used by the event.
     * @returns A matching active sticky event, or undefined.
     */
    public getKeyedStickyEvent(sender: string, type: string, stickyKey: string): StickyMatrixEvent | undefined {
        assertIsUserId(sender);
        return this.stickyEventsMap.get(type)?.get(RoomStickyEventsStore.stickyMapKey(stickyKey, sender))?.[0];
    }

    /**
     * Get active sticky events without a sticky key that match the given `type` and `sender`.
     * @param type The event `type`.
     * @param sender The sender of the sticky event.
     * @returns An array of matching sticky events.
     */
    public getUnkeyedStickyEvent(sender: string, type: string): StickyMatrixEvent[] {
        return [...this.unkeyedStickyEvents].filter((ev) => ev.getType() === type && ev.getSender() === sender);
    }

    /**
     * Adds a sticky event into the local sticky event map.
     *
     * NOTE: This will not cause `RoomEvent.StickyEvents` to be emitted.
     *
     * @throws If the `event` does not contain valid sticky data.
     * @param event The MatrixEvent that contains sticky data.
     * @returns An object describing whether the event was added to the map,
     *          and the previous event it may have replaced.
     */
    private addStickyEvent(event: MatrixEvent): { added: true; prevEvent?: StickyMatrixEvent } | { added: false } {
        const stickyKey = event.getContent().msc4354_sticky_key;
        if (typeof stickyKey !== "string" && stickyKey !== undefined) {
            throw new Error(`${event.getId()} is missing msc4354_sticky_key`);
        }

        // With this we have the guarantee, that all events in stickyEventsMap are correctly formatted
        if (event.unstableStickyExpiresAt === undefined) {
            throw new Error(`${event.getId()} is missing msc4354_sticky.duration_ms`);
        }
        const sender = event.getSender();
        const type = event.getType();
        assertIsUserId(sender);
        if (event.unstableStickyExpiresAt <= Date.now()) {
            logger.info("ignored sticky event with older expiration time than current time", stickyKey);
            return { added: false };
        }

        // While we fully expect the server to always provide the correct value,
        // this is just insurance to protect against attacks on our Map.
        if (!sender.startsWith("@")) {
            throw new Error("Expected sender to start with @");
        }

        const stickyEvent = event as StickyMatrixEvent;

        if (stickyKey === undefined) {
            this.unkeyedStickyEvents.add(stickyEvent);
            // Recalculate the next expiry time.
            this.nextStickyEventExpiryTs = Math.min(event.unstableStickyExpiresAt, this.nextStickyEventExpiryTs);

            this.scheduleStickyTimer();
            return { added: true };
        }

        // Why this is safe:
        // A type may contain anything but the *sender* is tightly
        // constrained so that a key will always end with a @<user_id>
        // E.g. Where a malicious event type might be "rtc.member.event@foo:bar" the key becomes:
        // "rtc.member.event.@foo:bar@bar:baz"
        const innerMapKey = RoomStickyEventsStore.stickyMapKey(stickyKey, sender);
        const currentEventSet = [stickyEvent, ...(this.stickyEventsMap.get(type)?.get(innerMapKey) ?? [])].sort(
            RoomStickyEventsStore.sortStickyEvent,
        );
        if (!this.stickyEventsMap.has(type)) {
            this.stickyEventsMap.set(type, new Map());
        }
        this.stickyEventsMap.get(type)?.set(innerMapKey, currentEventSet);

        // Recalculate the next expiry time.
        this.nextStickyEventExpiryTs = Math.min(stickyEvent.unstableStickyExpiresAt, this.nextStickyEventExpiryTs);

        this.scheduleStickyTimer();
        return {
            added: currentEventSet[0] === stickyEvent,
            prevEvent: currentEventSet?.[1],
        };
    }

    /**
     * Add a series of sticky events, emitting `RoomEvent.StickyEvents` if any
     * changes were made.
     * @param events A set of new sticky events.
     */
    public addStickyEvents(events: MatrixEvent[]): void {
        const added: StickyMatrixEvent[] = [];
        const updated: { current: StickyMatrixEvent; previous: StickyMatrixEvent }[] = [];
        for (const event of events) {
            try {
                const result = this.addStickyEvent(event);
                if (result.added) {
                    if (result.prevEvent) {
                        // e is validated as a StickyMatrixEvent by virtue of `addStickyEvent` returning added: true.
                        updated.push({ current: event as StickyMatrixEvent, previous: result.prevEvent });
                    } else {
                        added.push(event as StickyMatrixEvent);
                    }
                }
            } catch (ex) {
                logger.warn("ignored invalid sticky event", ex);
            }
        }
        if (added.length || updated.length) this.emit(RoomStickyEventsEvent.Update, added, updated, []);
        this.scheduleStickyTimer();
    }

    /**
     * Schedule the sticky event expiry timer. The timer will
     * run immediately if an event has already expired.
     */
    private scheduleStickyTimer(): void {
        if (this.stickyEventTimer) {
            clearTimeout(this.stickyEventTimer);
            this.stickyEventTimer = undefined;
        }
        if (this.nextStickyEventExpiryTs === Number.MAX_SAFE_INTEGER) {
            // We have no events due to expire.
            return;
        } // otherwise, schedule in the future
        this.stickyEventTimer = setTimeout(this.cleanExpiredStickyEvents, this.nextStickyEventExpiryTs - Date.now());
    }

    /**
     * Clean out any expired sticky events.
     */
    private readonly cleanExpiredStickyEvents = (): void => {
        const now = Date.now();
        const removedEvents: StickyMatrixEvent[] = [];

        // We will recalculate this as we check all events.
        this.nextStickyEventExpiryTs = Number.MAX_SAFE_INTEGER;
        for (const [eventType, innerEvents] of this.stickyEventsMap.entries()) {
            for (const [innerMapKey, [currentEvent, ...previousEvents]] of innerEvents) {
                // we only added items with `sticky` into this map so we can assert non-null here
                if (now >= currentEvent.unstableStickyExpiresAt) {
                    logger.debug("Expiring sticky event", currentEvent.getId());
                    removedEvents.push(currentEvent);
                    this.stickyEventsMap.get(eventType)!.delete(innerMapKey);
                } else {
                    // Ensure we remove any previous events which have now expired, to avoid unbounded memory consumption.
                    this.stickyEventsMap
                        .get(eventType)!
                        .set(innerMapKey, [
                            currentEvent,
                            ...previousEvents.filter((e) => e.unstableStickyExpiresAt <= now),
                        ]);
                    // If not removing the event, check to see if it's the next lowest expiry.
                    this.nextStickyEventExpiryTs = Math.min(
                        this.nextStickyEventExpiryTs,
                        currentEvent.unstableStickyExpiresAt,
                    );
                }
            }
            // Clean up map after use.
            if (this.stickyEventsMap.get(eventType)?.size === 0) {
                this.stickyEventsMap.delete(eventType);
            }
        }
        for (const event of this.unkeyedStickyEvents) {
            if (now >= event.unstableStickyExpiresAt) {
                logger.debug("Expiring sticky event", event.getId());
                this.unkeyedStickyEvents.delete(event);
                removedEvents.push(event);
            } else {
                // If not removing the event, check to see if it's the next lowest expiry.
                this.nextStickyEventExpiryTs = Math.min(this.nextStickyEventExpiryTs, event.unstableStickyExpiresAt);
            }
        }
        if (removedEvents.length) {
            this.emit(RoomStickyEventsEvent.Update, [], [], removedEvents);
        }
        // Finally, schedule the next run.
        this.scheduleStickyTimer();
    };

    /**
     * Handles incoming event redactions. Checks the sticky map
     * for any active sticky events being redacted.
     * @param redactedEvent The MatrixEvent OR event ID of the event being redacted. MAY not be a sticky event.
     */
    public handleRedaction(redactedEvent: MatrixEvent | string): void {
        // Note, we do not adjust`nextStickyEventExpiryTs` here.
        // If this event happens to be the most recent expiring event
        // then we may do one extra iteration of cleanExpiredStickyEvents
        // but this saves us having to iterate over all events here to calculate
        // the next expiry time.

        // Note, as soon as we find a positive match on an event in this function
        // we can return. There is no need to continue iterating on a positive match
        // as an event can only appear in one map.

        // Handle unkeyedStickyEvents first since it's *quick*.
        const redactEventId = typeof redactedEvent === "string" ? redactedEvent : redactedEvent.getId();
        for (const event of this.unkeyedStickyEvents) {
            if (event.getId() === redactEventId) {
                this.unkeyedStickyEvents.delete(event);
                this.emit(RoomStickyEventsEvent.Update, [], [], [event]);
                return;
            }
        }

        // Faster method of finding the event since we have the event cached.
        if (typeof redactedEvent !== "string" && !redactedEvent.isRedacted()) {
            const stickyKey = redactedEvent.getContent().msc4354_sticky_key;
            if (typeof stickyKey !== "string" && stickyKey !== undefined) {
                return; // Not a sticky event.
            }
            const eventType = redactedEvent.getType();
            const sender = redactedEvent.getSender();
            assertIsUserId(sender);
            const innerMap = this.stickyEventsMap.get(eventType);
            if (!innerMap) {
                return;
            }
            const mapKey = RoomStickyEventsStore.stickyMapKey(stickyKey, sender);
            const [currentEvent, ...previousEvents] = innerMap.get(mapKey) ?? [];
            if (!currentEvent) {
                // No event current in the map so ignore.
                return;
            }
            logger.debug(`Redaction for ${redactEventId} under sticky key ${stickyKey}`);
            // Revert to previous state, taking care to skip any other redacted events.
            const newEvents = previousEvents.filter((e) => !e.isRedacted()).sort(RoomStickyEventsStore.sortStickyEvent);
            this.stickyEventsMap.get(eventType)?.set(mapKey, newEvents);
            if (newEvents.length) {
                this.emit(
                    RoomStickyEventsEvent.Update,
                    [],
                    [
                        {
                            // This looks confusing. This emits that the newer event
                            // has been redacted and the previous event has taken it's place.
                            previous: currentEvent,
                            current: newEvents[0],
                        },
                    ],
                    [],
                );
            } else {
                // We did not find a previous event, so just expire.
                innerMap.delete(mapKey);
                if (innerMap.size === 0) {
                    this.stickyEventsMap.delete(eventType);
                }
                this.emit(RoomStickyEventsEvent.Update, [], [], [currentEvent]);
            }
            return;
        }

        // We only know the event ID of the redacted event, so we need to
        // traverse the map to find our event.
        for (const innerMap of this.stickyEventsMap.values()) {
            for (const [currentEvent] of innerMap.values()) {
                if (currentEvent.getId() !== redactEventId) {
                    continue;
                }
                // Found the event.
                return this.handleRedaction(currentEvent);
            }
        }
    }

    /**
     * Clear all events and stop the timer from firing.
     */
    public clear(): void {
        this.stickyEventsMap.clear();
        // Unschedule timer.
        this.nextStickyEventExpiryTs = Number.MAX_SAFE_INTEGER;
        this.scheduleStickyTimer();
    }
}
