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

import { RelationType, IThreadBundledRelation } from "../@types/event";
import { IRelationsRequestOpts } from "../@types/requests";
import { MatrixClient } from "../client";
import { TimelineWindow } from "../timeline-window";
import { MatrixEvent } from "./event";
import { Direction, EventTimeline } from "./event-timeline";
import { EventTimelineSet } from './event-timeline-set';
import { Room } from './room';
import { RoomState } from "./room-state";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum ThreadEvent {
    New = "Thread.new",
    Ready = "Thread.ready",
    Update = "Thread.update",
    NewReply = "Thread.newReply",
    ViewThread = "Thred.viewThread",
}

/**
 * @experimental
 */
export class Thread extends TypedEventEmitter<ThreadEvent> {
    private _ready = false;

    private _head: MatrixEvent;
    private eventToPreview: MatrixEvent = null;
    private replyCount = 0;

    public _hasServerSideSupport = false;

    private _rootRefreshed = false;
    private _eventsQueue: MatrixEvent[] = [];

    /**
     * A reference to all the events ID at the bottom of the threads
     */
    public readonly timelineSet: EventTimelineSet;

    constructor(
        public threadHeadId: string,
        public readonly room: Room,
        public readonly client: MatrixClient,
    ) {
        super();
        this.timelineSet = new EventTimelineSet(this.room, {
            unstableClientRelationAggregation: true,
            timelineSupport: true,
            pendingEvents: true,
        });

        let head = this.room.findEventById(threadHeadId);

        this.client.fetchRoomEvent(this.roomId, threadHeadId)
            .then(async eventData => {
                this._rootRefreshed = true;

                if (head) {
                    // We have to refresh the stale unsigned data as the one
                    // stored in indexeddb is probably out of date
                    head.setUnsigned(eventData.unsigned);
                } else {
                    head = new MatrixEvent(eventData);
                }

                // If our event has aggregated relationship we know that we have
                // server side support for threads, and we can be smarter about
                // how it works
                if (head.getAggregatedRelationship(RelationType.Thread)) {
                    this._hasServerSideSupport = true;
                }

                this.setThreadHead(head);

                if (this._hasServerSideSupport) {
                    this.on(ThreadEvent.ViewThread, this.init);
                } else {
                    await this.init();
                    this._eventsQueue.forEach(event => {
                        this.addEvent(event);
                    });
                }
                delete this._eventsQueue;
            });
        room.on("Room.localEchoUpdated", this.onEcho);
        room.on("Room.timeline", this.onEcho);
    }

    public init = async (): Promise<void> => {
        if (this._hasServerSideSupport) {
            const { originalEvent } = await this.fetchEvents();
            if (!this._head) {
                this._head = originalEvent;
            }
        }

        this._ready = true;
        this.off(ThreadEvent.ViewThread, this.init);
        this.emit(ThreadEvent.Ready, this);
        this.emit(ThreadEvent.New, this);
    };

    private async fetchEvents(opts: IRelationsRequestOpts = { limit: 20 }): Promise<{
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
            this.threadHeadId,
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
            event.setThread(this);
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

    public get liveTimeline(): EventTimeline {
        return this.timelineSet.getLiveTimeline();
    }

    public onPaginationRequest = async (
        timelineWindow: TimelineWindow | null,
        direction = Direction.Backward,
        limit = 20,
    ): Promise<boolean> => {
        if (!this._hasServerSideSupport) {
            return false;
        }

        const timelineIndex = timelineWindow.getTimelineIndex(direction);

        const paginationKey = direction === Direction.Backward ? "from" : "to";
        const paginationToken = timelineIndex.timeline.getPaginationToken(direction);

        const opts: IRelationsRequestOpts = {
            limit,
            [paginationKey]: paginationToken,
            direction,
        };

        await this.fetchEvents(opts);

        return timelineWindow.paginate(direction, limit);
    };

    private setThreadHead(event: MatrixEvent) {
        this._head = event;
        this.eventToPreview = event;

        event.setThread(this);

        const threadBundle = this._head
            .getAggregatedRelationship<IThreadBundledRelation>(RelationType.Thread);

        if (threadBundle) {
            this.eventToPreview = new MatrixEvent(threadBundle.latest_event);
            this.client.decryptEventIfNeeded(this.eventToPreview).then(() => {
                this.emit(ThreadEvent.Update, this);
            });
            EventTimeline.setEventMetadata(this.eventToPreview, this.roomState, false);
            this.replyCount = threadBundle.count;
        } else {
            this.addEvent(this._head);
            this.replyCount = 0;
        }

        this.emit(ThreadEvent.Update);
    }

    private onEcho = (event: MatrixEvent): void => {
        if (this.timelineSet.eventIdToTimeline(event.getId())) {
            this.emit(ThreadEvent.Update, this);
        }
    };

    private get roomState(): RoomState {
        // all the relevant membership info to hydrate events with a sender
        // is held in the main room timeline
        // We want to fetch the room state from there and pass it down to this thread
        // timeline set to let it reconcile an event with its relevant RoomMember
        return this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    }

    /**
     * Add an event to the thread and updates
     * the tail/root references if needed
     * Will fire "Thread.update"
     * @param event The event to add
     */
    public async addEvent(event: MatrixEvent, direction = Direction.Forward): Promise<void> {
        if (this.has(event.getId())) {
            return;
        }

        if (!this._rootRefreshed) {
            this._eventsQueue.push(event);
            return;
        }

        // If the thread is not initialised by the time we receive the first
        // event from the sync we need to make that happen before doing anything
        // else, otherwise the final event ordering will be incorrect
        if (!this._ready) {
            await this.init();
        }

        event.setThread(this);
        this.timelineSet.addEventToTimeline(
            event,
            this.liveTimeline,
            direction === Direction.Backward,
            false,
            this.roomState,
        );

        await this.client.decryptEventIfNeeded(event, {});

        if (event.isThreadRelation) {
            this.replyCount++;
            this.eventToPreview = event;
            this.emit(ThreadEvent.NewReply, this, event);
        }

        this.emit(ThreadEvent.Update, this);
        this.emit(ThreadEvent.New, this);
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
    public get lastReply(): MatrixEvent {
        return this.eventToPreview;
    }

    /**
     * The thread ID, which is the same as the root event ID
     */
    public get id(): string {
        return this.threadHeadId;
    }

    public get roomId(): string {
        return this.room.roomId;
    }

    public get head(): MatrixEvent {
        return this._head;
    }

    /**
     * The number of messages in the thread
     * Only count rel_type=m.thread as we want to
     * exclude annotations from that number
     *
     * Will be erroneous until https://github.com/vector-im/element-web/issues/19588
     * lands
     */
    public get length(): number {
        return this.replyCount;
    }

    /**
     * A getter for the last event added to the thread
     */
    public get replyToEvent(): MatrixEvent {
        return this.lastReply;
    }

    public has(eventId: string): boolean {
        return this.findEventById(eventId) instanceof MatrixEvent;
    }

    public get hasServerSideSupport(): boolean {
        return this._hasServerSideSupport;
    }

    public get ready(): boolean {
        return this._ready;
    }
}
