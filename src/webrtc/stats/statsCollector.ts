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
import { Resolution } from "./media/mediaTrackStats";
import { ByteSend, ByteSendStatsReport, CodecMap, FramerateMap, ResolutionMap, TrackID } from "./statsReport";
import { ConnectionStatsReporter } from "./connectionStatsReporter";
import { TransportStatsReporter } from "./transportStatsReporter";
import { MediaSsrcHandler } from "./media/mediaSsrcHandler";
import { MediaTrackHandler } from "./media/mediaTrackHandler";
import { MediaTrackStatsHandler } from "./media/mediaTrackStatsHandler";

export class StatsCollector {
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
            return this.pc
                .getStats()
                .then((report) => {
                    // @ts-ignore
                    this.currentStatsReport = typeof report?.result === "function" ? report.result() : report;
                    try {
                        this.processStatsReport(groupCallId, localUserId);
                    } catch (error) {
                        this.isActive = false;
                        return false;
                        // logger.error('Processing of RTP stats failed:', error);
                    }

                    this.previousStatsReport = this.currentStatsReport;
                    return true;
                })
                .catch((error) => {
                    this.handleError(error);
                    return false;
                });
        }
        return Promise.resolve(false);
    }

    private processStatsReport(groupCallId: string, localUserId: string): void {
        const byteSentStats: ByteSendStatsReport = new Map<TrackID, ByteSend>();

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

                let isDownloadStream = true;
                let key = "packetsReceived";

                if (now.type === "outbound-rtp") {
                    isDownloadStream = false;
                    key = "packetsSent";
                }

                let packetsNow = now[key];

                if (!packetsNow || packetsNow < 0) {
                    packetsNow = 0;
                }

                if (before) {
                    const packetsBefore = this.getNonNegativeValue(before[key]);
                    const packetsDiff = Math.max(0, packetsNow - packetsBefore);

                    const packetsLostNow = this.getNonNegativeValue(now.packetsLost);
                    const packetsLostBefore = this.getNonNegativeValue(before.packetsLost);
                    const packetsLostDiff = Math.max(0, packetsLostNow - packetsLostBefore);

                    trackStats.setLoss({
                        packetsTotal: packetsDiff + packetsLostDiff,
                        packetsLost: packetsLostDiff,
                        isDownloadStream,
                    });
                }

                // Get the resolution and framerate for only remote video sources here. For the local video sources,
                // 'track' stats will be used since they have the updated resolution based on the simulcast streams
                // currently being sent. Promise based getStats reports three 'outbound-rtp' streams and there will be
                // more calculations needed to determine what is the highest resolution stream sent by the client if the
                // 'outbound-rtp' stats are used.
                if (now.type === "inbound-rtp") {
                    const resolution = {
                        height: now.frameHeight,
                        width: now.frameWidth,
                    };
                    const frameRate = now.framesPerSecond;

                    if (resolution.height && resolution.width) {
                        trackStats.setResolution(resolution);
                    }
                    trackStats.setFramerate(Math.round(frameRate || 0));

                    if (before) {
                        trackStats.addBitrate({
                            download: this.calculateBitrate(
                                now.bytesReceived,
                                before.bytesReceived,
                                now.timestamp,
                                before.timestamp,
                            ),
                            upload: 0,
                        });
                    }
                } else if (before) {
                    byteSentStats.set(trackStats.trackId, this.getNonNegativeValue(now.bytesSent));
                    trackStats.addBitrate({
                        download: 0,
                        upload: this.calculateBitrate(now.bytesSent, before.bytesSent, now.timestamp, before.timestamp),
                    });
                }

                const codec = this.currentStatsReport?.get(now.codecId);

                if (codec) {
                    /**
                     * The mime type has the following form: video/VP8 or audio/ISAC,
                     * so we what to keep just the type after the '/', audio and video
                     * keys will be added on the processing side.
                     */
                    const codecShortType = codec.mimeType.split("/")[1];

                    codecShortType && trackStats.setCodec(codecShortType);
                }
            } else if (now.type === "track" && now.kind === "video" && !now.remoteSource) {
                const trackStats = this.trackStats.findLocalVideoTrackStats(now);
                if (!trackStats) {
                    return;
                }
                const resolution = {
                    height: now.frameHeight,
                    width: now.frameWidth,
                };
                if (resolution.height && resolution.width) {
                    trackStats.setResolution(resolution);
                }

                // Calculate the frame rate. 'framesSent' is the total aggregate value for all the simulcast streams.
                // Therefore, it needs to be divided by the total number of active simulcast streams.
                let frameRate = now.framesPerSecond;

                if (!frameRate) {
                    if (before) {
                        const timeMs = now.timestamp - before.timestamp;

                        if (timeMs > 0 && now.framesSent) {
                            const numberOfFramesSinceBefore = now.framesSent - before.framesSent;

                            frameRate = (numberOfFramesSinceBefore / timeMs) * 1000;
                        }
                    }

                    if (!frameRate) {
                        return;
                    }
                }

                // Get the number of simulcast streams currently enabled from TPC.
                const numberOfActiveStreams = this.trackStats.mediaTrackHandler.getActiveSimulcastStreams();

                // Reset frame rate to 0 when video is suspended as a result of endpoint falling out of last-n.
                frameRate = numberOfActiveStreams ? Math.round(frameRate / numberOfActiveStreams) : 0;
                trackStats.setFramerate(frameRate);
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

    private getNonNegativeValue(ssrc: any): number {
        let value = ssrc;

        if (typeof value !== "number") {
            value = Number(value);
        }

        if (isNaN(value)) {
            return 0;
        }

        return Math.max(0, value);
    }

    private calculateBitrate(
        bytesNowAny: any,
        bytesBeforeAny: any,
        nowTimestamp: number,
        beforeTimestamp: number,
    ): number {
        const bytesNow = this.getNonNegativeValue(bytesNowAny);
        const bytesBefore = this.getNonNegativeValue(bytesBeforeAny);
        const bytesProcessed = Math.max(0, bytesNow - bytesBefore);

        const timeMs = nowTimestamp - beforeTimestamp;
        let bitrateKbps = 0;

        if (timeMs > 0) {
            // TODO is there any reason to round here?
            bitrateKbps = Math.round((bytesProcessed * 8) / timeMs);
        }

        return bitrateKbps;
    }

    private processAndEmitReport(): void {
        // process stats
        const totalPackets = {
            download: 0,
            upload: 0,
        };
        const lostPackets = {
            download: 0,
            upload: 0,
        };
        let bitrateDownload = 0;
        let bitrateUpload = 0;
        const resolutions: ResolutionMap = {
            local: new Map<TrackID, Resolution>(),
            remote: new Map<TrackID, Resolution>(),
        };
        const framerates: FramerateMap = { local: new Map<TrackID, number>(), remote: new Map<TrackID, number>() };
        const codecs: CodecMap = { local: new Map<TrackID, string>(), remote: new Map<TrackID, string>() };
        let audioBitrateDownload = 0;
        let audioBitrateUpload = 0;
        let videoBitrateDownload = 0;
        let videoBitrateUpload = 0;

        for (const [trackId, trackStats] of this.trackStats.getTrack2stats()) {
            // process packet loss stats
            const loss = trackStats.getLoss();
            const type = loss.isDownloadStream ? "download" : "upload";

            totalPackets[type] += loss.packetsTotal;
            lostPackets[type] += loss.packetsLost;

            // process bitrate stats
            bitrateDownload += trackStats.getBitrate().download;
            bitrateUpload += trackStats.getBitrate().upload;

            // collect resolutions and framerates
            const track = this.trackStats.mediaTrackHandler.getTackById(trackId);

            if (track) {
                if (track.kind === "audio") {
                    audioBitrateDownload += trackStats.getBitrate().download;
                    audioBitrateUpload += trackStats.getBitrate().upload;
                } else {
                    videoBitrateDownload += trackStats.getBitrate().download;
                    videoBitrateUpload += trackStats.getBitrate().upload;
                }

                resolutions[trackStats.getType()].set(trackId, trackStats.getResolution());
                framerates[trackStats.getType()].set(trackId, trackStats.getFramerate());
                codecs[trackStats.getType()].set(trackId, trackStats.getCodec());
            }

            trackStats.resetBitrate();
        }

        this.connectionStats.bitrate = {
            upload: bitrateUpload,
            download: bitrateDownload,
        };

        this.connectionStats.bitrate.audio = {
            upload: audioBitrateUpload,
            download: audioBitrateDownload,
        };

        this.connectionStats.bitrate.video = {
            upload: videoBitrateUpload,
            download: videoBitrateDownload,
        };

        this.connectionStats.packetLoss = {
            total: this.calculatePacketLoss(
                lostPackets.download + lostPackets.upload,
                totalPackets.download + totalPackets.upload,
            ),
            download: this.calculatePacketLoss(lostPackets.download, totalPackets.download),
            upload: this.calculatePacketLoss(lostPackets.upload, totalPackets.upload),
        };

        this.emitter.emitConnectionStatsReport({
            bandwidth: this.connectionStats.bandwidth,
            bitrate: this.connectionStats.bitrate,
            packetLoss: this.connectionStats.packetLoss,
            resolution: resolutions,
            framerate: framerates,
            codec: codecs,
            transport: this.connectionStats.transport,
        });

        this.connectionStats.transport = [];
    }

    public stopProcessingStats(): void {}

    private calculatePacketLoss(lostPackets: number, totalPackets: number): number {
        if (!totalPackets || totalPackets <= 0 || !lostPackets || lostPackets <= 0) {
            return 0;
        }

        return Math.round((lostPackets / totalPackets) * 100);
    }

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
