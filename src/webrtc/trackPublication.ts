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
import { SDPStreamMetadataTrack } from "./callEventTypes";
import { LocalCallTrack } from "./localCallTrack";

interface TrackPublicationOpts {
    call: MatrixCall;
    track: LocalCallTrack;
    transceiver: RTCRtpTransceiver;
}

export class TrackPublication {
    public readonly call: MatrixCall;
    public readonly track: LocalCallTrack;
    private _transceiver: RTCRtpTransceiver;

    public constructor(opts: TrackPublicationOpts) {
        this.call = opts.call;
        this.track = opts.track;
        this._transceiver = opts.transceiver;

        this.updateSenderTrack();
    }

    public get logInfo(): string {
        return `streamId=${this.streamId}, trackId=${this.trackId}, mid=${this.mid} kind=${this.track.kind}`;
    }

    public get metadata(): SDPStreamMetadataTrack {
        const track = this.track;
        const trackMetadata: SDPStreamMetadataTrack = {
            kind: this.track.kind,
        };

        if (track.isVideo) {
            trackMetadata.width = track.track.getSettings().width;
            trackMetadata.height = track.track.getSettings().height;
        }

        return trackMetadata;
    }

    public get mid(): string | undefined {
        return this.transceiver?.mid ?? undefined;
    }

    public get trackId(): string | undefined {
        const mid = this.transceiver?.mid;
        return mid ? this.call?.getLocalTrackIdByMid(mid) : undefined;
    }

    public get streamId(): string | undefined {
        const mid = this.transceiver?.mid;
        return mid ? this.call?.getLocalStreamIdByMid(mid) : undefined;
    }

    public get transceiver(): RTCRtpTransceiver {
        return this._transceiver;
    }

    public unpublish(): void {
        this.call.unpublishTrack(this);
    }

    public updateSenderTrack(): void {
        const { stream, track } = this.track;
        const transceiver = this.transceiver;
        const sender = this.transceiver.sender;
        const parameters = sender.getParameters();

        // No need to update the track
        if (sender.track === track) return;

        // setStreams() is currently not supported by Firefox but we
        // try to use it at least in other browsers (once we switch
        // to using mids and throw away streamIds we will be able to
        // throw this away)
        if (sender.setStreams && stream) sender.setStreams(stream);

        try {
            sender.replaceTrack(track);

            // Does this even work, where does it work?
            transceiver.sender.setParameters({
                ...parameters,
                encodings: this.track.encodings,
            });

            // Set the direction of the transceiver to indicate we're
            // going to be sending. This may trigger re-negotiation, if
            // we weren't sending until now
            transceiver.direction = transceiver.direction === "inactive" ? "sendonly" : "sendrecv";
        } catch (error) {
            logger.warn(
                `TrackPublication ${this.trackId} updateSenderTrack() failed to replace track - publishing on new transceiver:`,
                error,
            );

            this.call.unpublishTrackOnTransceiver(this);
            this._transceiver = this.call.publishTrackOnNewTransceiver(this.track);
        }
    }
}
