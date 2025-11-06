import { type IContent } from "../../matrix.ts";
import { type RTCCallIntent, type Transport } from "../types.ts";
import { MatrixRTCMembershipParseError } from "./common.ts";

/**
 * **Legacy** (MatrixRTC) session membership data.
 * This represents the *OLD* form of MSC4143.
 * Represents the `session` in the memberships section of an m.call.member event as it is on the wire.
 **/
export type SessionMembershipData = {
    /**
     * The RTC application defines the type of the RTC session.
     */
    "application": string;

    /**
     * The id of this session.
     * A session can never span over multiple rooms so this id is to distinguish between
     * multiple session in one room. A room wide session that is not associated with a user,
     * and therefore immune to creation race conflicts, uses the `call_id: ""`.
     */
    "call_id": string;

    /**
     * The Matrix device ID of this session. A single user can have multiple sessions on different devices.
     */
    "device_id": string;

    /**
     * The focus selection system this user/membership is using.
     * NOTE: This is still included for legacy reasons, but not consumed by the SDK.
     */
    "focus_active": {
        type: string;
        focus_selection: "oldest_membership" | string;
    };

    /**
     * A list of possible foci this user knows about. One of them might be used based on the focus_active
     * selection system.
     */
    "foci_preferred": Transport[];

    /**
     * Optional field that contains the creation of the session. If it is undefined the creation
     * is the `origin_server_ts` of the event itself. For updates to the event this property tracks
     * the `origin_server_ts` of the initial join event.
     *  - If it is undefined it can be interpreted as a "Join".
     *  - If it is defined it can be interpreted as an "Update"
     */
    "created_ts"?: number;

    // Application specific data

    /**
     * If the `application` = `"m.call"` this defines if it is a room or user owned call.
     * There can always be one room scoped call but multiple user owned calls (breakout sessions)
     */
    "scope"?: "m.room" | "m.user";

    /**
     * Optionally we allow to define a delta to the `created_ts` that defines when the event is expired/invalid.
     * This should be set to multiple hours. The only reason it exist is to deal with failed delayed events.
     * (for example caused by a homeserver crashes)
     **/
    "expires"?: number;

    /**
     * The intent of the call from the perspective of this user. This may be an audio call, video call or
     * something else.
     */
    "m.call.intent"?: RTCCallIntent;
};

/**
 * Validates that `data` matches the format expected by the legacy form of MSC4143.
 * @param data The event content.
 * @returns true if `data` is valid SessionMembershipData
 * @throws {MatrixRTCMembershipParseError} if the content is not valid
 */
export const checkSessionsMembershipData = (data: IContent): data is SessionMembershipData => {
    const prefix = " - ";
    const errors: string[] = [];
    if (typeof data.device_id !== "string") errors.push(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") errors.push(prefix + "call_id must be string");
    if (typeof data.application !== "string") errors.push(prefix + "application must be a string");
    if (data.focus_active === undefined) {
        errors.push(prefix + "focus_active has an invalid type");
    }
    if (typeof data.focus_active?.type !== "string") {
        errors.push(prefix + "focus_active.type must be a string");
    }
    if (
        data.foci_preferred !== undefined &&
        !(
            Array.isArray(data.foci_preferred) &&
            data.foci_preferred.every(
                (f: Transport) => typeof f === "object" && f !== null && typeof f.type === "string",
            )
        )
    ) {
        errors.push(prefix + "foci_preferred must be an array of transport objects");
    }
    // optional parameters
    if (data.created_ts !== undefined && typeof data.created_ts !== "number") {
        errors.push(prefix + "created_ts must be number");
    }

    // application specific data (we first need to check if they exist)
    if (data.scope !== undefined && typeof data.scope !== "string") errors.push(prefix + "scope must be string");

    if (data["m.call.intent"] !== undefined && typeof data["m.call.intent"] !== "string") {
        errors.push(prefix + "m.call.intent must be a string");
    }

    if (errors.length) {
        throw new MatrixRTCMembershipParseError("bar", errors);
    }

    return true;
};
