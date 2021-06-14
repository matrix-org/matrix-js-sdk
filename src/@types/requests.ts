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

import { Callback } from "../client";

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

export interface IRedactOpts {
    reason?: string;
}

export interface ISendEventResponse {
    event_id: string; // eslint-disable-line camelcase
}

export interface IPresenceOpts {
    presence: "online" | "offline" | "unavailable";
    status_msg?: string; // eslint-disable-line camelcase
}

export interface IPaginateOpts {
    backwards?: boolean;
    limit?: number;
}

export interface IGuestAccessOpts {
    allowJoin: boolean;
    allowRead: boolean;
}

export interface ISearchOpts {
    keys?: string[];
    query: string;
}

export interface IEventSearchOpts {
    filter: any; // TODO: Types
    term: string;
}

// allow camelcase as these are things go onto the wire
/* eslint-disable camelcase */
export interface ICreateRoomOpts {
    room_alias_name?: string;
    visibility?: "public" | "private";
    name?: string;
    topic?: string;
    preset?: string;
    power_level_content_override?: any;
    creation_content?: any;
    initial_state?: {type: string, state_key: string, content: any}[];
    // TODO: Types (next line)
    invite_3pid?: any[];
}
/* eslint-enable camelcase */

export interface IRoomDirectoryOptions {
    server?: string;
    limit?: number;
    since?: string;

    // TODO: Proper types
    filter?: any & {generic_search_term: string};  // eslint-disable-line camelcase
}

export interface IUploadOpts {
    name?: string;
    includeFilename?: boolean;
    type?: string;
    rawResponse?: boolean;
    onlyContentUri?: boolean;
    callback?: Callback;
    progressHandler?: (state: {loaded: number, total: number}) => void;
}
