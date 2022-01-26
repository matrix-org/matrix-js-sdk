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
import { MatrixEvent, IThreadBundledRelationship } from "./event";
import { EventTimeline } from "./event-timeline";
import { EventTimelineSet } from './event-timeline-set';
import { Room } from './room';
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
    /**
     * A reference to the event ID at the top of the thread
     */
    private root: string;
    /**
     * A reference to all the events ID at the bottom of the threads
     */
    public readonly timelineSet;

    private _currentUserParticipated = false;

    private reEmitter: ReEmitter;

    private lastEvent: MatrixEvent;
    private replyCount = 0;

    constructor(
        events: MatrixEvent[] = [],
        public readonly room: Room,
        public readonly client: MatrixClient,
    ) {
        super();
        if (events.length === 0) {
            throw new Error("Can't create an empty thread");
        }

        this.reEmitter = new ReEmitter(this);

        this.timelineSet = new EventTimelineSet(this.room, {
            unstableClientRelationAggregation: true,
            timelineSupport: true,
            pendingEvents: true,
        });

        this.reEmitter.reEmit(this.timelineSet, [
            "Room.timeline",
            "Room.timelineReset",
        ]);

        events.forEach(event => this.addEvent(event));

        room.on("Room.localEchoUpdated", this.onEcho);
        room.on("Room.timeline", this.onEcho);
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

    /**
     * Add an event to the thread and updates
     * the tail/root references if needed
     * Will fire "Thread.update"
     * @param event The event to add
     */
    public async addEvent(event: MatrixEvent, toStartOfTimeline = false): Promise<void> {
        if (this.timelineSet.findEventById(event.getId())) {
            return;
        }

        if (!this.root) {
            if (event.isThreadRelation) {
                this.root = event.threadRootId;
            } else {
                this.root = event.getId();
            }
        }

        // all the relevant membership info to hydrate events with a sender
        // is held in the main room timeline
        // We want to fetch the room state from there and pass it down to this thread
        // timeline set to let it reconcile an event with its relevant RoomMember
        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);

        event.setThread(this);
        this.timelineSet.addEventToTimeline(
            event,
            this.timelineSet.getLiveTimeline(),
            toStartOfTimeline,
            false,
            roomState,
        );

        if (!this._currentUserParticipated && event.getSender() === this.client.getUserId()) {
            this._currentUserParticipated = true;
        }

        await this.client.decryptEventIfNeeded(event, {});

        const isThreadReply = event.getRelation()?.rel_type === RelationType.Thread;
        // If no thread support exists we want to count all thread relation
        // added as a reply. We can't rely on the bundled relationships count
        if (!this.hasServerSideSupport && isThreadReply) {
            this.replyCount++;
        }

        if (!this.lastEvent || (isThreadReply && event.getTs() > this.lastEvent.getTs())) {
            this.lastEvent = event;
            if (this.lastEvent.getId() !== this.root) {
                // This counting only works when server side support is enabled
                // as we started the counting from the value returned in the
                // bundled relationship
                if (this.hasServerSideSupport) {
                    this.replyCount++;
                }
                this.emit(ThreadEvent.NewReply, this, event);
            }
        }

        if (event.getId() === this.root) {
            const bundledRelationship = event
                .getServerAggregatedRelation<IThreadBundledRelationship>(RelationType.Thread);

            if (this.hasServerSideSupport && bundledRelationship) {
                this.replyCount = bundledRelationship.count;
                this._currentUserParticipated = bundledRelationship.current_user_participated;

                const lastReply = this.findEventById(bundledRelationship.latest_event.event_id);
                if (lastReply) {
                    this.lastEvent = lastReply;
                } else {
                    const event = new MatrixEvent(bundledRelationship.latest_event);
                    this.lastEvent = event;
                }
            }
        }

        this.emit(ThreadEvent.Update, this);
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
            if (event.isThreadRelation && matches(event)) {
                return event;
            }
        }
    }

    /**
     * The thread ID, which is the same as the root event ID
     */
    public get id(): string {
        return this.root;
    }

    /**
     * The thread root event
     */
    public get rootEvent(): MatrixEvent {
        return this.findEventById(this.root);
    }

    public get roomId(): string {
        return this.rootEvent.getRoomId();
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
        return this.timelineSet.getLiveTimeline().getEvents();
    }

    public merge(thread: Thread): void {
        thread.events.forEach(event => {
            this.addEvent(event);
        });
        this.events.forEach(event => event.setThread(this));
    }

    public has(eventId: string): boolean {
        return this.timelineSet.findEventById(eventId) instanceof MatrixEvent;
    }

    public get hasCurrentUserParticipated(): boolean {
        return this._currentUserParticipated;
    }
}
