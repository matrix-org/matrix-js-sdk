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

/**
 * The type of the LiveKit transport as defined in the stable version of
 * [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export const LIVEKIT_TRANSPORT_TYPE = "m.livekit";

/**
 * The type of the LiveKit transport used by implementations of earlier versions of
 * [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export const LEGACY_LIVEKIT_TRANSPORT_TYPE = "livekit";

type LivekitTransportType = typeof LIVEKIT_TRANSPORT_TYPE | typeof LEGACY_LIVEKIT_TRANSPORT_TYPE;

/**
 * @deprecated Use {@link UnstableLivekitTransport} instead, which has multiple
 *   variants to support the migration to newer versions of MSC4195.
 */
export interface LivekitTransport extends Transport {
    type: "livekit";
    livekit_service_url: string;
}

/**
 * @deprecated Use {@link isUnstableLivekitTransport} instead.
 */
export const isLivekitTransport = (object: unknown): object is LivekitTransport => {
    if (typeof object !== "object" || object === null) return false;
    const transport = object as Transport;

    return transport.type === "livekit" && typeof transport.livekit_service_url === "string";
};

/**
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
type WebsocketUrl = {
    /**
     * WebSocket URL of the LiveKit server.
     */
    url: string;
    /**
     * The server name of the homeserver that operates the SFU at `url`.
     *
     * When omitted, the SFU belongs to the homeserver of the member event's sender.
     */
    server_name?: string;
};

type ServiceUrl = {
    /**
     * Base URL of the LiveKit JWT service.
     */
    livekit_service_url: string;
};

/**
 * Any LiveKit transport that can be advertised by a homeserver or published by
 * a session member: `url` only, `livekit_service_url` only, or both during the
 * migration.
 *
 * It uses the `Unstable` prefix as it includes the `livekit` type and the
 * `livekit_service_url` case which are only here for compatibility reasons.
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export type UnstableLivekitTransport = { type: LivekitTransportType } & LivekitTransportUrls;

type LivekitTransportUrls =
    // Latest MSC4195 variant, with `url`. Indicates that both publishers and
    // subscribers will use the /_matrix/client/v1/rtc/livekit/get_token
    // endpoint.
    | WebsocketUrl
    // Legacy variant, with `livekit_service_url`. Indicates that both
    // publishers and subscribers will use the endpoints of the provided LiveKit
    // JWT service.
    | ServiceUrl
    // Transitional variant, with both `url` and `livekit_service_url`.
    // Indicates that both publishers and subscribers may use either the
    // /_matrix/client/v1/rtc/livekit/get_token endpoint or the provided LiveKit
    // JWT service.
    | (WebsocketUrl & ServiceUrl);

export const isUnstableLivekitTransport = (object: unknown): object is UnstableLivekitTransport => {
    if (typeof object !== "object" || object === null) return false;
    const transport = object as Transport;

    if (transport.type !== LIVEKIT_TRANSPORT_TYPE && transport.type !== LEGACY_LIVEKIT_TRANSPORT_TYPE) return false;
    if (!("url" in transport || "livekit_service_url" in transport)) return false;
    if ("url" in transport && typeof transport.url !== "string") return false;
    if ("livekit_service_url" in transport && typeof transport.livekit_service_url !== "string") return false;
    // `server_name` only has meaning alongside `url`. It names the homeserver associated with the URL.
    if ("server_name" in transport && (typeof transport.server_name !== "string" || !("url" in transport)))
        return false;
    return true;
};

/**
 * A LiveKit transport with an SFU WebSocket `url`.
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export type UnstableLivekitTransportWithUrl = UnstableLivekitTransport & WebsocketUrl;

/**
 * Checks whether an object represents a LiveKit transport with an SFU WebSocket `url`.
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export const isUnstableLivekitTransportWithUrl = (object: unknown): object is UnstableLivekitTransportWithUrl =>
    isUnstableLivekitTransport(object) && "url" in object;

/**
 * Selects the LiveKit transport to use from a list of advertised transports. Picks the first
 * `m.livekit` transport, otherwise the first `livekit` transport.
 *
 * @returns The selected transport.
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export function selectLivekitTransport(transports: Transport[]): UnstableLivekitTransport | undefined {
    const livekitTransports = transports.filter(isUnstableLivekitTransport);
    return livekitTransports.find((t) => t.type === LIVEKIT_TRANSPORT_TYPE) ?? livekitTransports[0];
}

/**
 * @deprecated this is just needed for the old focus active / focus fields of a call membership.
 * Not needed for new implementations.
 */
export interface LivekitFocusSelection extends Transport {
    type: "livekit";
    focus_selection: "multi_sfu";
}
/**
 * @deprecated see LivekitFocusSelection
 */
export const isLivekitFocusSelection = (object: any): object is LivekitFocusSelection =>
    object.type === "livekit" && "focus_selection" in object;

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
     * The `member.id` value from the `m.rtc.member` event.
     */
    member_id: string;
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
     * The `member.id` value from the `m.rtc.member` event.
     */
    member_id: string;
    /**
     * The delay ID of the delayed leave event to hand over to the homeserver.
     */
    delay_id: string;
};
