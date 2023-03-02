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
import { CallFeed, CallFeedEvent, ICallFeedOpts } from "./callFeed";
import { FeedPublication } from "./feedPublication";
import { LocalCallTrack } from "./localCallTrack";

export interface LocalCallFeedOpts extends ICallFeedOpts {
    purpose: SDPStreamMetadataPurpose;
    stream: MediaStream;
}

export class LocalCallFeed extends CallFeed {
    protected _tracks: LocalCallTrack[] = [];
    protected publications: FeedPublication[] = [];
    private _purpose: SDPStreamMetadataPurpose;

    protected _stream: MediaStream;

    public readonly connected = true;
    public readonly isLocal = true;
    public readonly isRemote = false;

    public constructor(opts: LocalCallFeedOpts) {
        super(opts);

        this._purpose = opts.purpose;

        this.updateStream(undefined, opts.stream);
        // updateStream() already did the job, but this shuts up typescript from
        // complaining about it not being set in the constructor
        this._stream = opts.stream;
    }

    public get id(): string {
        return this._id;
    }

    public get tracks(): LocalCallTrack[] {
        return super.tracks as LocalCallTrack[];
    }

    public get audioTracks(): LocalCallTrack[] {
        return super.audioTracks as LocalCallTrack[];
    }

    public get videoTracks(): LocalCallTrack[] {
        return super.videoTracks as LocalCallTrack[];
    }

    public get purpose(): SDPStreamMetadataPurpose {
        return this._purpose;
    }

    public get userId(): string {
        return this.client.getUserId()!;
    }

    public get deviceId(): string | undefined {
        return this.client.getDeviceId() ?? undefined;
    }

    /**
     * Set one or both of feed's internal audio and video video mute state
     * Either value may be null to leave it as-is
     * @param audioMuted - is the feed's audio muted?
     * @param videoMuted - is the feed's video muted?
     */
    public setAudioVideoMuted(audioMuted: boolean | null, videoMuted: boolean | null): void {
        logger.log(`CallFeed ${this.id} setAudioVideoMuted() running (audio=${audioMuted}, video=${videoMuted})`);

        if (audioMuted !== null) {
            if (this.audioMuted !== audioMuted) {
                this.speakingVolumeSamples.fill(-Infinity);
            }
            this.audioTracks.forEach((track) => (track.muted = audioMuted));
        }
        if (videoMuted !== null) {
            this.videoTracks.forEach((track) => (track.muted = videoMuted));
        }

        this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
    }

    public clone(): LocalCallFeed {
        const mediaHandler = this.client.getMediaHandler();
        const stream = this._stream.clone();
        logger.log(
            `CallFeed ${this.id} clone() cloning stream (originalStreamId=${this._stream.id}, newStreamId=${stream.id})`,
        );

        if (this.purpose === SDPStreamMetadataPurpose.Usermedia) {
            mediaHandler.userMediaStreams.push(stream);
        } else if (this.purpose === SDPStreamMetadataPurpose.Screenshare) {
            mediaHandler.screensharingStreams.push(stream);
        }

        const feed = new LocalCallFeed({
            client: this.client,
            roomId: this.roomId,
            stream,
            purpose: this.purpose,
        });
        feed.setAudioVideoMuted(this.audioMuted, this.videoMuted);
        return feed;
    }

    public setNewStream(newStream: MediaStream): void {
        this.updateStream(this.stream, newStream);
    }

    protected updateStream(oldStream?: MediaStream, newStream?: MediaStream): void {
        super.updateStream(oldStream, newStream);

        // First, remove tracks which won't be used anymore
        for (const track of this._tracks) {
            if (!newStream?.getTracks().some((streamTrack) => streamTrack.kind === track.kind)) {
                this._tracks.splice(this._tracks.indexOf(track), 1);
                this.publications.forEach((publication) => this.unpublishTrack(track, publication));
            }
        }

        if (!newStream) return;

        // Then, replace old track where we can and add new tracks
        for (const streamTrack of newStream.getTracks()) {
            let track = this._tracks.find((track) => track.kind === streamTrack.kind);
            if (track) {
                track.setNewTrack(streamTrack);
                continue;
            }

            track = new LocalCallTrack({
                feed: this,
                track: streamTrack,
            });
            this._tracks.push(track);
            this.publications.forEach((publication) => this.publishTrack(track!, publication));
        }
    }

    public publish(call: MatrixCall): FeedPublication {
        if (this.publications.some((publication) => publication.call === call)) {
            throw new Error("Cannot publish a feed that is already published");
        }

        const feedPublication = new FeedPublication({
            feed: this,
            call,
        });
        this.tracks.forEach((track) => this.publishTrack(track, feedPublication));

        this.publications.push(feedPublication);
        return feedPublication;
    }

    public unpublish(call: MatrixCall): void {
        const feedPublication = this.publications.find((publication) => publication.call === call);
        if (!feedPublication) return;

        this.publications.splice(this.publications.indexOf(feedPublication), 1);
        this.tracks.forEach((track) => this.unpublishTrack(track, feedPublication));
    }

    private publishTrack(track: LocalCallTrack, feedPublication: FeedPublication): void {
        const trackPublication = track.publish(feedPublication.call);
        if (!trackPublication) return;
        feedPublication.addTrackPublication(trackPublication);
    }

    private unpublishTrack(track: LocalCallTrack, feedPublication: FeedPublication): void {
        const trackPublication = track.unpublish(feedPublication.call);
        if (!trackPublication) return;
        feedPublication.removeTrackPublication(trackPublication);
    }
}
