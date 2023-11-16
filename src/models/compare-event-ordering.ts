/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { MatrixEvent } from "./event";
import { Room } from "./room";
import { inMainTimelineForReceipt, threadIdForReceipt } from "../client";

/**
 * Determine the order of two events in a room.
 *
 * In principle this should use the same order as the server, but in practice
 * this is difficult for events that were not received over the Sync API. See
 * MSC4033 for details.
 *
 * This implementation leans on the order of events within their timelines, and
 * falls back to comparing event timestamps when they are in different
 * timelines.
 *
 * See https://github.com/matrix-org/matrix-js-sdk/issues/3325 for where we are
 * tracking the work to fix this.
 *
 * @param room - the room we are looking in
 * @param leftEventId - the id of the first event
 * @param rightEventId - the id of the second event

 * @returns -1 if left \< right, 1 if left \> right, 0 if left == right, null if
 *          we can't tell (because we can't find the events).
 */
export function compareEventOrdering(room: Room, leftEventId: string, rightEventId: string): number | null {
    const leftEvent = room.findEventById(leftEventId);
    const rightEvent = room.findEventById(rightEventId);

    if (!leftEvent || !rightEvent) {
        // Without the events themselves, we can't find their thread or
        // timeline, or guess based on timestamp, so we just don't know.
        return null;
    }

    // Check whether the events are in the main timeline
    const isLeftEventInMainTimeline = inMainTimelineForReceipt(leftEvent);
    const isRightEventInMainTimeline = inMainTimelineForReceipt(rightEvent);

    if (isLeftEventInMainTimeline && isRightEventInMainTimeline) {
        return compareEventsInMainTimeline(room, leftEventId, rightEventId, leftEvent, rightEvent);
    } else {
        // At least one event is not in the timeline, so we can't use the room's
        // unfiltered timeline set.
        return compareEventsInThreads(leftEventId, rightEventId, leftEvent, rightEvent);
    }
}

function compareEventsInMainTimeline(
    room: Room,
    leftEventId: string,
    rightEventId: string,
    leftEvent: MatrixEvent,
    rightEvent: MatrixEvent,
): number | null {
    // Get the timeline set that contains all the events.
    const timelineSet = room.getUnfilteredTimelineSet();

    // If they are in the same timeline, compareEventOrdering does what we need
    const compareSameTimeline = timelineSet.compareEventOrdering(leftEventId, rightEventId);
    if (compareSameTimeline !== null) {
        return compareSameTimeline;
    }

    // Find which timeline each event is in. Refuse to provide an ordering if we
    // can't find either of the events.

    const leftTimeline = timelineSet.getTimelineForEvent(leftEventId);
    if (leftTimeline === timelineSet.getLiveTimeline()) {
        // The left event is part of the live timeline, so it must be after the
        // right event (since they are not in the same timeline or we would have
        // returned after compareEventOrdering.
        return 1;
    }

    const rightTimeline = timelineSet.getTimelineForEvent(rightEventId);
    if (rightTimeline === timelineSet.getLiveTimeline()) {
        // The right event is part of the live timeline, so it must be after the
        // left event.
        return -1;
    }

    // They are in older timeline sets (because they were fetched by paging up).
    return guessOrderBasedOnTimestamp(leftEvent, rightEvent);
}

function compareEventsInThreads(
    leftEventId: string,
    rightEventId: string,
    leftEvent: MatrixEvent,
    rightEvent: MatrixEvent,
): number | null {
    const leftEventThreadId = threadIdForReceipt(leftEvent);
    const rightEventThreadId = threadIdForReceipt(rightEvent);

    const leftThread = leftEvent.getThread();

    if (leftThread && leftEventThreadId === rightEventThreadId) {
        // They are in the same thread, so we can ask the thread's timeline to
        // figure it out for us
        return leftThread.timelineSet.compareEventOrdering(leftEventId, rightEventId);
    } else {
        return guessOrderBasedOnTimestamp(leftEvent, rightEvent);
    }
}

/**
 * Guess the order of events based on server timestamp. This is not good, but
 * difficult to avoid without MSC4033.
 *
 * See https://github.com/matrix-org/matrix-js-sdk/issues/3325
 */
function guessOrderBasedOnTimestamp(leftEvent: MatrixEvent, rightEvent: MatrixEvent): number {
    const leftTs = leftEvent.getTs();
    const rightTs = rightEvent.getTs();
    if (leftTs < rightTs) {
        return -1;
    } else if (leftTs > rightTs) {
        return 1;
    } else {
        return 0;
    }
}
