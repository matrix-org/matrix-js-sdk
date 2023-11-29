/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { RelationType } from "../../src/@types/event";
import { MatrixClient } from "../../src/client";
import { MatrixEvent, MatrixEventEvent } from "../../src/models/event";
import { Room } from "../../src/models/room";
import { Thread, THREAD_RELATION_TYPE } from "../../src/models/thread";
import { mkMessage } from "./test-utils";

export const makeThreadEvent = ({
    rootEventId,
    replyToEventId,
    ...props
}: any & {
    rootEventId: string;
    replyToEventId: string;
    event?: boolean;
}): MatrixEvent =>
    mkMessage({
        ...props,
        relatesTo: {
            event_id: rootEventId,
            rel_type: THREAD_RELATION_TYPE.name,
            ["m.in_reply_to"]: {
                event_id: replyToEventId,
            },
        },
    });

type MakeThreadEventsProps = {
    roomId: Room["roomId"];
    // root message user id
    authorId: string;
    // user ids of thread replies
    // cycled through until thread length is fulfilled
    participantUserIds: string[];
    // number of messages in the thread, root message included
    // optional, default 2
    length?: number;
    ts?: number;
    // provide to set current_user_participated accurately
    currentUserId?: string;
};

export const makeThreadEvents = ({
    roomId,
    authorId,
    participantUserIds,
    length = 2,
    ts = 1,
    currentUserId,
}: MakeThreadEventsProps): { rootEvent: MatrixEvent; events: MatrixEvent[] } => {
    const rootEvent = mkMessage({
        user: authorId,
        room: roomId,
        msg: "root event message " + Math.random(),
        ts,
        event: true,
    });

    const rootEventId = rootEvent.getId();
    const events = [rootEvent];

    for (let i = 1; i < length; i++) {
        const prevEvent = events[i - 1];
        const replyToEventId = prevEvent.getId();
        const user = participantUserIds[i % participantUserIds.length];
        events.push(
            makeThreadEvent({
                user,
                room: roomId,
                event: true,
                msg: `reply ${i} by ${user}`,
                rootEventId,
                replyToEventId,
                // replies are 1ms after each other
                ts: ts + i,
            }),
        );
    }

    rootEvent.setUnsigned({
        "m.relations": {
            [RelationType.Thread]: {
                latest_event: events[events.length - 1],
                count: length,
                current_user_participated: [...participantUserIds, authorId].includes(currentUserId ?? ""),
            },
        },
    });

    return { rootEvent, events };
};

type MakeThreadProps = {
    room: Room;
    client: MatrixClient;
    authorId: string;
    participantUserIds: string[];
    length?: number;
    ts?: number;
};

type MakeThreadResult = {
    /**
     * Thread model
     */
    thread: Thread;
    /**
     * Thread root event
     */
    rootEvent: MatrixEvent;
    /**
     * Events added to the thread
     */
    events: MatrixEvent[];
};

/**
 * Starts a new thread in a room by creating a message as thread root.
 * Also creates a Thread model and adds it to the room.
 * Does not insert the messages into a timeline.
 */
export const mkThread = ({
    room,
    client,
    authorId,
    participantUserIds,
    length = 2,
    ts = 1,
}: MakeThreadProps): MakeThreadResult => {
    const { rootEvent, events } = makeThreadEvents({
        roomId: room.roomId,
        authorId,
        participantUserIds,
        length,
        ts,
        currentUserId: client.getUserId() ?? "",
    });
    expect(rootEvent).toBeTruthy();

    for (const evt of events) {
        room?.reEmitter.reEmit(evt, [MatrixEventEvent.BeforeRedaction]);
    }

    const thread = room.createThread(rootEvent.getId() ?? "", rootEvent, [rootEvent, ...events], true);

    return { thread, rootEvent, events };
};

/**
 * Create a thread, and make sure the events are added to the thread and the
 * room's timeline as if they came in via sync.
 *
 * Note that mkThread doesn't actually add the events properly to the room.
 */
export const populateThread = ({
    room,
    client,
    authorId,
    participantUserIds,
    length = 2,
    ts = 1,
}: MakeThreadProps): MakeThreadResult => {
    const ret = mkThread({ room, client, authorId, participantUserIds, length, ts });
    ret.thread.initialEventsFetched = true;
    room.addLiveEvents(ret.events);
    return ret;
};
