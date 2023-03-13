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

import { MatrixCall } from "./call";
import { SDPStreamMetadataObject, SDPStreamMetadataTracks } from "./callEventTypes";
import { LocalCallFeed } from "./localCallFeed";
import { TrackPublication } from "./trackPublication";

interface CallFeedPublicationOpts {
    call: MatrixCall;
    feed: LocalCallFeed;
}

/**
 * FeedPublication represents a LocalCallFeed being published to a specific peer
 * connection. It stores an array of track publications. This class needs to
 * exist, so that we are able elegantly retrieve feed's track publications on a
 * given peer connection.
 */
export class FeedPublication {
    public readonly call: MatrixCall;
    public readonly feed: LocalCallFeed;
    private trackPublications: TrackPublication[] = [];

    public constructor(opts: CallFeedPublicationOpts) {
        this.call = opts.call;
        this.feed = opts.feed;
    }

    public get metadata(): SDPStreamMetadataObject {
        return {
            user_id: this.feed.userId,
            device_id: this.feed.deviceId,
            purpose: this.feed.purpose,
            audio_muted: this.feed.audioMuted,
            video_muted: this.feed.videoMuted,
            tracks: this.trackPublications.reduce(
                (metadata: SDPStreamMetadataTracks, publication: TrackPublication) => {
                    if (!publication.trackId) return metadata;

                    metadata[publication.trackId] = publication.metadata;
                    return metadata;
                },
                {},
            ),
        };
    }

    public get streamId(): string | undefined {
        return this.trackPublications[0]?.streamId;
    }

    public addTrackPublication(publication: TrackPublication): void {
        this.trackPublications.push(publication);
    }

    public removeTrackPublication(publication: TrackPublication): void {
        this.trackPublications.splice(this.trackPublications.indexOf(publication), 1);
    }
}
