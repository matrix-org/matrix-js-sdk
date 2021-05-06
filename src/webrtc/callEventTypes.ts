// allow camelcase as these are events type that go onto the wire
/* eslint-disable camelcase */

// TODO: Change to "sdp_stream_metadata" when MSC3077 is merged
export const SDPStreamMetadataKey = "org.matrix.msc3077.sdp_stream_metadata";

export enum SDPStreamMetadataPurpose {
    Usermedia = "m.usermedia",
    Screenshare = "m.screenshare",
}

export interface SDPStreamMetadataObject {
    purpose: SDPStreamMetadataPurpose,
}

export interface SDPStreamMetadata {
    [key: string]: SDPStreamMetadataObject,
}

interface CallOfferAnswer {
    type: string;
    sdp: string;
}

export interface CallCapabilities {
    'm.call.transferee': boolean;
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

export interface MCallReplacesTarget {
    id: string;
    display_name: string;
    avatar_url: string;
}

export interface MCallReplacesEvent {
    replacement_id: string;
    target_user: MCallReplacesTarget;
    create_call: string;
    await_call: string;
    target_room: string;
}
/* eslint-enable camelcase */
