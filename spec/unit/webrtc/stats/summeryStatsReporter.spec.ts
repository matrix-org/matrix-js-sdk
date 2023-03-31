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
import { SummeryStatsReporter } from "../../../../src/webrtc/stats/summeryStatsReporter";
import { StatsReportEmitter } from "../../../../src/webrtc/stats/statsReportEmitter";

describe("SummeryStatsReporter", () => {
    let reporter: SummeryStatsReporter;
    let emitter: StatsReportEmitter;
    beforeEach(() => {
        emitter = new StatsReportEmitter();
        emitter.emitSummeryStatsReport = jest.fn();
        reporter = new SummeryStatsReporter(emitter);
    });

    describe("build Summery Stats Report", () => {
        it("should do nothing if  summery list empty", async () => {
            reporter.build([]);
            expect(emitter.emitSummeryStatsReport).not.toHaveBeenCalled();
        });

        it("should trigger new summery report", async () => {
            const summery = [
                { receivedMedia: 10, receivedAudioMedia: 4, receivedVideoMedia: 6 },
                { receivedMedia: 13, receivedAudioMedia: 0, receivedVideoMedia: 13 },
                { receivedMedia: 0, receivedAudioMedia: 0, receivedVideoMedia: 0 },
                { receivedMedia: 15, receivedAudioMedia: 6, receivedVideoMedia: 9 },
            ];
            reporter.build(summery);
            expect(emitter.emitSummeryStatsReport).toHaveBeenCalledWith({
                percentageReceivedMedia: 0.75,
                percentageReceivedAudioMedia: 0.5,
                percentageReceivedVideoMedia: 0.75,
            });
        });
    });
});
