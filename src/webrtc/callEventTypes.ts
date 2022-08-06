// allow non-camelcase as these are events type that go onto the wire
/* eslint-disable camelcase */

import { CallErrorCode } from "./call";

// TODO: Change to "sdp_stream_metadata" when MSC3077 is merged
export const SDPStreamMetadataKey = "org.matrix.msc3077.sdp_stream_metadata";

export enum SDPStreamMetadataPurpose {
    Usermedia = "m.usermedia",
    Screenshare = "m.screenshare",
}

export interface SDPStreamMetadataObject {
    purpose: SDPStreamMetadataPurpose;
    userId?: string;
    audio_muted?: boolean;
    video_muted?: boolean;
}

export interface SDPStreamMetadata {
    [key: string]: SDPStreamMetadataObject;
}

export interface CallCapabilities {
    'm.call.transferee': boolean;
    'm.call.dtmf': boolean;
}

export interface CallReplacesTarget {
    id: string;
    display_name: string;
    avatar_url: string;
}

export interface MCallBase {
    call_id: string;
    version: string | number;
    party_id?: string;
    sender_session_id?: string;
    dest_session_id?: string;
}

export interface MCallAnswer extends MCallBase {
    answer: RTCSessionDescription;
    capabilities?: CallCapabilities;
    [SDPStreamMetadataKey]: SDPStreamMetadata;
}

export interface MCallSelectAnswer extends MCallBase {
    selected_party_id: string;
}

export interface MCallInviteNegotiate extends MCallBase {
    offer: RTCSessionDescription;
    description: RTCSessionDescription;
    lifetime: number;
    capabilities?: CallCapabilities;
    invitee?: string;
    sender_session_id?: string;
    dest_session_id?: string;
    [SDPStreamMetadataKey]: SDPStreamMetadata;
}

export interface MCallSDPStreamMetadataChanged extends MCallBase {
    [SDPStreamMetadataKey]: SDPStreamMetadata;
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
    candidates: RTCIceCandidate[];
}

export interface MCallHangupReject extends MCallBase {
    reason?: CallErrorCode;
}

export interface ISfuTrackDesc {
    stream_id: string;
    track_id: string;
}

export interface ISfuBaseDataChannelMessage {
    op: string;
    id: string;
    conf_id: string;
}

export interface ISfuSelectDataChannelMessage extends ISfuBaseDataChannelMessage {
    op: "select";
    start: ISfuTrackDesc[];
}

export interface ISfuOfferDataChannelMessage extends ISfuBaseDataChannelMessage {
    op: "offer";
    sdp: string;
}

export interface ISfuAnswerDataChannelMessage extends ISfuBaseDataChannelMessage {
    op: "answer";
    sdp: string;
}

export interface ISfuPublishDataChannelMessage extends ISfuBaseDataChannelMessage {
    op: "publish";
    sdp: string;
}

export interface ISfuUnpublishDataChannelMessage extends ISfuBaseDataChannelMessage {
    op: "unpublish";
    sdp: string;
    stop: ISfuTrackDesc[];
}

/* eslint-enable camelcase */
