/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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

// A Hero is a stripped m.room.member event which contains the key renderable fields from the event.
// It is used in MSC4186 (Simplified Sliding Sync) as a replacement for the old 'summary' field.
// The old form simply contained the hero's user ID, which forced clients to then look up the
// m.room.member event in the current state. This is entirely decoupled in SSS. To ensure this
// works in a backwards compatible way, we will A) only set displayName/avatarUrl with server-provided
// values, B) always prefer the hero values if they are set, over calling `.getMember`. This means
// in SSS mode we will always use the heroes if they exist, but in sync v2 mode these fields will
// never be set and hence we will always do getMember lookups (at the right time as well).
export type Hero = {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
};

/**
 * High level summary information for a room
 */
export interface IRoomSummary {
    /**
     * The room heroes: a selected set of members that can be used when summarising or
     * generating a name for a room. List of user IDs.
     */
    "m.heroes": string[];
    /**
     * The number of joined members in the room.
     */
    "m.joined_member_count"?: number;
    /**
     * The number of invited members in the room.
     */
    "m.invited_member_count"?: number;
}

/**
 * High level summary information for a room (MSC4186 sliding sync)
 */
export interface RoomSummaryMSC4186 {
    /**
     * The room heroes: a selected set of members that can be used when summarising or
     * generating a name for a room.
     */
    "m.heroes": Hero[];
    /**
     * The number of joined members in the room.
     */
    "m.joined_member_count"?: number;
    /**
     * The number of invited members in the room.
     */
    "m.invited_member_count"?: number;
}

interface IInfo {
    /** The title of the room (e.g. `m.room.name`) */
    title: string;
    /** The description of the room (e.g. `m.room.topic`) */
    desc?: string;
    /** The number of joined users. */
    numMembers?: number;
    /** The list of aliases for this room. */
    aliases?: string[];
    /** The timestamp for this room. */
    timestamp?: number;
}

/**
 * Construct a new Room Summary. A summary can be used for display on a recent
 * list, without having to load the entire room list into memory.
 * @param roomId - Required. The ID of this room.
 * @param info - Optional. The summary info. Additional keys are supported.
 */
export class RoomSummary {
    public constructor(
        public readonly roomId: string,
        info?: IInfo,
    ) {}
}
