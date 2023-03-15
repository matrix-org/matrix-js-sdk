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
import { MediaSsrcHandler, Mid } from "./mediaSsrcHandler";

export class MediaTrackStatsHandler {
    private readonly track2stats = new Map<TrackID, MediaTrackStats>();

    public constructor(
        public readonly mediaSsrcHandler: MediaSsrcHandler,
        public readonly mediaTrackHandler: MediaTrackHandler,
    ) {}

    public findTrack2Stats(report: any): MediaTrackStats | undefined {
        let mid: string | undefined = report.mid;
        if (!mid) {
            const type = report.type === "inbound-rtp" ? "remote" : "local";
            mid = this.mediaSsrcHandler.findMidBySsrc(report.ssrc, type);
            if (report.type === "inbound-rtp" && mid) {
                report.trackIdentifier = this.mediaTrackHandler.getRemoteTrackIdByMid(mid);
            }
            report.mid = mid;
        }

        // inbound-rtp => remote receiving report
        // outbound-rtp => local sending  report
        const trackID =
            report.type === "inbound-rtp"
                ? report.trackIdentifier
                : this.mediaTrackHandler.getLocalTrackIdByMid(report.mid);

        if (!trackID) {
            return undefined;
        }

        let trackStats = this.track2stats.get(trackID);

        if (!trackStats) {
            trackStats = new MediaTrackStats(trackID, report.type === "inbound-rtp" ? "remote" : "local");
            this.track2stats.set(trackID, trackStats);
        }
        return trackStats;
    }

    public findLocalVideoTrackStats(report: any): MediaTrackStats | undefined {
        if (!report.trackIdentifier) {
            const mid: Mid | undefined = this.mediaSsrcHandler.findMidBySsrc(report.ssrc, "local");
            if (mid !== undefined) {
                report.trackIdentifier = this.mediaTrackHandler.getLocalTrackIdByMid(mid);
                report.mid = mid;
            }
        }

        const localVideoTracks = this.mediaTrackHandler.getLocalTracks("video");

        if (localVideoTracks.length === 0) {
            return undefined;
        }

        let trackStats = this.track2stats.get(report.trackIdentifier);

        if (!trackStats) {
            trackStats = new MediaTrackStats(report.trackIdentifier, "local");
            this.track2stats.set(report.trackIdentifier, trackStats);
        }
        return trackStats;
    }

    public getTrack2stats(): Map<TrackID, MediaTrackStats> {
        return this.track2stats;
    }
}
