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

export interface IImageInfo {
    size?: number;
    mimetype?: string;
    thumbnail_info?: { // eslint-disable-line camelcase
        w?: number;
        h?: number;
        size?: number;
        mimetype?: string;
    };
    w?: number;
    h?: number;
}

export enum Visibility {
    Public = "public",
    Private = "private",
}

export enum Preset {
    PrivateChat = "private_chat",
    TrustedPrivateChat = "trusted_private_chat",
    PublicChat = "public_chat",
}

export type ResizeMethod = "crop" | "scale";

// TODO move to http-api after TSification
export interface IAbortablePromise<T> extends Promise<T> {
    abort(): void;
}

export type IdServerUnbindResult = "no-support" | "success";

// Knock and private are reserved keywords which are not yet implemented.
export enum JoinRule {
    Public = "public",
    Invite = "invite",
    /**
     * @deprecated Reserved keyword. Should not be used. Not yet implemented.
     */
    Private = "private",
    Knock = "knock", // MSC2403 - only valid inside experimental room versions at this time.
    Restricted = "restricted", // MSC3083 - only valid inside experimental room versions at this time.
}

export enum RestrictedAllowType {
    RoomMembership = "m.room_membership", // MSC3083 - only valid inside experimental room versions at this time.
}

export enum GuestAccess {
    CanJoin = "can_join",
    Forbidden = "forbidden",
}

export enum HistoryVisibility {
    Invited = "invited",
    Joined = "joined",
    Shared = "shared",
    WorldReadable = "world_readable",
}
