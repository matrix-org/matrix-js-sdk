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

import { THREAD_RELATION_TYPE } from "./models/thread";
import { IEvent } from "./models/event";

/**
 * Returns a filter function for the /relations endpoint to filter out relations directly
 * to the thread root event that should not live in the thread timeline
 *
 * @param threadId - the thread ID (ie. the event ID of the root event of the thread)
 * @returns the filtered list of events
 */
export function getRelationsThreadFilter(threadId: string): (e: Partial<IEvent>) => boolean {
    return (e: Partial<IEvent>) =>
        e.content?.["m.relates_to"]?.event_id !== threadId ||
        e.content?.["m.relates_to"]?.rel_type === THREAD_RELATION_TYPE.name;
}
