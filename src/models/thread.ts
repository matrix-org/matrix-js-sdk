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

import { MatrixClient } from "../matrix";
import { ReEmitter } from "../ReEmitter";
import { RelationType } from "../@types/event";
import { IRelationsRequestOpts } from "../@types/requests";
import { MatrixEvent, IThreadBundledRelationship } from "./event";
import { Direction, EventTimeline } from "./event-timeline";
import { EventTimelineSet } from './event-timeline-set';
import { Room } from './room';
import { TypedEventEmitter } from "./typed-event-emitter";
import { RoomState } from "./room-state";

export enum ThreadEvent {
    New = "Thread.new",
    Ready = "Thread.ready",
    Update = "Thread.update",
    NewReply = "Thread.newReply",
    ViewThread = "Thred.viewThread",
}

interface IThreadOpts {
    initialEvents?: MatrixEvent[];
    room: Room;
    client: MatrixClient;
}

/**
 * @experimental
 */
export class Thread extends TypedEventEmitter<ThreadEvent> {
    /**
     * A reference to all the events ID at the bottom of the threads
     */
    public readonly timelineSet;

    private _currentUserParticipated = false;

    private reEmitter: ReEmitter;

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
        this.reEmitter = new ReEmitter(this);

        this.reEmitter.reEmit(this.timelineSet, [
            "Room.timeline",
            "Room.timelineReset",
        ]);

        // If we weren't able to find the root event, it's probably missing
        // and we define the thread ID from one of the thread relation
        if (!rootEvent) {
            this.id = opts?.initialEvents
                ?.find(event => event.isThreadRelation)?.relationEventId;
        } else {
            this.id = rootEvent.getId();
        }
        this.initialiseThread(this.rootEvent);

        opts?.initialEvents?.forEach(event => this.addEvent(event));

        this.room.on("Room.localEchoUpdated", this.onEcho);
        this.room.on("Room.timeline", this.onEcho);
    }

    public get hasServerSideSupport(): boolean {
        return this.client.cachedCapabilities
            ?.capabilities?.[RelationType.Thread]?.enabled;
    }

    onEcho = (event: MatrixEvent) => {
        if (this.timelineSet.eventIdToTimeline(event.getId())) {
            this.emit(ThreadEvent.Update, this);
        }
    };

    public get roomState(): RoomState {
        return this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    }

    private addEventToTimeline(event: MatrixEvent, toStartOfTimeline: boolean): void {
        if (event.getUnsigned().transaction_id) {
            const existingEvent = this.room.getEventForTxnId(event.getUnsigned().transaction_id);
            if (existingEvent) {
                // remote echo of an event we sent earlier
                this.room.handleRemoteEcho(event, existingEvent);
                return;
            }
        }

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
     */
    public async addEvent(event: MatrixEvent, toStartOfTimeline = false): Promise<void> {
        // Add all incoming events to the thread's timeline set when there's
        // no server support
        if (!this.hasServerSideSupport) {
            // all the relevant membership info to hydrate events with a sender
            // is held in the main room timeline
            // We want to fetch the room state from there and pass it down to this thread
            // timeline set to let it reconcile an event with its relevant RoomMember

            event.setThread(this);
            this.addEventToTimeline(event, toStartOfTimeline);

            await this.client.decryptEventIfNeeded(event, {});
        }

        if (this.hasServerSideSupport && this.initialEventsFetched) {
            if (event.localTimestamp > this.lastReply().localTimestamp) {
                this.addEventToTimeline(event, false);
            }
        }

        if (!this._currentUserParticipated && event.getSender() === this.client.getUserId()) {
            this._currentUserParticipated = true;
        }

        const isThreadReply = event.getRelation()?.rel_type === RelationType.Thread;
        // If no thread support exists we want to count all thread relation
        // added as a reply. We can't rely on the bundled relationships count
        if (!this.hasServerSideSupport && isThreadReply) {
            this.replyCount++;
        }

        // There is a risk that the `localTimestamp` approximation will not be accurate
        // when threads are used over federation. That could results in the reply
        // count value drifting away from the value returned by the server
        if (!this.lastEvent || (isThreadReply && event.localTimestamp > this.replyToEvent.localTimestamp)) {
            this.lastEvent = event;
            if (this.lastEvent.getId() !== this.id) {
                // This counting only works when server side support is enabled
                // as we started the counting from the value returned in the
                // bundled relationship
                if (this.hasServerSideSupport) {
                    this.replyCount++;
                }

                this.emit(ThreadEvent.NewReply, this, event);
            }
        }

        this.emit(ThreadEvent.Update, this);
    }

    private initialiseThread(rootEvent: MatrixEvent | undefined): void {
        const bundledRelationship = rootEvent
            ?.getServerAggregatedRelation<IThreadBundledRelationship>(RelationType.Thread);

        if (this.hasServerSideSupport && bundledRelationship) {
            this.replyCount = bundledRelationship.count;
            this._currentUserParticipated = bundledRelationship.current_user_participated;

            const event = new MatrixEvent(bundledRelationship.latest_event);
            this.setEventMetadata(event);
            this.lastEvent = event;
        }

        if (!bundledRelationship && rootEvent) {
            this.addEvent(rootEvent);
        }
    }

    public async fetchInitialEvents(): Promise<boolean> {
        try {
            await this.fetchEvents();
            this.initialEventsFetched = true;
            return true;
        } catch (e) {
            return false;
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
            RelationType.Thread,
            null,
            opts,
        );

        // When there's no nextBatch returned with a `from` request we have reached
        // the end of the thread, and therefore want to return an empty one
        if (!opts.to && !nextBatch) {
            events = [originalEvent, ...events];
        }

        for (const event of events) {
            await this.client.decryptEventIfNeeded(event);
            this.setEventMetadata(event);
        }

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
