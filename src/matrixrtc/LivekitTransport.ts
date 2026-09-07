/*
Copyright 2025 New Vector Ltd

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

import { type Transport } from "./types.ts";

export interface LivekitTransportConfig extends Transport {
    type: "livekit";
    livekit_service_url: string;
}

export const isLivekitTransportConfig = (object: any): object is LivekitTransportConfig =>
    object.type === "livekit" && "livekit_service_url" in object;

export interface LivekitTransport extends LivekitTransportConfig {
    livekit_alias: string;
}

export const isLivekitTransport = (object: any): object is LivekitTransport =>
    isLivekitTransportConfig(object) && "livekit_alias" in object;

/**
 * @deprecated this is just needed for the old focus active / focus fields of a call membership.
 * Not needed for new implementations.
 */
export interface LivekitFocusSelection extends Transport {
    type: "livekit";
    focus_selection: "oldest_membership" | "multi_sfu";
}
/**
 * @deprecated see LivekitFocusSelection
 */
export const isLivekitFocusSelection = (object: any): object is LivekitFocusSelection =>
    object.type === "livekit" && "focus_selection" in object;

/**
 * Identifies the MatrixRTC membership that a LiveKit request is made for (MSC4195).
 *
 * Note that this is *not* the `member` field of an `m.rtc.member` event verbatim: the homeserver knows
 * the user ID from the access token, and the device ID is only ever claimed, never verified.
 */
export interface LivekitRtcMember {
    /**
     * The ID of the member within the MatrixRTC session, i.e. the `member.id` of the `m.rtc.member` event.
     */
    id: string;
    /**
     * The device ID the member claims to be using, i.e. the `member.device_id` of the `m.rtc.member` event.
     */
    claimed_device_id?: string;
}

/**
 * The body of a request to the LiveKit `get_token` endpoint (MSC4195).
 *
 * Declared as a type alias rather than an interface so that it can be passed to the widget API
 * (MSC4533), which expects request data to be assignable to an index signature.
 */
export type LivekitGetTokenRequest = {
    /**
     * The WebSocket URL of the LiveKit SFU to obtain a token for.
     */
    url: string;
    /**
     * The room ID of the Matrix room the `m.rtc.member` event is in.
     */
    room_id: string;
    /**
     * The slot ID from the `m.rtc.member` event.
     */
    slot_id: string;
    /**
     * The MatrixRTC membership to obtain a token for.
     */
    member: LivekitRtcMember;
    /**
     * The server name of the `m.rtc.member` event's sender. If omitted, the homeserver uses its own
     * server name. This is what makes it possible to obtain a token for an SFU of a remote homeserver.
     */
    server_name?: string;
};

/**
 * The response of the LiveKit `get_token` endpoint (MSC4195).
 */
export interface LivekitGetTokenResponse {
    /**
     * The JWT to authenticate with when connecting to the SFU.
     */
    jwt: string;
}

/**
 * The body of a request to the LiveKit `delegate_delayed_leave` endpoint (MSC4195).
 *
 * Declared as a type alias rather than an interface so that it can be passed to the widget API
 * (MSC4533), which expects request data to be assignable to an index signature.
 */
export type LivekitDelegateDelayedLeaveRequest = {
    /**
     * The WebSocket URL of the LiveKit SFU that we are connected to.
     */
    url: string;
    /**
     * The room ID of the Matrix room the `m.rtc.member` event is in.
     */
    room_id: string;
    /**
     * The slot ID from the `m.rtc.member` event.
     */
    slot_id: string;
    /**
     * The MatrixRTC membership the delayed leave event belongs to.
     */
    member: LivekitRtcMember;
    /**
     * The delay ID of the delayed leave event to hand over to the homeserver.
     */
    delay_id: string;
};
