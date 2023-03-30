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

import { ConnectionStats } from "./connectionStats";
import { StatsReportEmitter } from "./statsReportEmitter";
import { ByteSend, ByteSentStatsReport, TrackID } from "./statsReport";
import { ConnectionStatsReporter } from "./connectionStatsReporter";
import { TransportStatsReporter } from "./transportStatsReporter";
import { MediaSsrcHandler } from "./media/mediaSsrcHandler";
import { MediaTrackHandler } from "./media/mediaTrackHandler";
import { MediaTrackStatsHandler } from "./media/mediaTrackStatsHandler";
import { TrackStatsReporter } from "./trackStatsReporter";
import { StatsReportBuilder } from "./statsReportBuilder";
import { StatsValueFormatter } from "./statsValueFormatter";

export class StatsReportGatherer {
    private isActive = true;
    private previousStatsReport: RTCStatsReport | undefined;
    private currentStatsReport: RTCStatsReport | undefined;
    private readonly connectionStats = new ConnectionStats();

    private readonly trackStats: MediaTrackStatsHandler;

    // private readonly ssrcToMid = { local: new Map<Mid, Ssrc[]>(), remote: new Map<Mid, Ssrc[]>() };

    public constructor(
        public readonly callId: string,
        public readonly remoteUserId: string,
        private readonly pc: RTCPeerConnection,
        private readonly emitter: StatsReportEmitter,
        private readonly isFocus = true,
    ) {
        pc.addEventListener("signalingstatechange", this.onSignalStateChange.bind(this));
        this.trackStats = new MediaTrackStatsHandler(new MediaSsrcHandler(), new MediaTrackHandler(pc));
    }

    public async processStats(groupCallId: string, localUserId: string): Promise<boolean> {
        if (this.isActive) {
            const statsPromise = this.pc.getStats();
            if (typeof statsPromise?.then === "function") {
                return statsPromise
                    .then((report) => {
                        // @ts-ignore
                        this.currentStatsReport = typeof report?.result === "function" ? report.result() : report;
                        try {
                            this.processStatsReport(groupCallId, localUserId);
                        } catch (error) {
                            this.isActive = false;
                            return false;
                        }

                        this.previousStatsReport = this.currentStatsReport;
                        return true;
                    })
                    .catch((error) => {
                        this.handleError(error);
                        return false;
                    });
            }
            this.isActive = false;
        }
        return Promise.resolve(false);
    }

    private processStatsReport(groupCallId: string, localUserId: string): void {
        const byteSentStats: ByteSentStatsReport = new Map<TrackID, ByteSend>();

        this.currentStatsReport?.forEach((now) => {
            const before = this.previousStatsReport ? this.previousStatsReport.get(now.id) : null;
            // RTCIceCandidatePairStats - https://w3c.github.io/webrtc-stats/#candidatepair-dict*
            if (now.type === "candidate-pair" && now.nominated && now.state === "succeeded") {
                this.connectionStats.bandwidth = ConnectionStatsReporter.buildBandwidthReport(now);
                this.connectionStats.transport = TransportStatsReporter.buildReport(
                    this.currentStatsReport,
                    now,
                    this.connectionStats.transport,
                    this.isFocus,
                );

                // RTCReceivedRtpStreamStats
                // https://w3c.github.io/webrtc-stats/#receivedrtpstats-dict*
                // RTCSentRtpStreamStats
                // https://w3c.github.io/webrtc-stats/#sentrtpstats-dict*
            } else if (now.type === "inbound-rtp" || now.type === "outbound-rtp") {
                const trackStats = this.trackStats.findTrack2Stats(
                    now,
                    now.type === "inbound-rtp" ? "remote" : "local",
                );
                if (!trackStats) {
                    return;
                }

                if (before) {
                    TrackStatsReporter.buildPacketsLost(trackStats, now, before);
                }

                // Get the resolution and framerate for only remote video sources here. For the local video sources,
                // 'track' stats will be used since they have the updated resolution based on the simulcast streams
                // currently being sent. Promise based getStats reports three 'outbound-rtp' streams and there will be
                // more calculations needed to determine what is the highest resolution stream sent by the client if the
                // 'outbound-rtp' stats are used.
                if (now.type === "inbound-rtp") {
                    TrackStatsReporter.buildFramerateResolution(trackStats, now);
                    if (before) {
                        TrackStatsReporter.buildBitrateReceived(trackStats, now, before);
                    }
                } else if (before) {
                    byteSentStats.set(trackStats.trackId, StatsValueFormatter.getNonNegativeValue(now.bytesSent));
                    TrackStatsReporter.buildBitrateSend(trackStats, now, before);
                }
                TrackStatsReporter.buildCodec(this.currentStatsReport, trackStats, now);
            } else if (now.type === "track" && now.kind === "video" && !now.remoteSource) {
                const trackStats = this.trackStats.findLocalVideoTrackStats(now);
                if (!trackStats) {
                    return;
                }
                TrackStatsReporter.buildFramerateResolution(trackStats, now);
                TrackStatsReporter.calculateSimulcastFramerate(
                    trackStats,
                    now,
                    before,
                    this.trackStats.mediaTrackHandler.getActiveSimulcastStreams(),
                );
            }
        });

        this.emitter.emitByteSendReport(byteSentStats);
        this.processAndEmitReport();
    }

    public setActive(isActive: boolean): void {
        this.isActive = isActive;
    }

    public getActive(): boolean {
        return this.isActive;
    }

    private handleError(_: any): void {
        this.isActive = false;
    }

    private processAndEmitReport(): void {
        const report = StatsReportBuilder.build(this.trackStats.getTrack2stats());

        this.connectionStats.bandwidth = report.bandwidth;
        this.connectionStats.bitrate = report.bitrate;
        this.connectionStats.packetLoss = report.packetLoss;

        this.emitter.emitConnectionStatsReport({
            ...report,
            transport: this.connectionStats.transport,
        });

        this.connectionStats.transport = [];
    }

    public stopProcessingStats(): void {}

    private onSignalStateChange(): void {
        if (this.pc.signalingState === "stable") {
            if (this.pc.currentRemoteDescription) {
                this.trackStats.mediaSsrcHandler.parse(this.pc.currentRemoteDescription.sdp, "remote");
            }
            if (this.pc.currentLocalDescription) {
                this.trackStats.mediaSsrcHandler.parse(this.pc.currentLocalDescription.sdp, "local");
            }
        }
    }
}
