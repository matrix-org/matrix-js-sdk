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

import { IContent, IEvent } from "../models/event";
import { Preset, Visibility } from "./partials";
import { IEventWithRoomId, SearchKey } from "./search";
import { IRoomEventFilter } from "../filter";
import { Direction } from "../models/event-timeline";
import { PushRuleAction } from "./PushRules";
import { IRoomEvent } from "../sync-accumulator";
import { EventType, RelationType, RoomType } from "./event";

// allow camelcase as these are things that go onto the wire
/* eslint-disable camelcase */

export interface IJoinRoomOpts {
    /**
     * True to do a room initial sync on the resulting
     * room. If false, the <strong>returned Room object will have no current state.
     * </strong> Default: true.
     */
    syncRoom?: boolean;

    /**
     * If the caller has a keypair 3pid invite, the signing URL is passed in this parameter.
     */
    inviteSignUrl?: string;

    /**
     * The server names to try and join through in addition to those that are automatically chosen.
     */
    viaServers?: string[];
}

export interface KnockRoomOpts {
    /**
     * The reason for the knock.
     */
    reason?: string;

    /**
     * The server names to try and knock through in addition to those that are automatically chosen.
     */
    viaServers?: string | string[];
}

export interface IRedactOpts {
    reason?: string;
    /**
     * If specified, then any events which relate to the event being redacted with
     * any of the relationship types listed will also be redacted.
     * Provide a "*" list item to tell the server to redact relations of any type.
     *
     * <b>Raises an Error if the server does not support it.</b>
     * Check for server-side support before using this param with
     * <code>client.canSupport.get(Feature.RelationBasedRedactions)</code>.
     * {@link https://github.com/matrix-org/matrix-spec-proposals/pull/3912}
     */
    with_rel_types?: Array<RelationType | "*">;
}

export interface ISendEventResponse {
    event_id: string;
}

export type TimeoutDelay = {
    delay: number;
};

export type ParentDelayId = {
    parent_delay_id: string;
};

export type SendTimeoutDelayedEventRequestOpts = TimeoutDelay & Partial<ParentDelayId>;
export type SendActionDelayedEventRequestOpts = ParentDelayId;

export type SendDelayedEventRequestOpts = SendTimeoutDelayedEventRequestOpts | SendActionDelayedEventRequestOpts;

export type SendDelayedEventResponse = {
    delay_id: string;
};

export enum UpdateDelayedEventAction {
    Cancel = "cancel",
    Restart = "restart",
    Send = "send",
}

export type UpdateDelayedEventRequestOpts = SendDelayedEventResponse & {
    action: UpdateDelayedEventAction;
};

type DelayedPartialTimelineEvent = {
    room_id: string;
    type: string;
    content: IContent;
};

type DelayedPartialStateEvent = DelayedPartialTimelineEvent & {
    state_key: string;
    transaction_id: string;
};

type DelayedPartialEvent = DelayedPartialTimelineEvent | DelayedPartialStateEvent;

export type DelayedEventInfo = {
    delayed_events: DelayedPartialEvent &
        SendDelayedEventResponse &
        SendDelayedEventRequestOpts &
        {
            running_since: number;
        }[];
    next_batch?: string;
};

export interface IPresenceOpts {
    // One of "online", "offline" or "unavailable"
    presence: "online" | "offline" | "unavailable";
    // The status message to attach.
    status_msg?: string;
}

export interface IPaginateOpts {
    // true to fill backwards, false to go forwards
    backwards?: boolean;
    // number of events to request
    limit?: number;
}

export interface IGuestAccessOpts {
    /**
     * True to allow guests to join this room. This
     * implicitly gives guests write access. If false or not given, guests are
     * explicitly forbidden from joining the room.
     */
    allowJoin: boolean;
    /**
     * True to set history visibility to
     * be world_readable. This gives guests read access *from this point forward*.
     * If false or not given, history visibility is not modified.
     */
    allowRead: boolean;
}

export interface ISearchOpts {
    keys?: SearchKey[];
    query: string;
}

export interface IEventSearchOpts {
    // a JSON filter object to pass in the request
    filter?: IRoomEventFilter;
    // the term to search for
    term: string;
}

export interface IInvite3PID {
    id_server: string;
    id_access_token?: string; // this gets injected by the js-sdk
    medium: string;
    address: string;
}

export interface ICreateRoomStateEvent {
    type: string;
    state_key?: string; // defaults to an empty string
    content: IContent;
}

export interface ICreateRoomOpts {
    // The alias localpart to assign to this room.
    room_alias_name?: string;
    // Either 'public' or 'private'.
    visibility?: Visibility;
    // The name to give this room.
    name?: string;
    // The topic to give this room.
    topic?: string;
    preset?: Preset;
    power_level_content_override?: {
        ban?: number;
        events?: Record<EventType | string, number>;
        events_default?: number;
        invite?: number;
        kick?: number;
        notifications?: Record<string, number>;
        redact?: number;
        state_default?: number;
        users?: Record<string, number>;
        users_default?: number;
    };
    creation_content?: object;
    initial_state?: ICreateRoomStateEvent[];
    // A list of user IDs to invite to this room.
    invite?: string[];
    invite_3pid?: IInvite3PID[];
    is_direct?: boolean;
    room_version?: string;
}

export interface IRoomDirectoryOptions {
    /**
     * The remote server to query for the room list.
     * Optional. If unspecified, get the local homeserver's public room list.
     */
    server?: string;
    /**
     * Maximum number of entries to return
     */
    limit?: number;
    /**
     * Token to paginate from
     */
    since?: string;

    /** Filter parameters */
    filter?: {
        // String to search for
        generic_search_term?: string;
        room_types?: Array<RoomType | null>;
    };
    include_all_networks?: boolean;
    third_party_instance_id?: string;
}

export interface IAddThreePidOnlyBody {
    auth?: {
        type: string;
        session?: string;
    };
    client_secret: string;
    sid: string;
}

export interface IBindThreePidBody {
    client_secret: string;
    id_server: string;
    // Some older identity servers have no auth enabled
    id_access_token: string | null;
    sid: string;
}

export interface IRelationsRequestOpts {
    from?: string;
    to?: string;
    limit?: number;
    dir?: Direction;
    recurse?: boolean; // MSC3981 Relations Recursion https://github.com/matrix-org/matrix-spec-proposals/pull/3981
}

export interface IRelationsResponse {
    chunk: IEvent[];
    next_batch?: string;
    prev_batch?: string;
}

export interface IContextResponse {
    end: string;
    start: string;
    state: IEventWithRoomId[];
    events_before: IEventWithRoomId[];
    events_after: IEventWithRoomId[];
    event: IEventWithRoomId;
}

export interface IEventsResponse {
    chunk: IEventWithRoomId[];
    end: string;
    start: string;
}

export interface INotification {
    actions: PushRuleAction[];
    event: IRoomEvent;
    profile_tag?: string;
    read: boolean;
    room_id: string;
    ts: number;
}

export interface INotificationsResponse {
    next_token: string;
    notifications: INotification[];
}

export interface IFilterResponse {
    filter_id: string;
}

export interface ITagsResponse {
    tags: {
        [tagId: string]: {
            order: number;
        };
    };
}

export interface IStatusResponse extends IPresenceOpts {
    currently_active?: boolean;
    last_active_ago?: number;
}

/* eslint-enable camelcase */
