/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

/**
 * The room summary endpoint, which describes a room the user may not be in.
 * https://spec.matrix.org/latest/client-server-api/#room-summaries
 *
 * Not to be confused with {@link RoomSummary} in `./models/room-summary.ts`, which holds the
 * heroes and member counts that `/sync` sends for rooms we are in.
 */

import { type IPublicRoomsChunkRoom } from "./client.ts";
import { ClientPrefix, type IHttpOpts, MatrixError, type MatrixHttpApi, Method } from "./http-api/index.ts";
import { type JoinRule } from "./@types/partials.ts";
import { type Membership } from "./@types/membership.ts";
import * as utils from "./utils.ts";

/**
 * The summary of a room, as returned by the room summary endpoint.
 * https://spec.matrix.org/latest/client-server-api/#get_matrixclientv1room_summaryroomidoralias
 *
 * Also covers the initial version of MSC3266 implemented in older versions of Synapse, which
 * prefixed some of the fields. See {@link MatrixClient.getRoomSummary}.
 */
export interface RoomSummary extends Omit<IPublicRoomsChunkRoom, "canonical_alias" | "aliases" | "join_rule"> {
    /**
     * The current membership of this user in the room.
     */
    "membership"?: Membership;
    /**
     * The join rule of the room. Unlike the join rule of a public rooms chunk, this may be any
     * join rule, since the room does not have to be published to the room directory.
     */
    "join_rule"?: JoinRule;
    /**
     * The canonical alias of the room, if any.
     */
    "canonical_alias"?: string;
    /**
     * Version of the room.
     */
    "room_version"?: string;
    /**
     * The encryption algorithm used for this room, if the room is encrypted.
     */
    "encryption"?: string;
    /**
     * For restricted rooms, the room IDs which are specified by the join rule.
     */
    "allowed_room_ids"?: string[];
    /**
     * Version of the room.
     * @deprecated Only returned by the unstable endpoint; use {@link RoomSummary.room_version}.
     */
    "im.nheko.summary.room_version"?: string;
    /**
     * The encryption algorithm used for this room, if the room is encrypted.
     * @deprecated Only returned by the unstable endpoint; use {@link RoomSummary.encryption}.
     */
    "im.nheko.summary.encryption"?: string;
}

/** The prefix used by the initial version of MSC3266, as implemented in older versions of Synapse. */
const UNSTABLE_PREFIX = "/_matrix/client/unstable/im.nheko.summary";

/**
 * Fetch the summary of a room.
 *
 * Falls back to the two paths used by an initial version of MSC3266, as implemented in older
 * versions of Synapse, if the server does not recognise the stable endpoint.
 *
 * @param http - The HTTP API to make the request with.
 * @param roomIdOrAlias - The ID or alias of the room to get the summary of.
 * @param via - The servers to attempt to request the summary from, when the local server cannot
 *              generate it (for instance, because it has no local user in the room).
 */
export async function fetchRoomSummary(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    roomIdOrAlias: string,
    via?: string[],
): Promise<RoomSummary> {
    try {
        const path = utils.encodeUri("/room_summary/$roomid", { $roomid: roomIdOrAlias });
        return await http.authedRequest<RoomSummary>(Method.Get, path, { via }, undefined, {
            prefix: ClientPrefix.V1,
        });
    } catch (e) {
        // Only an unrecognised endpoint means we should try the unstable paths. Anything else,
        // such as a 404 for a room we cannot see, is a real answer and must be passed on.
        if (!(e instanceof MatrixError) || e.errcode !== "M_UNRECOGNIZED") throw e;
    }

    const paramOpts = { prefix: UNSTABLE_PREFIX };
    try {
        const path = utils.encodeUri("/summary/$roomid", { $roomid: roomIdOrAlias });
        return await http.authedRequest<RoomSummary>(Method.Get, path, { via }, undefined, paramOpts);
    } catch (e) {
        if (e instanceof MatrixError && e.errcode === "M_UNRECOGNIZED") {
            const path = utils.encodeUri("/rooms/$roomid/summary", { $roomid: roomIdOrAlias });
            return await http.authedRequest<RoomSummary>(Method.Get, path, { via }, undefined, paramOpts);
        } else {
            throw e;
        }
    }
}
