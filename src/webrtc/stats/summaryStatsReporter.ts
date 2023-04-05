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
        const report = {} as SummaryStatsReport;
        report.percentageReceivedVideoMedia =
            Math.round((summary.filter((s) => s.receivedVideoMedia > 0).length / entirety) * 100) / 100;
        report.percentageReceivedAudioMedia =
            Math.round((summary.filter((s) => s.receivedAudioMedia > 0).length / entirety) * 100) / 100;
        report.percentageReceivedMedia =
            Math.round((summary.filter((s) => s.receivedMedia > 0).length / entirety) * 100) / 100;

        this.emitter.emitSummaryStatsReport(report);
    }
}
