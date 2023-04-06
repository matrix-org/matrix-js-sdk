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
import { SummaryStatsReporter } from "../../../../src/webrtc/stats/summaryStatsReporter";
import { StatsReportEmitter } from "../../../../src/webrtc/stats/statsReportEmitter";

describe("SummaryStatsReporter", () => {
    let reporter: SummaryStatsReporter;
    let emitter: StatsReportEmitter;
    beforeEach(() => {
        emitter = new StatsReportEmitter();
        emitter.emitSummaryStatsReport = jest.fn();
        reporter = new SummaryStatsReporter(emitter);
    });

    describe("build Summary Stats Report", () => {
        it("should do nothing if  summary list empty", async () => {
            reporter.build([]);
            expect(emitter.emitSummaryStatsReport).not.toHaveBeenCalled();
        });

        it("should trigger new summary report", async () => {
            const summary = [
                {
                    receivedMedia: 10,
                    receivedAudioMedia: 4,
                    receivedVideoMedia: 6,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 1, muted: 0 },
                },
                {
                    receivedMedia: 13,
                    receivedAudioMedia: 0,
                    receivedVideoMedia: 13,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 1, muted: 0 },
                },
                {
                    receivedMedia: 0,
                    receivedAudioMedia: 0,
                    receivedVideoMedia: 0,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 1, muted: 0 },
                },
                {
                    receivedMedia: 15,
                    receivedAudioMedia: 6,
                    receivedVideoMedia: 9,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 1, muted: 0 },
                },
            ];
            reporter.build(summary);
            expect(emitter.emitSummaryStatsReport).toHaveBeenCalledWith({
                percentageReceivedMedia: 0.5,
                percentageReceivedAudioMedia: 0.5,
                percentageReceivedVideoMedia: 0.75,
            });
        });

        it("as received video Media, although video was not received, but because video muted", async () => {
            const summary = [
                {
                    receivedMedia: 10,
                    receivedAudioMedia: 10,
                    receivedVideoMedia: 0,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 1, muted: 1 },
                },
            ];
            reporter.build(summary);
            expect(emitter.emitSummaryStatsReport).toHaveBeenCalledWith({
                percentageReceivedMedia: 1,
                percentageReceivedAudioMedia: 1,
                percentageReceivedVideoMedia: 1,
            });
        });

        it("as received no video Media, because only on video was muted", async () => {
            const summary = [
                {
                    receivedMedia: 10,
                    receivedAudioMedia: 10,
                    receivedVideoMedia: 0,
                    audioTrackSummary: { count: 1, muted: 0 },
                    videoTrackSummary: { count: 2, muted: 1 },
                },
            ];
            reporter.build(summary);
            expect(emitter.emitSummaryStatsReport).toHaveBeenCalledWith({
                percentageReceivedMedia: 0,
                percentageReceivedAudioMedia: 1,
                percentageReceivedVideoMedia: 0,
            });
        });

        it("as received no audio Media, although audio not received and audio muted", async () => {
            const summary = [
                {
                    receivedMedia: 100,
                    receivedAudioMedia: 0,
                    receivedVideoMedia: 100,
                    audioTrackSummary: { count: 1, muted: 1 },
                    videoTrackSummary: { count: 1, muted: 0 },
                },
            ];
            reporter.build(summary);
            expect(emitter.emitSummaryStatsReport).toHaveBeenCalledWith({
                percentageReceivedMedia: 0,
                percentageReceivedAudioMedia: 0,
                percentageReceivedVideoMedia: 1,
            });
        });
    });
});
