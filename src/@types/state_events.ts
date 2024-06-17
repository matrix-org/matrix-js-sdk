/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { RoomType } from "./event";
import { GuestAccess, HistoryVisibility, JoinRule, RestrictedAllowType } from "./partials";
import { ImageInfo } from "./media";
import { PolicyRecommendation } from "../models/invites-ignorer";

export interface RoomCanonicalAliasEventContent {
    alias?: string;
    alt_aliases?: string[];
}

export interface RoomCreateEventContent {
    "creator"?: string;
    "m.federate"?: boolean;
    "predecessor"?: {
        event_id: string;
        room_id: string;
    };
    "room_version"?: string;
    "type"?: RoomType;
}

export interface RoomJoinRulesEventContent {
    join_rule: JoinRule;
    allow?: {
        room_id: string;
        type: RestrictedAllowType;
    }[];
}

export interface RoomMemberEventContent {
    avatar_url?: string;
    displayname?: string;
    is_direct?: boolean;
    join_authorised_via_users_server?: string;
    membership: "invite" | "join" | "knock" | "leave" | "ban";
    reason?: string;
    third_party_invite?: {
        display_name: string;
        signed: {
            mxid: string;
            token: string;
            ts: number;
        };
    };
}

export interface RoomThirdPartyInviteEventContent {
    display_name: string;
    key_validity_url: string;
    public_key: string;
    public_keys: {
        key_validity_url?: string;
        public_key: string;
    }[];
}

export interface RoomPowerLevelsEventContent {
    ban?: number;
    events?: { [eventType: string]: number };
    events_default?: number;
    invite?: number;
    kick?: number;
    notifications?: {
        room?: number;
    };
    redact?: number;
    state_default?: number;
    users?: { [userId: string]: number };
    users_default?: number;
}

export interface RoomNameEventContent {
    name: string;
}

export interface RoomTopicEventContent {
    topic: string;
}

export interface RoomAvatarEventContent {
    url?: string;
    // The spec says that an encrypted file can be used for the thumbnail but this isn't true
    // https://github.com/matrix-org/matrix-spec/issues/562 so omit those fields
    info?: Omit<ImageInfo, "thumbnail_file">;
}

export interface RoomPinnedEventsEventContent {
    pinned: string[];
}

export interface RoomEncryptionEventContent {
    algorithm: "m.megolm.v1.aes-sha2";
    rotation_period_ms?: number;
    rotation_period_msgs?: number;
}

export interface RoomHistoryVisibilityEventContent {
    history_visibility: HistoryVisibility;
}

export interface RoomGuestAccessEventContent {
    guest_access: GuestAccess;
}

export interface RoomServerAclEventContent {
    allow?: string[];
    allow_ip_literals?: boolean;
    deny?: string[];
}

export interface RoomTombstoneEventContent {
    body: string;
    replacement_room: string;
}

export interface SpaceChildEventContent {
    order?: string;
    suggested?: boolean;
    via?: string[];
}

export interface SpaceParentEventContent {
    canonical?: boolean;
    via?: string[];
}

export interface PolicyRuleEventContent {
    entity: string;
    reason: string;
    recommendation: PolicyRecommendation;
}
