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
    thumbnail_info?: {
        // eslint-disable-line camelcase
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

export type IdServerUnbindResult = "no-support" | "success";

// Knock and private are reserved keywords which are not yet implemented.
export enum JoinRule {
    Public = "public",
    Invite = "invite",
    /**
     * @deprecated Reserved keyword. Should not be used. Not yet implemented.
     */
    Private = "private",
    Knock = "knock",
    Restricted = "restricted",
}

export enum RestrictedAllowType {
    RoomMembership = "m.room_membership",
}

export interface IJoinRuleEventContent {
    join_rule: JoinRule; // eslint-disable-line camelcase
    allow?: {
        type: RestrictedAllowType;
        room_id: string; // eslint-disable-line camelcase
    }[];
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

export interface IUsageLimit {
    // "hs_disabled" is NOT a specced string, but is used in Synapse
    // This is tracked over at https://github.com/matrix-org/synapse/issues/9237
    // eslint-disable-next-line camelcase
    limit_type: "monthly_active_user" | "hs_disabled" | string;
    // eslint-disable-next-line camelcase
    admin_contact?: string;
}

/**
 * Well-known values (from the spec or MSCs) that are allowed in the
 * {@link Membership} type.
 */
export enum KnownMembership {
    /**
     * The user has been banned from the room, and is no longer allowed to join
     * it until they are un-banned from the room (by having their membership
     * state set to a value other than ban).
     */
    Ban = "ban",
    /**
     * The user has been invited to join a room, but has not yet joined it.
     * They may not participate in the room until they join.
     * */
    Invite = "invite",
    /**
     * The user has joined the room (possibly after accepting an invite), and
     * may participate in it.
     */
    Join = "join",
    /**
     * The user has knocked on the room, requesting permission to participate.
     * They may not participate in the room until they join.
     */
    Knock = "knock",
    /**
     * The user was once joined to the room, but has since left (possibly by
     * choice, or possibly by being kicked).
     */
    Leave = "leave",
}

/**
 * The membership state for a user in a room [1]. A value from
 * {@link KnownMembership} should be used where available, but all string values
 * are allowed to provide flexibility for upcoming spec changes or proposals.
 *
 * [1] https://spec.matrix.org/latest/client-server-api/#mroommember
 */
export type Membership = KnownMembership | string;
