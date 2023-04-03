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
import { TrackStatsReporter } from "../../../../src/webrtc/stats/trackStatsReporter";
import { MediaTrackStats } from "../../../../src/webrtc/stats/media/mediaTrackStats";

describe("TrackStatsReporter", () => {
    describe("should on frame and resolution stats", () => {
        it("creating empty frame and resolution report, if no data available.", async () => {
            const trackStats = new MediaTrackStats("1", "local", "video");
            TrackStatsReporter.buildFramerateResolution(trackStats, {});
            expect(trackStats.getFramerate()).toEqual(0);
            expect(trackStats.getResolution()).toEqual({ width: -1, height: -1 });
        });
        it("creating empty frame and resolution report.", async () => {
            const trackStats = new MediaTrackStats("1", "remote", "video");
            TrackStatsReporter.buildFramerateResolution(trackStats, {
                framesPerSecond: 22.2,
                frameHeight: 180,
                frameWidth: 360,
            });
            expect(trackStats.getFramerate()).toEqual(22);
            expect(trackStats.getResolution()).toEqual({ width: 360, height: 180 });
        });
    });

    describe("should on simulcast", () => {
        it("creating simulcast framerate.", async () => {
            const trackStats = new MediaTrackStats("1", "local", "video");
            TrackStatsReporter.calculateSimulcastFramerate(
                trackStats,
                {
                    framesSent: 100,
                    timestamp: 1678957001000,
                },
                {
                    framesSent: 10,
                    timestamp: 1678957000000,
                },
                3,
            );
            expect(trackStats.getFramerate()).toEqual(30);
        });
    });

    describe("should on bytes received stats", () => {
        it("creating build bitrate received report.", async () => {
            const trackStats = new MediaTrackStats("1", "remote", "video");
            TrackStatsReporter.buildBitrateReceived(
                trackStats,
                {
                    bytesReceived: 2001000,
                    timestamp: 1678957010,
                },
                { bytesReceived: 2000000, timestamp: 1678957000 },
            );
            expect(trackStats.getBitrate()).toEqual({ download: 800, upload: 0 });
        });
    });

    describe("should on bytes send stats", () => {
        it("creating build bitrate send report.", async () => {
            const trackStats = new MediaTrackStats("1", "local", "video");
            TrackStatsReporter.buildBitrateSend(
                trackStats,
                {
                    bytesSent: 2001000,
                    timestamp: 1678957010,
                },
                { bytesSent: 2000000, timestamp: 1678957000 },
            );
            expect(trackStats.getBitrate()).toEqual({ download: 0, upload: 800 });
        });
    });

    describe("should on codec stats", () => {
        it("creating build bitrate send report.", async () => {
            const trackStats = new MediaTrackStats("1", "remote", "video");
            const remote = {} as RTCStatsReport;
            remote.get = jest.fn().mockReturnValue({ mimeType: "video/v8" });
            TrackStatsReporter.buildCodec(remote, trackStats, { codecId: "codecID" });
            expect(trackStats.getCodec()).toEqual("v8");
        });
    });

    describe("should on package lost stats", () => {
        it("creating build package lost on send report.", async () => {
            const trackStats = new MediaTrackStats("1", "local", "video");
            TrackStatsReporter.buildPacketsLost(
                trackStats,
                {
                    type: "outbound-rtp",
                    packetsSent: 200,
                    packetsLost: 120,
                },
                {
                    packetsSent: 100,
                    packetsLost: 30,
                },
            );
            expect(trackStats.getLoss()).toEqual({ packetsTotal: 190, packetsLost: 90, isDownloadStream: false });
        });
        it("creating build package lost on received report.", async () => {
            const trackStats = new MediaTrackStats("1", "remote", "video");
            TrackStatsReporter.buildPacketsLost(
                trackStats,
                {
                    type: "inbound-rtp",
                    packetsReceived: 300,
                    packetsLost: 100,
                },
                {
                    packetsReceived: 100,
                    packetsLost: 20,
                },
            );
            expect(trackStats.getLoss()).toEqual({ packetsTotal: 280, packetsLost: 80, isDownloadStream: true });
        });
    });
});
