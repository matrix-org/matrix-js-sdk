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

import { EventType } from "../@types/event";
import { MatrixEvent } from "./event";

export class Thread {
    private root: string;
    public tail = new Set<string>();
    private events = new Map<string, MatrixEvent>();
    private _messageCount = 0;

    constructor(events: MatrixEvent[] = []) {
        events.forEach(event => this.addEvent(event));
    }

    /**
     * Add an event to the thread and updates
     * the tail/root references if needed
     * @param event The event to add
     */
    public addEvent(event: MatrixEvent): void {
        if (this.events.has(event.getId())) {
            return;
        }

        const isRoomMessage = event.getType() === EventType.RoomMessage;

        if (this.tail.has(event.replyEventId)) {
            this.tail.delete(event.replyEventId);
        }
        this.tail.add(event.getId());

        if (!event.replyEventId && isRoomMessage) {
            this.root = event.getId();
            this.events.forEach(event => event.setThreadRoot(this.root));
        }

        if (isRoomMessage) {
            this._messageCount++;
        }

        this.events.set(event.getId(), event);

        if (this.root) {
            event.setThreadRoot(this.root);
        }
    }

    /**
     * A sorted list of events to display
     */
    public get eventTimeline(): MatrixEvent[] {
        return Array.from(this.events.values())
            .sort((a, b) => a.getTs() - b.getTs());
    }

    /**
     * The thread ID, which is the same as the root event ID
     */
    public get id(): string {
        return this.root;
    }

    public get rootEvent(): MatrixEvent {
        return this.events.get(this.root);
    }

    /**
     * The number of messages in the thread
     */
    public get length(): number {
        return this._messageCount;
    }

    /**
     * A set of mxid participating to the thread
     */
    public get participants(): Set<string> {
        const participants = new Set<string>();
        this.events.forEach(event => {
            if (event.getType() === EventType.RoomMessage) {
                participants.add(event.getSender());
            }
        });
        return participants;
    }
}
