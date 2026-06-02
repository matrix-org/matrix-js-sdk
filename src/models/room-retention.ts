/*
Copyright 2026 Element Creations Ltd.

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

import { MatrixEvent } from "../models/event";
import { RoomEvent, type Room } from "./room";
import { RoomStateEvent, type RoomState } from "./room-state";
import { type Logger, logger as rootLogger } from "../logger";
import { EventType } from "../@types/event";

/**
 * Applies https://github.com/matrix-org/matrix-spec-proposals/pull/1763 by checking the current
 * state of the room and applying the *latest* retention policy to all preceeding events.
 * Currently does not:
 *   - Apply global server policies (requires Synapse work)
 *   - React at all to `min_retention` configs.
 *   - Loop
 */
export class RoomRetentionPolicy {
    // minRetention is not implemented.
    private maxRetention: number | null = null;
    private retentionTimeout?: ReturnType<typeof setTimeout>;
    private readonly logger: Logger;

    public constructor(private readonly room: Room) {
        this.logger = rootLogger.getChild(`RetentionPolicy ${room.roomId}`);
        room.on(RoomEvent.Timeline, () => this.timelineUpdated());
        room.on(RoomStateEvent.Events, this.roomStateUpdate);
    }

    private readonly roomStateUpdate = (event: MatrixEvent, state: RoomState, prevEvent: MatrixEvent | null): void => {
        if (
            event.getStateKey() !== "" ||
            (event.getType() !== "org.matrix.msc1763.retention" && event.getType() !== "m.room.retention")
        ) {
            return;
        }
        this.logger.info("roomStateUpdate", event.getType(), event.getContent());
        this.currentStateUpdated(state);
    };

    private readonly currentStateUpdated = (roomState: RoomState): void => {
        const unstableEvent = roomState
            .getStateEvents("org.matrix.msc1763.retention")
            .find((e) => e.getStateKey() === "");
        const stableEvent = roomState.getStateEvents("m.room.retention").find((e) => e.getStateKey() === "");
        this.logger.info("currentStateUpdated", unstableEvent, stableEvent);

        const content = unstableEvent?.getContent() ?? stableEvent?.getContent();

        if (!content) {
            this.maxRetention = null;
            return;
        }

        // Parse it
        const { min_lifetime: minLifetime, max_lifetime: maxLifetime } = content;
        if (typeof maxLifetime !== "number") {
            throw Error(`max_lifetime must be a number, got "${maxLifetime}"`);
        }
        if (maxLifetime < 0 || !Number.isInteger(maxLifetime)) {
            throw Error(`max_lifetime must be >= 0, got ${maxLifetime}`);
        }
        if (minLifetime !== undefined) {
            if (typeof minLifetime !== "number") {
                throw Error(`min_lifetime must be a number, got "${minLifetime}"`);
            }
            if (minLifetime < 0 || !Number.isInteger(minLifetime)) {
                throw Error(`min_lifetime must be >= 0, got ${minLifetime}`);
            }
        }
        this.maxRetention = maxLifetime;
        this.logger.info("currentStateUpdated", minLifetime, maxLifetime);
        this.processTimeline();
    };

    private readonly timelineUpdated = (nextTs = 200): void => {
        this.logger.info("timelineUpdated");
        if (this.retentionTimeout) {
            clearTimeout(this.retentionTimeout);
        }
        this.retentionTimeout = setTimeout(() => {
            this.processTimeline();
            this.retentionTimeout = undefined;
        }, nextTs);
    };

    private processTimeline(): void {
        if (!this.maxRetention) {
            return; // No policy, skip.
        }
        this.logger.info(`Running processTimeline`);
        const expireBefore = Date.now() - this.maxRetention;
        const events = this.room
            .getLiveTimeline()
            .getEvents()
            .filter((ev) => ev.getStateKey() === undefined || ev.isRedacted() || ev.getType() === "m.room.redacation");

        const expiredEvents = events.filter((ev) => ev.getTs() < expireBefore);
        const [earliestExpiringEvent] = events.filter((ev) => ev.getTs() >= expireBefore).sort((ev) => ev.getTs());

        if (earliestExpiringEvent) {
            const nextTs = earliestExpiringEvent.getTs() + this.maxRetention - Date.now();
            this.logger.info(`Next expiry scheduled for ${nextTs}`);
            this.timelineUpdated(nextTs);
        }

        if (expiredEvents.length === 0) {
            this.logger.info("Found no expired events");
            return;
        }
        this.logger.info(`Found ${expiredEvents.length} expired events`);
        for (const event of expiredEvents) {
            this.room.tryApplyRedaction(
                new MatrixEvent({
                    type: EventType.RoomRedaction,
                    sender: event.getSender(),
                    event_id: "$synthetic_redaction",
                    room_id: this.room.roomId,
                    redacts: event.getId(),
                    content: {
                        reason: "Retention policy",
                    },
                    origin_server_ts: Date.now(),
                    unsigned: {},
                }),
            );
        }
        // TODO: Asyncify
        void this.room.client.store
            .vapeEventsFromRoom(
                this.room.roomId,
                expiredEvents.map((e) => e.getId()!),
            )
            .catch((ex) => {
                this.logger.warn(`Failed to vape events from store`, ex);
            });
    }
}
