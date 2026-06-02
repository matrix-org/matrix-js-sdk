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

import { MatrixEvent } from "../models/event.ts";
import { RoomEvent, type Room } from "./room.ts";
import { RoomStateEvent, type RoomState } from "./room-state.ts";
import { type Logger, logger as rootLogger } from "../logger.ts";
import { EventType } from "../@types/event.ts";
import { type RetentionConfigurationResponse } from "../retentionPolicy.ts";

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
        room.on(RoomStateEvent.Events, (...params) => {
            void (async (): Promise<void> => {
                try {
                    await this.roomStateUpdate(...params);
                } catch (ex) {
                    this.logger.warn("Failed to calculate new retention rules", ex);
                }
            })();
        });
    }

    private readonly roomStateUpdate = (event: MatrixEvent, state: RoomState, prevEvent: MatrixEvent | null): void => {
        // TODO: Make this cheaper.
        if (this.maxRetention) {
            // If we *have* a room retention policy, only update if a state event appears.
            if (
                event.getStateKey() !== "" ||
                (event.getType() !== "org.matrix.msc1763.retention" && event.getType() !== "m.room.retention")
            ) {
                return;
            }
        } // otherwise, call this every time we see a state update.

        this.logger.info("roomStateUpdate", event.getType(), event.getContent());
        this.currentStateUpdated(state);
    };

    private readonly currentStateUpdated = async (roomState: RoomState): Promise<void> => {
        const unstableEvent = roomState
            .getStateEvents("org.matrix.msc1763.retention")
            .find((e) => e.getStateKey() === "");
        const stableEvent = roomState.getStateEvents("m.room.retention").find((e) => e.getStateKey() === "");
        this.logger.info("currentStateUpdated", unstableEvent, stableEvent);

        // TODO: Error handle.
        const serverPolicy: RetentionConfigurationResponse | null = await this.room.client
            .getRetentionPolicy()
            .catch((ex) => null);

        const serverRoomPolicy = serverPolicy?.policies?.[this.room.roomId];
        const roomStatePolicy = unstableEvent?.getContent() ?? stableEvent?.getContent();

        const content =
            // * if the homeserver defines a specific retention policy for this room, then use this policy as the effective retention policy of the room.
            serverRoomPolicy ??
            // * otherwise, if the state of the room includes a `m.room.retention` event with an empty state key:
            roomStatePolicy ??
            // * otherwise, if the state of the room does not include a m.room.retention event with an empty state key:
            serverPolicy?.policies?.["*"];

        if (!content) {
            // * otherwise, don't apply a retention policy in this room.
            this.maxRetention = null;
            return;
        }

        const validatePolicy = !serverRoomPolicy && roomStatePolicy;

        // Parse it
        let { max_lifetime: maxLifetime } = content;

        if (!maxLifetime && validatePolicy) {
            // if there is no value specified in the room's state, use the limit's min value for the effective retention policy of the room (which can be null or absent).
            maxLifetime = serverPolicy?.limits?.max_lifetime?.min;
            if (!maxLifetime) {
                this.maxRetention = null;
                return;
            }
        }

        if (typeof maxLifetime !== "number") {
            throw Error(`max_lifetime must be a number, got "${maxLifetime}"`);
        }
        if (maxLifetime < 0 || !Number.isInteger(maxLifetime)) {
            throw Error(`max_lifetime must be >= 0, got ${maxLifetime}`);
        }
        this.maxRetention = maxLifetime;

        if (validatePolicy && serverPolicy?.limits?.max_lifetime) {
            // We're using room state so we need to validate this policy matches the server.
            /**
            if the value specified in the room's state complies with the limit, use this value for the effective retention policy of the room.
            if the value specified in the room's state is lower than the limit's min value, use the min value for the effective retention policy of the room.
            if the value specified in the room's state is greater than the limit's max value, use the max value for the effective retention policy of the room.
            */
            this.maxRetention = Math.max(this.maxRetention, serverPolicy.limits.max_lifetime.min ?? 0);
            this.maxRetention = Math.min(
                this.maxRetention,
                serverPolicy.limits.max_lifetime.max ?? Number.MAX_SAFE_INTEGER,
            );
        }

        this.logger.info("calculated new maxLifetime", maxLifetime, "ms");
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
