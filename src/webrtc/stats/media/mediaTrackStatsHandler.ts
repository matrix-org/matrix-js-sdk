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
import { TrackID } from "../statsReport";
import { MediaTrackStats } from "./mediaTrackStats";
import { MediaTrackHandler } from "./mediaTrackHandler";
import { MediaSsrcHandler } from "./mediaSsrcHandler";

export class MediaTrackStatsHandler {
    private readonly track2stats = new Map<TrackID, MediaTrackStats>();

    public constructor(
        public readonly mediaSsrcHandler: MediaSsrcHandler,
        public readonly mediaTrackHandler: MediaTrackHandler,
    ) {}

    public findTrack2Stats(report: any, type: "remote" | "local"): MediaTrackStats | undefined {
        let trackID;
        if (report.trackIdentifier) {
            trackID = report.trackIdentifier;
        } else if (report.mid) {
            trackID =
                type === "remote"
                    ? this.mediaTrackHandler.getRemoteTrackIdByMid(report.mid)
                    : this.mediaTrackHandler.getLocalTrackIdByMid(report.mid);
        } else if (report.ssrc) {
            const mid = this.mediaSsrcHandler.findMidBySsrc(report.ssrc, type);
            if (!mid) {
                return undefined;
            }
            trackID =
                type === "remote"
                    ? this.mediaTrackHandler.getRemoteTrackIdByMid(report.mid)
                    : this.mediaTrackHandler.getLocalTrackIdByMid(report.mid);
        }

        if (!trackID) {
            return undefined;
        }

        let trackStats = this.track2stats.get(trackID);

        if (!trackStats) {
            trackStats = new MediaTrackStats(trackID, type);
            this.track2stats.set(trackID, trackStats);
        }
        return trackStats;
    }

    public findLocalVideoTrackStats(report: any): MediaTrackStats | undefined {
        const localVideoTracks = this.mediaTrackHandler.getLocalTracks("video");
        if (localVideoTracks.length === 0) {
            return undefined;
        }
        return this.findTrack2Stats(report, "local");
    }

    public getTrack2stats(): Map<TrackID, MediaTrackStats> {
        return this.track2stats;
    }
}
