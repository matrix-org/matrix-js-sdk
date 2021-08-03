// allow non-camelcase as these are events type that go onto the wire
/* eslint-disable camelcase */

// TODO: Change to "sdp_stream_metadata" when MSC3077 is merged
export const SDPStreamMetadataKey = "org.matrix.msc3077.sdp_stream_metadata";

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

interface CallOfferAnswer {
    type: string;
    sdp: string;
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

export interface MCallAnswer {
    answer: CallOfferAnswer;
    capabilities: CallCapabilities;
    [SDPStreamMetadataKey]: SDPStreamMetadata;
}

export interface MCallOfferNegotiate {
    offer: CallOfferAnswer;
    description: CallOfferAnswer;
    lifetime: number;
    capabilities: CallCapabilities;
    [SDPStreamMetadataKey]: SDPStreamMetadata;
}

export interface MCallSDPStreamMetadataChanged {
    [SDPStreamMetadataKey]: SDPStreamMetadata;
}

export interface MCallReplacesEvent {
    replacement_id: string;
    target_user: CallReplacesTarget;
    create_call: string;
    await_call: string;
    target_room: string;
}
/* eslint-enable camelcase */
