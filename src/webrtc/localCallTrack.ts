/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { logger } from "../logger";
import { MatrixCall } from "./call";
import { SDPStreamMetadataPurpose, SDPStreamMetadataTrack } from "./callEventTypes";
import { CallTrack, CallTrackOpts } from "./callTrack";
import { LocalCallFeed } from "./localCallFeed";

export enum SimulcastResolution {
    Full = "f",
    Half = "h",
    Quarter = "q",
}

// Order is important here: some browsers (e.g.
// Chrome) will only send some of the encodings, if
// the track has a resolution to low for it to send
// all, in that case the encoding higher in the list
// has priority and therefore we put full as first
// as we always want to send the full resolution
const SIMULCAST_USERMEDIA_ENCODINGS: RTCRtpEncodingParameters[] = [
    {
        // 720p (base)
        maxFramerate: 30,
        maxBitrate: 1_700_000,
        rid: SimulcastResolution.Full,
    },
    {
        // 360p
        maxFramerate: 20,
        maxBitrate: 300_000,
        rid: SimulcastResolution.Half,
        scaleResolutionDownBy: 2.0,
    },
    {
        // 180p
        maxFramerate: 15,
        maxBitrate: 120_000,

        rid: SimulcastResolution.Quarter,
        scaleResolutionDownBy: 4.0,
    },
];

const SIMULCAST_SCREENSHARING_ENCODINGS: RTCRtpEncodingParameters[] = [
    {
        // 1080p (base)
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        rid: SimulcastResolution.Full,
    },
    {
        // 720p
        maxFramerate: 15,
        maxBitrate: 1_000_000,
        rid: SimulcastResolution.Half,
        scaleResolutionDownBy: 1.5,
    },
    {
        // 360p
        maxFramerate: 3,
        maxBitrate: 200_000,
        rid: SimulcastResolution.Quarter,
        scaleResolutionDownBy: 3,
    },
];

export const getSimulcastEncodings = (purpose: SDPStreamMetadataPurpose): RTCRtpEncodingParameters[] => {
    if (purpose === SDPStreamMetadataPurpose.Usermedia) {
        return SIMULCAST_USERMEDIA_ENCODINGS;
    }
    if (purpose === SDPStreamMetadataPurpose.Screenshare) {
        return SIMULCAST_SCREENSHARING_ENCODINGS;
    }

    // Fallback to usermedia encodings
    return SIMULCAST_USERMEDIA_ENCODINGS;
};

export interface LocalCallTrackOpts extends CallTrackOpts {
    feed: LocalCallFeed;
    track: MediaStreamTrack;
}

export class LocalCallTrack extends CallTrack {
    private _track: MediaStreamTrack;
    private feed: LocalCallFeed;
    private call?: MatrixCall;

    public constructor(opts: LocalCallTrackOpts) {
        super(opts);

        this._track = opts.track;
        this.feed = opts.feed;
    }

    private get logInfo(): string {
        return `streamId=${this.streamId}, trackId=${this.trackId}, mid=${this.mid} kind=${this.kind}`;
    }

    public get id(): string | undefined {
        return this._id;
    }

    public get metadata(): SDPStreamMetadataTrack {
        const trackMetadata: SDPStreamMetadataTrack = {
            kind: this.track.kind,
        };

        if (this.isVideo) {
            trackMetadata.width = this.track.getSettings().width;
            trackMetadata.height = this.track.getSettings().height;
        }

        return trackMetadata;
    }

    public get mid(): string | undefined {
        return this._transceiver?.mid ?? undefined;
    }

    public get trackId(): string | undefined {
        const mid = this._transceiver?.mid;
        return mid ? this.call?.getLocalTrackIdByMid(mid) : undefined;
    }

    public get streamId(): string | undefined {
        const mid = this._transceiver?.mid;
        return mid ? this.call?.getLocalStreamIdByMid(mid) : undefined;
    }

    public get track(): MediaStreamTrack {
        return this._track;
    }

    public get kind(): string {
        return this.track.kind;
    }

    public get purpose(): SDPStreamMetadataPurpose {
        return this.feed.purpose;
    }

    public get stream(): MediaStream | undefined {
        return this.feed.stream;
    }

    public get sender(): RTCRtpSender | undefined {
        return this._transceiver?.sender;
    }

    public get encodings(): RTCRtpEncodingParameters[] {
        return getSimulcastEncodings(this.purpose);
    }

    public get published(): boolean {
        if (!this._transceiver?.sender) return false;
        if (!this.call) return false;

        return true;
    }

    public publish(call: MatrixCall): void {
        if (this.published) {
            throw new Error("Cannot publish already published track");
        }

        try {
            this._transceiver = call.publishTrack(this);
        } finally {
            this.call = call;
        }
    }

    public unpublish(): void {
        const call = this.call;
        if (!this.published || !call) {
            throw new Error("Cannot unpublish track that is not published");
        }

        try {
            call.unpublishTrack(this);
        } finally {
            this.call = undefined;
            this._transceiver = undefined;
        }
    }

    public setNewTrack(track: MediaStreamTrack): void {
        this._track = track;
        const stream = this.stream;
        const sender = this.sender;
        const transceiver = this._transceiver;

        logger.log(`LocalCallTrack ${this.id} setNewTrack() running (${this.logInfo})`);

        if (!this.call) return;
        // XXX: We don't re-use transceivers with the SFU: this is to work around
        // https://github.com/matrix-org/waterfall/issues/98 - see the bug for more.
        // Since we use WebRTC data channels to renegotiate with the SFU, we're not
        // limited to the size of a Matrix event, so it's 'ok' if the SDP grows
        // indefinitely (although presumably this would break if we tried to do
        // an ICE restart over to-device messages after you'd turned screen sharing
        // on & off too many times...)
        if (!transceiver || !sender || (this.call.isFocus && this.purpose === SDPStreamMetadataPurpose.Screenshare)) {
            const call = this.call;
            this.unpublish();
            this.publish(call);
            return;
        }

        logger.log(`LocalCallTrack LocalCallTrack ${this.id} setNewTrack() replacing track (${this.logInfo})`);

        try {
            // We already have a sender, so we re-use it. We try to
            // re-use transceivers as much as possible because they
            // can't be removed once added, so otherwise they just
            // accumulate which makes the SDP very large very quickly:
            // in fact it only takes about 6 video tracks to exceed the
            // maximum size of an Olm-encrypted Matrix event - Dave

            // setStreams() is currently not supported by Firefox but we
            // try to use it at least in other browsers (once we switch
            // to using mids and throw away streamIds we will be able to
            // throw this away)
            if (sender.setStreams && stream) sender.setStreams(stream);

            sender.replaceTrack(track);

            // We don't need to set simulcast encodings in here since we
            // have already done that the first time we added the
            // transceiver

            // Set the direction of the transceiver to indicate we're
            // going to be sending. This may trigger re-negotiation, if
            // we weren't sending until now
            transceiver.direction = transceiver.direction === "inactive" ? "sendonly" : "sendrecv";
        } catch (error) {
            logger.warn(
                `LocalCallTrack ${this.id} setNewTrack() failed to replace track: falling back to publishing a new one (${this.logInfo})`,
            );
            if (this.call) {
                this.publish(this.call);
            }
        }
    }
}
