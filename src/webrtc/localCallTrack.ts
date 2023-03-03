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
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { CallTrack, CallTrackOpts } from "./callTrack";
import { LocalCallFeed } from "./localCallFeed";
import { TrackPublication } from "./trackPublication";

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

/**
 * LocalCallTrack is a wrapper around a MediaStream. It represents a track of a
 * stream which we retrieved using get user/display media. N.B. that this is not
 * linked to a specific peer connection, a TrackPublication is used for that
 * purpose.
 */
export class LocalCallTrack extends CallTrack {
    private _track: MediaStreamTrack;
    private feed: LocalCallFeed;
    private publications: TrackPublication[] = [];

    public constructor(opts: LocalCallTrackOpts) {
        super(opts);

        this._track = opts.track;
        this.feed = opts.feed;
    }

    private get logInfo(): string {
        return `kind=${this.kind}`;
    }

    public get id(): string | undefined {
        return this._id;
    }

    public get track(): MediaStreamTrack {
        return this._track;
    }

    public get kind(): string {
        return this.track.kind;
    }

    public get muted(): boolean {
        return !this.track.enabled;
    }

    public set muted(muted: boolean) {
        this.track.enabled = !muted;
    }

    public get purpose(): SDPStreamMetadataPurpose {
        return this.feed.purpose;
    }

    public get stream(): MediaStream | undefined {
        return this.feed.stream;
    }

    public get encodings(): RTCRtpEncodingParameters[] {
        return getSimulcastEncodings(this.purpose);
    }

    public publish(call: MatrixCall): TrackPublication | undefined {
        if (this.publications.some((publication) => publication.call === call)) {
            throw new Error("Cannot publish a track that is already published");
        }

        try {
            const publication = call.publishTrack(this);
            this.publications.push(publication);
            return publication;
        } catch (error) {
            logger.error(
                `LocalCallTrack ${this.id} publish() failed to publish track to call (callId=${call.callId}):`,
                error,
            );
        }
    }

    public unpublish(call: MatrixCall): TrackPublication | undefined {
        const publication = this.publications.find((publication) => publication.call === call);
        if (!publication) return;

        try {
            publication?.unpublish();
            this.publications.splice(this.publications.indexOf(publication), 1);
            return publication;
        } catch (error) {
            logger.error(
                `LocalCallTrack ${this.id} unpublish() failed to unpublish track to call (callId=${publication.call.callId})`,
                error,
            );
        }
    }

    public setNewTrack(track: MediaStreamTrack): void {
        logger.log(`LocalCallTrack ${this.id} setNewTrack() running (${this.logInfo})`);
        this._track = track;

        for (const publication of this.publications) {
            try {
                publication.updateSenderTrack();
                logger.log(
                    `LocalCallTrack ${this.id} setNewTrack() updated published track (callId=${publication.call.callId}, ${this.logInfo})`,
                );
            } catch (error) {
                logger.log(
                    `LocalCallTrack ${this.id} setNewTrack() failed to update published track (callId=${publication.call.callId}, ${this.logInfo})`,
                    error,
                );
            }
        }
    }
}
