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
import { StatsReportEmitter } from "./statsReportEmitter";
import { SummaryStats } from "./summaryStats";
import { SummaryStatsReport } from "./statsReport";

interface ReceivedMedia {
    audio: number;
    video: number;
    media: number;
}

export class SummaryStatsReporter {
    public constructor(private emitter: StatsReportEmitter) {}

    public build(summary: SummaryStats[]): void {
        const entiretyTracksCount = summary.length;
        if (entiretyTracksCount === 0) {
            return;
        }
        const receivedCounter: ReceivedMedia = { audio: 0, video: 0, media: 0 };
        let maxJitter = 0;
        let maxPacketLoss = 0;

        summary.forEach((stats) => {
            this.countTrackListReceivedMedia(receivedCounter, stats);
            maxJitter = this.buildMaxJitter(maxJitter, stats);
            maxPacketLoss = this.buildMaxPacketLoss(maxPacketLoss, stats);
        });

        const report = {
            percentageReceivedMedia: Math.round((receivedCounter.media / entiretyTracksCount) * 100) / 100,
            percentageReceivedVideoMedia: Math.round((receivedCounter.video / entiretyTracksCount) * 100) / 100,
            percentageReceivedAudioMedia: Math.round((receivedCounter.audio / entiretyTracksCount) * 100) / 100,
            maxJitter,
            maxPacketLoss,
        } as SummaryStatsReport;
        this.emitter.emitSummaryStatsReport(report);
    }

    private countTrackListReceivedMedia(counter: ReceivedMedia, stats: SummaryStats): void {
        let hasReceivedAudio = false;
        let hasReceivedVideo = false;
        if (stats.receivedAudioMedia > 0 || stats.audioTrackSummary.count === 0) {
            counter.audio++;
            hasReceivedAudio = true;
        }
        if (stats.receivedVideoMedia > 0 || stats.videoTrackSummary.count === 0) {
            counter.video++;
            hasReceivedVideo = true;
        } else {
            if (stats.videoTrackSummary.muted > 0 && stats.videoTrackSummary.muted === stats.videoTrackSummary.count) {
                counter.video++;
                hasReceivedVideo = true;
            }
        }

        if (hasReceivedVideo && hasReceivedAudio) {
            counter.media++;
        }
    }

    private buildMaxJitter(maxJitter: number, stats: SummaryStats): number {
        if (maxJitter < stats.videoTrackSummary.maxJitter) {
            maxJitter = stats.videoTrackSummary.maxJitter;
        }

        if (maxJitter < stats.audioTrackSummary.maxJitter) {
            maxJitter = stats.audioTrackSummary.maxJitter;
        }
        return maxJitter;
    }

    private buildMaxPacketLoss(maxPacketLoss: number, stats: SummaryStats): number {
        if (maxPacketLoss < stats.videoTrackSummary.maxPacketLoss) {
            maxPacketLoss = stats.videoTrackSummary.maxPacketLoss;
        }

        if (maxPacketLoss < stats.audioTrackSummary.maxPacketLoss) {
            maxPacketLoss = stats.audioTrackSummary.maxPacketLoss;
        }
        return maxPacketLoss;
    }
}
