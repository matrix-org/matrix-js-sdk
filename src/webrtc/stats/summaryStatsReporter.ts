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

export class SummaryStatsReporter {
    public constructor(private emitter: StatsReportEmitter) {}

    public build(summary: SummaryStats[]): void {
        const entirety = summary.length;
        if (entirety === 0) {
            return;
        }
        let receivedMedia = 0;
        let receivedVideoMedia = 0;
        let receivedAudioMedia = 0;

        summary.forEach((stats) => {
            let hasReceivedAudio = false;
            let hasReceivedVideo = false;
            if (stats.receivedAudioMedia > 0) {
                receivedAudioMedia++;
                hasReceivedAudio = true;
            }
            if (stats.receivedVideoMedia > 0) {
                receivedVideoMedia++;
                hasReceivedVideo = true;
            } else {
                if (
                    stats.videoTrackSummary.muted > 0 &&
                    stats.videoTrackSummary.muted === stats.videoTrackSummary.count
                ) {
                    receivedVideoMedia++;
                    hasReceivedVideo = true;
                }
            }

            if (stats.receivedMedia > 0 && hasReceivedVideo && hasReceivedAudio) {
                receivedMedia++;
            }
        });

        const report = {
            percentageReceivedMedia: Math.round((receivedMedia / entirety) * 100) / 100,
            percentageReceivedVideoMedia: Math.round((receivedVideoMedia / entirety) * 100) / 100,
            percentageReceivedAudioMedia: Math.round((receivedAudioMedia / entirety) * 100) / 100,
        } as SummaryStatsReport;
        this.emitter.emitSummaryStatsReport(report);
    }
}
