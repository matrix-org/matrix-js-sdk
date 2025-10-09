import { logger as loggerInstance } from "../logger.ts";
import { type MatrixEvent } from "./event.ts";
import { TypedEventEmitter } from "./typed-event-emitter.ts";

const logger = loggerInstance.getChild("RoomStickyEvents");

export enum RoomStickyEventsEvent {
    Update = "RoomStickyEvents.Update",
}

type StickyMatrixEvent = MatrixEvent & { unstableStickyExpiresAt: number };

/**
 * Keeps a chain of sticky events to ensure that we can roll back in case of expiry.
 */
type StickyMatrixEventSet = {
    /**
     * The current event at this point in the chain.
     */
    event: StickyMatrixEvent;
    /**
     * The previous event, ordered by expiry time.
     */
    previous?: StickyMatrixEventSet;
};

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

/**
 * Tracks sticky events on behalf of one room, and fires an event
 * whenever a sticky event is updated or replaced.
 */
export class RoomStickyEventsStore extends TypedEventEmitter<RoomStickyEventsEvent, RoomStickyEventsMap> {
    private readonly stickyEventsMap = new Map<string, Map<string, StickyMatrixEventSet>>(); // (type -> stickyKey+userId) -> event
    private readonly unkeyedStickyEvents = new Set<StickyMatrixEvent>();

    private stickyEventTimer?: ReturnType<typeof setTimeout>;
    private nextStickyEventExpiryTs: number = Number.MAX_SAFE_INTEGER;

    /**
     * Get all sticky events that are currently active.
     * @returns An iterable set of events.
     */
    public *getStickyEvents(): Iterable<StickyMatrixEvent> {
        yield* this.unkeyedStickyEvents;
        for (const innerMap of this.stickyEventsMap.values()) {
            for (const { event: current } of innerMap.values()) {
                yield current;
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
        return this.stickyEventsMap.get(type)?.get(`${stickyKey}${sender}`)?.event;
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
        if (!sender) {
            throw new Error(`${event.getId()} is missing a sender`);
        } else if (event.unstableStickyExpiresAt <= Date.now()) {
            logger.info("ignored sticky event with older expiration time than current time", stickyKey);
            return { added: false };
        }

        // While we fully expect the server to always provide the correct value,
        // this is just insurance to protect against attacks on our Map.
        if (!sender.startsWith("@")) {
            throw new Error("Expected sender to start with @");
        }

        let prevSet: StickyMatrixEventSet | undefined;
        if (stickyKey !== undefined) {
            // Why this is safe:
            // A type may contain anything but the *sender* is tightly
            // constrained so that a key will always end with a @<user_id>
            // E.g. Where a malicious event type might be "rtc.member.event@foo:bar" the key becomes:
            // "rtc.member.event.@foo:bar@bar:baz"
            const innerMapKey = `${stickyKey}${sender}`;
            prevSet = this.stickyEventsMap.get(type)?.get(innerMapKey);

            // sticky events are not allowed to expire sooner than their predecessor.
            if (prevSet && event.unstableStickyExpiresAt < prevSet.event.unstableStickyExpiresAt) {
                logger.info("ignored sticky event with older expiry time", stickyKey);
                return { added: false };
            } else if (
                prevSet &&
                event.getTs() === prevSet.event.getTs() &&
                (event.getId() ?? "") < (prevSet.event.getId() ?? "")
            ) {
                // This path is unlikely, as it requires both events to have the same TS.
                logger.info("ignored sticky event due to 'id tie break rule' on sticky_key", stickyKey);
                return { added: false };
            }
            if (!this.stickyEventsMap.has(type)) {
                this.stickyEventsMap.set(type, new Map());
            }
            this.stickyEventsMap.get(type)!.set(innerMapKey, { event: event as StickyMatrixEvent, previous: prevSet });
        } else {
            this.unkeyedStickyEvents.add(event as StickyMatrixEvent);
        }

        // Recalculate the next expiry time.
        this.nextStickyEventExpiryTs = Math.min(event.unstableStickyExpiresAt, this.nextStickyEventExpiryTs);

        this.scheduleStickyTimer();
        return { added: true, prevEvent: prevSet?.event };
    }

    /**
     * Add a series of sticky events, emitting `RoomEvent.StickyEvents` if any
     * changes were made.
     * @param events A set of new sticky events.
     */
    public addStickyEvents(events: MatrixEvent[]): void {
        const added: StickyMatrixEvent[] = [];
        const updated: { current: StickyMatrixEvent; previous: StickyMatrixEvent }[] = [];
        // Ensure we insert by expiry time to preserve previous chain ordering.
        for (const event of events
            .filter((e) => e.unstableStickyExpiresAt)
            .sort((a, b) => a.unstableStickyExpiresAt! - b.unstableStickyExpiresAt!)) {
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
            for (const [innerMapKey, { event, previous }] of innerEvents) {
                // we only added items with `sticky` into this map so we can assert non-null here
                if (now >= event.unstableStickyExpiresAt) {
                    logger.debug("Expiring sticky event", event.getId());
                    removedEvents.push(event);
                    this.stickyEventsMap.get(eventType)!.delete(innerMapKey);
                } else {
                    // Ensure we remove any previous events which have now expired, to avoid unbounded memory consumption.
                    for (let p = previous; p !== undefined; p = p.previous) {
                        if (p.previous && p.previous.event.unstableStickyExpiresAt <= now) {
                            // The chain is ordered by expiry time so we can confidently break the chain here.
                            p.previous = undefined;
                        }
                    }
                    // If not removing the event, check to see if it's the next lowest expiry.
                    this.nextStickyEventExpiryTs = Math.min(
                        this.nextStickyEventExpiryTs,
                        event.unstableStickyExpiresAt,
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
     * @param redactEventId The event ID of the event being redacted. MAY not be a sticky event.
     */
    public handleRedaction(redactEventId: string) {
        // Note, we do not adjust`nextStickyEventExpiryTs` here.
        // If this event happens to be the most recent expiring event
        // then we may do one extra iteration of cleanExpiredStickyEvents
        // but this saves us having to iterate over all events here to calculate
        // the next expiry time.
        for (const event of this.unkeyedStickyEvents) {
            if (event.getId() === redactEventId) {
                this.unkeyedStickyEvents.delete(event);
                this.emit(RoomStickyEventsEvent.Update, [], [], [event]);
                return;
            }
        }
        for (const [eventType, innerMap] of this.stickyEventsMap) {
            for (const [key, { event: event, previous: headPrevious }] of innerMap) {
                if (event.getId() !== redactEventId) {
                    continue;
                }
                // We have found the event.
                for (let p = headPrevious; p !== undefined; p = p.previous) {
                    if (!p.event.isRedacted() && p.event.unstableStickyExpiresAt >= Date.now()) {
                        // Revert to previous state.
                        innerMap.set(key, p);
                        this.emit(
                            RoomStickyEventsEvent.Update,
                            [],
                            [
                                {
                                    // This looks confusing. This emits that the newer event
                                    // has been redacted and the previous event has taken it's place.
                                    previous: event,
                                    current: p.event,
                                },
                            ],
                            [],
                        );
                        break;
                    }
                }
                // We did not find a previous event, so just expire.
                innerMap.delete(key);
                this.emit(RoomStickyEventsEvent.Update, [], [], [event]);
                if (innerMap.size === 0) {
                    this.stickyEventsMap.delete(eventType);
                }
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
