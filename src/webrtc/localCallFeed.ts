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
import { SDPStreamMetadataObject, SDPStreamMetadataPurpose, SDPStreamMetadataTracks } from "./callEventTypes";
import { CallFeed, ICallFeedOpts } from "./callFeed";
import { LocalCallTrack } from "./localCallTrack";

export interface LocalCallFeedOpts extends ICallFeedOpts {
    purpose: SDPStreamMetadataPurpose;
    stream: MediaStream;
}

export class LocalCallFeed extends CallFeed {
    protected _tracks: LocalCallTrack[] = [];
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

    public get metadata(): SDPStreamMetadataObject {
        return {
            user_id: this.userId,
            device_id: this.deviceId,
            purpose: this.purpose,
            audio_muted: this.isAudioMuted(),
            video_muted: this.isVideoMuted(),
            tracks: this._tracks.reduce((metadata: SDPStreamMetadataTracks, track: LocalCallTrack) => {
                if (!track.trackId) return metadata;

                metadata[track.trackId] = track.metadata;
                return metadata;
            }, {}),
        };
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

    public get streamId(): string | undefined {
        return this._tracks[0]?.streamId;
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

        return new LocalCallFeed({
            client: this.client,
            roomId: this.roomId,
            stream,
            purpose: this.purpose,
            audioMuted: this.audioMuted,
            videoMuted: this.videoMuted,
        });
    }

    public setNewStream(newStream: MediaStream): void {
        this.updateStream(this.stream, newStream);
    }

    protected updateStream(oldStream?: MediaStream, newStream?: MediaStream): void {
        super.updateStream(oldStream, newStream);

        if (!newStream) return;

        // First, remove tracks which won't be used anymore
        for (const track of this._tracks) {
            if (!newStream.getTracks().some((streamTrack) => streamTrack.kind === track.kind)) {
                this._tracks.splice(this._tracks.indexOf(track), 1);
                if (track.published) {
                    track.unpublish();
                }
            }
        }

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

            if (this.call) {
                track.publish(this.call);
            }
        }
    }

    public publish(call: MatrixCall): void {
        this.call = call;
        for (const track of this._tracks) {
            track.publish(call);
        }
    }

    public unpublish(): void {
        this.call = undefined;
        for (const track of this._tracks) {
            track.unpublish();
        }
    }
}
