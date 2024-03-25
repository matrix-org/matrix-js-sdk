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

import { MsgType, RelationType } from "./event";
import { FileInfo, ImageInfo, MediaEventContent } from "./media";
import { XOR } from "./common";

interface BaseTimelineEvent {
    "body": string;
    "m.mentions"?: {
        user_ids?: string[];
        room?: boolean;
    };
}

interface ReplyEvent {
    "m.relates_to"?: {
        "m.in_reply_to"?: {
            event_id: string;
        };
    };
}

interface NoRelationEvent {
    "m.new_content"?: never;
    "m.relates_to"?: never;
}

/**
 * Partial content format of timeline events with rel_type `m.replace`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#event-replacements
 */
export interface ReplacementEvent<T> {
    "m.new_content": T;
    "m.relates_to": {
        event_id: string;
        rel_type: RelationType.Replace;
    };
}

/**
 * Partial content format of timeline events with rel_type other than `m.replace`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#forming-relationships-between-events
 */
export interface RelationEvent {
    "m.new_content"?: never;
    "m.relates_to": {
        event_id: string;
        rel_type: Exclude<RelationType, RelationType.Replace>;
    };
}

/**
 * Content format of timeline events with type `m.room.message` and `msgtype` `m.text`, `m.emote`, or `m.notice`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mroommessage
 */
export interface RoomMessageTextEventContent extends BaseTimelineEvent {
    msgtype: MsgType.Text | MsgType.Emote | MsgType.Notice;
    format?: "org.matrix.custom.html";
    formatted_body?: string;
}

/**
 * Content format of timeline events with type `m.room.message` and `msgtype` `m.location`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mlocation
 */
export interface RoomMessageLocationEventContent extends BaseTimelineEvent {
    body: string;
    geo_uri: string;
    info: Pick<FileInfo, "thumbnail_info" | "thumbnail_file" | "thumbnail_url">;
    msgtype: MsgType.Location;
}

type MessageEventContent = RoomMessageTextEventContent | RoomMessageLocationEventContent | MediaEventContent;

export type RoomMessageEventContent = BaseTimelineEvent &
    XOR<XOR<ReplacementEvent<MessageEventContent>, RelationEvent>, XOR<ReplyEvent, NoRelationEvent>> &
    MessageEventContent;

/**
 * Content format of timeline events with type `m.sticker`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#msticker
 */
export interface StickerEventContent extends BaseTimelineEvent {
    body: string;
    info: ImageInfo;
    url: string;
}

/**
 * Content format of timeline events with type `m.reaction`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mreaction
 */
export interface ReactionEventContent {
    "m.relates_to": {
        event_id: string;
        key: string;
        rel_type: RelationType.Annotation;
    };
}
