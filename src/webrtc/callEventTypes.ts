// allow non-camelcase as these are events type that go onto the wire
/* eslint-disable camelcase */

import { type CallErrorCode } from "./call.ts";
import { NamespacedValue } from "../NamespacedValue.ts";

export const SDPStreamMetadataKey = new NamespacedValue(
    "sdp_stream_metadata",
    "org.matrix.msc3077.sdp_stream_metadata",
);

export enum SDPStreamMetadataPurpose {
    Usermedia = "m.usermedia",
    Screenshare = "m.screenshare",
}

export interface SDPStreamMetadataObject {
    purpose: SDPStreamMetadataPurpose;
    audio_muted: boolean;
    video_muted: boolean;
}

export interface SDPStreamMetadata {
    [key: string]: SDPStreamMetadataObject;
}

export interface CallCapabilities {
    "m.call.transferee": boolean;
    "m.call.dtmf": boolean;
}

export interface CallReplacesTarget {
    id: string;
    display_name: string;
    avatar_url: string;
}

export interface MCallBase {
    call_id: string;
    conf_id?: string;
    version: string | number;
    party_id?: string;
    sender_session_id?: string;
    dest_session_id?: string;
}

type Description = Pick<RTCSessionDescription, "type" | "sdp">;

export interface MCallAnswer extends MCallBase {
    "answer": Description;
    "capabilities"?: CallCapabilities;
    "sdp_stream_metadata"?: SDPStreamMetadata;
    "org.matrix.msc3077.sdp_stream_metadata"?: SDPStreamMetadata;
}

export interface MCallSelectAnswer extends MCallBase {
    selected_party_id: string;
}

export interface MCallInviteNegotiate extends MCallBase {
    "offer": Description;
    "description": Description;
    "lifetime": number;
    "capabilities"?: CallCapabilities;
    "invitee"?: string;
    "sender_session_id"?: string;
    "dest_session_id"?: string;
    "sdp_stream_metadata"?: SDPStreamMetadata;
    "org.matrix.msc3077.sdp_stream_metadata"?: SDPStreamMetadata;
}

export interface MCallSDPStreamMetadataChanged extends MCallBase {
    "sdp_stream_metadata"?: SDPStreamMetadata;
    "org.matrix.msc3077.sdp_stream_metadata"?: SDPStreamMetadata;
}

export interface MCallReplacesEvent extends MCallBase {
    replacement_id: string;
    target_user: CallReplacesTarget;
    create_call: string;
    await_call: string;
    target_room: string;
}

export interface MCAllAssertedIdentity extends MCallBase {
    asserted_identity: {
        id: string;
        display_name: string;
        avatar_url: string;
    };
}

export interface MCallCandidates extends MCallBase {
    candidates: Omit<RTCIceCandidateInit, "usernameFragment">[];
}

export interface MCallHangupReject extends MCallBase {
    reason?: CallErrorCode;
}

/* eslint-enable camelcase */
