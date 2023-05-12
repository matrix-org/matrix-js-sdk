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

interface SummaryCounter {
    receivedAudio: number;
    receivedVideo: number;
    receivedMedia: number;
    concealedAudio: number;
    totalAudio: number;
}

export class SummaryStatsReporter {
    public constructor(private emitter: StatsReportEmitter) {}

    public build(summary: SummaryStats[]): void {
        const summaryTotalCount = summary.length;
        if (summaryTotalCount === 0) {
            return;
        }
        const summaryCounter: SummaryCounter = {
            receivedAudio: 0,
            receivedVideo: 0,
            receivedMedia: 0,
            concealedAudio: 0,
            totalAudio: 0,
        };
        let maxJitter = 0;
        let maxPacketLoss = 0;
        summary.forEach((stats) => {
            this.countTrackListReceivedMedia(summaryCounter, stats);
            this.countConcealedAudio(summaryCounter, stats);
            maxJitter = this.buildMaxJitter(maxJitter, stats);
            maxPacketLoss = this.buildMaxPacketLoss(maxPacketLoss, stats);
        });
        const decimalPlaces = 5;
        const report = {
            percentageReceivedMedia: Number((summaryCounter.receivedMedia / summaryTotalCount).toFixed(decimalPlaces)),
            percentageReceivedVideoMedia: Number(
                (summaryCounter.receivedVideo / summaryTotalCount).toFixed(decimalPlaces),
            ),
            percentageReceivedAudioMedia: Number(
                (summaryCounter.receivedAudio / summaryTotalCount).toFixed(decimalPlaces),
            ),
            maxJitter,
            maxPacketLoss,
            percentageConcealedAudio: Number(
                summaryCounter.totalAudio > 0
                    ? (summaryCounter.concealedAudio / summaryCounter.totalAudio).toFixed(decimalPlaces)
                    : 0,
            ),
        } as SummaryStatsReport;
        this.emitter.emitSummaryStatsReport(report);
    }

    private countTrackListReceivedMedia(counter: SummaryCounter, stats: SummaryStats): void {
        let hasReceivedAudio = false;
        let hasReceivedVideo = false;
        if (stats.receivedAudioMedia > 0 || stats.audioTrackSummary.count === 0) {
            counter.receivedAudio++;
            hasReceivedAudio = true;
        }
        if (stats.receivedVideoMedia > 0 || stats.videoTrackSummary.count === 0) {
            counter.receivedVideo++;
            hasReceivedVideo = true;
        } else {
            if (stats.videoTrackSummary.muted > 0 && stats.videoTrackSummary.muted === stats.videoTrackSummary.count) {
                counter.receivedVideo++;
                hasReceivedVideo = true;
            }
        }

        if (hasReceivedVideo && hasReceivedAudio) {
            counter.receivedMedia++;
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

    private countConcealedAudio(summaryCounter: SummaryCounter, stats: SummaryStats): void {
        summaryCounter.concealedAudio += stats.audioTrackSummary.concealedAudio;
        summaryCounter.totalAudio += stats.audioTrackSummary.totalAudio;
    }
}
