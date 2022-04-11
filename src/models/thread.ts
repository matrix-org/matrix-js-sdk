/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { MatrixClient, MatrixEventEvent, RelationType, RoomEvent } from "../matrix";
import { TypedReEmitter } from "../ReEmitter";
import { IRelationsRequestOpts } from "../@types/requests";
import { IThreadBundledRelationship, MatrixEvent } from "./event";
import { Direction, EventTimeline } from "./event-timeline";
import { EventTimelineSet, EventTimelineSetHandlerMap } from './event-timeline-set';
import { Room } from './room';
import { TypedEventEmitter } from "./typed-event-emitter";
import { RoomState } from "./room-state";
import { ServerControlledNamespacedValue } from "../NamespacedValue";
import { logger } from "../logger";

export enum ThreadEvent {
    New = "Thread.new",
    Update = "Thread.update",
    NewReply = "Thread.newReply",
    ViewThread = "Thread.viewThread",
}

type EmittedEvents = Exclude<ThreadEvent, ThreadEvent.New>
    | RoomEvent.Timeline
    | RoomEvent.TimelineReset;

export type EventHandlerMap = {
    [ThreadEvent.Update]: (thread: Thread) => void;
    [ThreadEvent.NewReply]: (thread: Thread, event: MatrixEvent) => void;
    [ThreadEvent.ViewThread]: () => void;
} & EventTimelineSetHandlerMap;

interface IThreadOpts {
    initialEvents?: MatrixEvent[];
    room: Room;
    client: MatrixClient;
}

/**
 * @experimental
 */
export class Thread extends TypedEventEmitter<EmittedEvents, EventHandlerMap> {
    public static hasServerSideSupport: boolean;

    /**
     * A reference to all the events ID at the bottom of the threads
     */
    public readonly timelineSet: EventTimelineSet;

    private _currentUserParticipated = false;

    private reEmitter: TypedReEmitter<EmittedEvents, EventHandlerMap>;

    private lastEvent: MatrixEvent;
    private replyCount = 0;

    public readonly room: Room;
    public readonly client: MatrixClient;

    public initialEventsFetched = false;

    public readonly id: string;

    constructor(
        public readonly rootEvent: MatrixEvent | undefined,
        opts: IThreadOpts,
    ) {
        super();

        this.room = opts.room;
        this.client = opts.client;
        this.timelineSet = new EventTimelineSet(this.room, {
            unstableClientRelationAggregation: true,
            timelineSupport: true,
            pendingEvents: true,
        });
        this.reEmitter = new TypedReEmitter(this);

        this.reEmitter.reEmit(this.timelineSet, [
            RoomEvent.Timeline,
            RoomEvent.TimelineReset,
        ]);

        this.room.on(MatrixEventEvent.BeforeRedaction, this.onBeforeRedaction);
        this.room.on(RoomEvent.LocalEchoUpdated, this.onEcho);
        this.timelineSet.on(RoomEvent.Timeline, this.onEcho);

        // If we weren't able to find the root event, it's probably missing,
        // and we define the thread ID from one of the thread relation
        this.id = rootEvent?.getId() ?? opts?.initialEvents?.find(event => event.isThreadRelation)?.relationEventId;
        this.initialiseThread(this.rootEvent);

        opts?.initialEvents?.forEach(event => this.addEvent(event, false));
    }

    public static setServerSideSupport(hasServerSideSupport: boolean, useStable: boolean): void {
        Thread.hasServerSideSupport = hasServerSideSupport;
        if (!useStable) {
            FILTER_RELATED_BY_SENDERS.setPreferUnstable(true);
            FILTER_RELATED_BY_REL_TYPES.setPreferUnstable(true);
            THREAD_RELATION_TYPE.setPreferUnstable(true);
        }
    }

    private onBeforeRedaction = (event: MatrixEvent) => {
        if (event?.isRelation(THREAD_RELATION_TYPE.name) &&
            this.room.eventShouldLiveIn(event).threadId === this.id
        ) {
            this.replyCount--;
            this.emit(ThreadEvent.Update, this);
        }

        if (this.lastEvent?.getId() === event.getId()) {
            const events = [...this.timelineSet.getLiveTimeline().getEvents()].reverse();
            this.lastEvent = events.find(e => (
                !e.isRedacted() &&
                e.getId() !== event.getId() &&
                e.isRelation(THREAD_RELATION_TYPE.name)
            )) ?? this.rootEvent;
            this.emit(ThreadEvent.NewReply, this, this.lastEvent);
        }
    };

    private onEcho = (event: MatrixEvent) => {
        if (event.threadRootId !== this.id) return; // ignore echoes for other timelines
        if (this.lastEvent === event) return;

        // There is a risk that the `localTimestamp` approximation will not be accurate
        // when threads are used over federation. That could result in the reply
        // count value drifting away from the value returned by the server
        const isThreadReply = event.isRelation(THREAD_RELATION_TYPE.name);
        if (!this.lastEvent || (isThreadReply
            && (event.getId() !== this.lastEvent.getId())
            && (event.localTimestamp > this.lastEvent.localTimestamp))
        ) {
            this.lastEvent = event;
            if (this.lastEvent.getId() !== this.id) {
                // This counting only works when server side support is enabled as we started the counting
                // from the value returned within the bundled relationship
                if (Thread.hasServerSideSupport) {
                    this.replyCount++;
                }

                this.emit(ThreadEvent.NewReply, this, event);
            }
        }

        this.emit(ThreadEvent.Update, this);
    };

    public get roomState(): RoomState {
        return this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    }

    private addEventToTimeline(event: MatrixEvent, toStartOfTimeline: boolean): void {
        if (!this.findEventById(event.getId())) {
            this.timelineSet.addEventToTimeline(
                event,
                this.liveTimeline,
                toStartOfTimeline,
                false,
                this.roomState,
            );
        }
    }

    /**
     * Add an event to the thread and updates
     * the tail/root references if needed
     * Will fire "Thread.update"
     * @param event The event to add
     * @param {boolean} toStartOfTimeline whether the event is being added
     * to the start (and not the end) of the timeline.
     */
    public async addEvent(event: MatrixEvent, toStartOfTimeline: boolean): Promise<void> {
        // Add all incoming events to the thread's timeline set when there's  no server support
        if (!Thread.hasServerSideSupport) {
            // all the relevant membership info to hydrate events with a sender
            // is held in the main room timeline
            // We want to fetch the room state from there and pass it down to this thread
            // timeline set to let it reconcile an event with its relevant RoomMember

            event.setThread(this);
            this.addEventToTimeline(event, toStartOfTimeline);

            await this.client.decryptEventIfNeeded(event, {});
        } else if (!toStartOfTimeline &&
            this.initialEventsFetched &&
            event.localTimestamp > this.lastReply().localTimestamp
        ) {
            await this.fetchEditsWhereNeeded(event);
            this.addEventToTimeline(event, false);
        }

        if (!this._currentUserParticipated && event.getSender() === this.client.getUserId()) {
            this._currentUserParticipated = true;
        }

        // If no thread support exists we want to count all thread relation
        // added as a reply. We can't rely on the bundled relationships count
        if (!Thread.hasServerSideSupport && event.isRelation(THREAD_RELATION_TYPE.name)) {
            this.replyCount++;
        }

        this.emit(ThreadEvent.Update, this);
    }

    private initialiseThread(rootEvent: MatrixEvent | undefined): void {
        const bundledRelationship = rootEvent
            ?.getServerAggregatedRelation<IThreadBundledRelationship>(THREAD_RELATION_TYPE.name);

        if (Thread.hasServerSideSupport && bundledRelationship) {
            this.replyCount = bundledRelationship.count;
            this._currentUserParticipated = bundledRelationship.current_user_participated;

            const event = new MatrixEvent(bundledRelationship.latest_event);
            this.setEventMetadata(event);
            event.setThread(this);
            this.lastEvent = event;

            this.fetchEditsWhereNeeded(event);
        }
    }

    // XXX: Workaround for https://github.com/matrix-org/matrix-spec-proposals/pull/2676/files#r827240084
    private async fetchEditsWhereNeeded(...events: MatrixEvent[]): Promise<unknown> {
        return Promise.all(events.filter(e => e.isEncrypted()).map((event: MatrixEvent) => {
            return this.client.relations(this.roomId, event.getId(), RelationType.Replace, event.getType(), {
                limit: 1,
            }).then(relations => {
                if (relations.events.length) {
                    event.makeReplaced(relations.events[0]);
                }
            }).catch(e => {
                logger.error("Failed to load edits for encrypted thread event", e);
            });
        }));
    }

    public async fetchInitialEvents(): Promise<{
        originalEvent: MatrixEvent;
        events: MatrixEvent[];
        nextBatch?: string;
        prevBatch?: string;
    } | null> {
        if (!Thread.hasServerSideSupport) {
            this.initialEventsFetched = true;
            return null;
        }

        try {
            const response = await this.fetchEvents();
            this.initialEventsFetched = true;
            return response;
        } catch (e) {
            return null;
        }
    }

    private setEventMetadata(event: MatrixEvent): void {
        EventTimeline.setEventMetadata(event, this.roomState, false);
        event.setThread(this);
    }

    /**
     * Finds an event by ID in the current thread
     */
    public findEventById(eventId: string) {
        // Check the lastEvent as it may have been created based on a bundled relationship and not in a timeline
        if (this.lastEvent?.getId() === eventId) {
            return this.lastEvent;
        }

        return this.timelineSet.findEventById(eventId);
    }

    /**
     * Return last reply to the thread
     */
    public lastReply(matches: (ev: MatrixEvent) => boolean = () => true): MatrixEvent {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (matches(event)) {
                return event;
            }
        }
    }

    public get roomId(): string {
        return this.room.roomId;
    }

    /**
     * The number of messages in the thread
     * Only count rel_type=m.thread as we want to
     * exclude annotations from that number
     */
    public get length(): number {
        return this.replyCount;
    }

    /**
     * A getter for the last event added to the thread
     */
    public get replyToEvent(): MatrixEvent {
        return this.lastEvent;
    }

    public get events(): MatrixEvent[] {
        return this.liveTimeline.getEvents();
    }

    public has(eventId: string): boolean {
        return this.timelineSet.findEventById(eventId) instanceof MatrixEvent;
    }

    public get hasCurrentUserParticipated(): boolean {
        return this._currentUserParticipated;
    }

    public get liveTimeline(): EventTimeline {
        return this.timelineSet.getLiveTimeline();
    }

    public async fetchEvents(opts: IRelationsRequestOpts = { limit: 20 }): Promise<{
        originalEvent: MatrixEvent;
        events: MatrixEvent[];
        nextBatch?: string;
        prevBatch?: string;
    }> {
        let {
            originalEvent,
            events,
            prevBatch,
            nextBatch,
        } = await this.client.relations(
            this.room.roomId,
            this.id,
            THREAD_RELATION_TYPE.name,
            null,
            opts,
        );

        // When there's no nextBatch returned with a `from` request we have reached
        // the end of the thread, and therefore want to return an empty one
        if (!opts.to && !nextBatch) {
            events = [...events, originalEvent];
        }

        await this.fetchEditsWhereNeeded(...events);

        await Promise.all(events.map(event => {
            this.setEventMetadata(event);
            return this.client.decryptEventIfNeeded(event);
        }));

        const prependEvents = !opts.direction || opts.direction === Direction.Backward;

        this.timelineSet.addEventsToTimeline(
            events,
            prependEvents,
            this.liveTimeline,
            prependEvents ? nextBatch : prevBatch,
        );

        return {
            originalEvent,
            events,
            prevBatch,
            nextBatch,
        };
    }
}

export const FILTER_RELATED_BY_SENDERS = new ServerControlledNamespacedValue(
    "related_by_senders",
    "io.element.relation_senders",
);
export const FILTER_RELATED_BY_REL_TYPES = new ServerControlledNamespacedValue(
    "related_by_rel_types",
    "io.element.relation_types",
);
export const THREAD_RELATION_TYPE = new ServerControlledNamespacedValue(
    "m.thread",
    "io.element.thread",
);

export enum ThreadFilterType {
    "My",
    "All"
}
