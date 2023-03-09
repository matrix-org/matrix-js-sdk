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
import { SsrcStats } from "./ssrcStats";
import { TransportStats } from "./transportStats";
import { StatsEventEmitter } from "./statsEventEmitter";
import { StatsEvent } from "./statsEvent";

export class StatsCollector {
    private isActive = true;
    private previousStatsReport: RTCStatsReport | undefined;
    private currentStatsReport: RTCStatsReport | undefined;
    private readonly connectionStats = new ConnectionStats();
    private readonly ssrc2stats = new Map<number, SsrcStats>();
    private readonly emitter: StatsEventEmitter = new StatsEventEmitter();

    public constructor(
        public readonly callId: string,
        public readonly remoteUserId: string,
        private readonly pc: RTCPeerConnection,
        private readonly isFocus = false,
    ) {}

    public processStats(groupCallId: string, localUserId: string): Promise<boolean> {
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
        const byteSentStats = new Map<number, number>();

        this.currentStatsReport?.forEach((now) => {
            const before = this.previousStatsReport ? this.previousStatsReport.get(now.id) : null;

            // RTCIceCandidatePairStats - https://w3c.github.io/webrtc-stats/#candidatepair-dict*
            if (now.type === "candidate-pair" && now.nominated && now.state === "succeeded") {
                const availableIncomingBitrate = now.availableIncomingBitrate;
                const availableOutgoingBitrate = now.availableOutgoingBitrate;

                if (availableIncomingBitrate || availableOutgoingBitrate) {
                    this.connectionStats.bandwidth = {
                        download: Math.round(availableIncomingBitrate / 1000),
                        upload: Math.round(availableOutgoingBitrate / 1000),
                    };
                }

                const remoteUsedCandidate = this.currentStatsReport?.get(now.remoteCandidateId);
                const localUsedCandidate = this.currentStatsReport?.get(now.localCandidateId);

                // RTCIceCandidateStats
                // https://w3c.github.io/webrtc-stats/#icecandidate-dict*
                if (remoteUsedCandidate && localUsedCandidate) {
                    const remoteIpAddress =
                        remoteUsedCandidate.ip !== undefined ? remoteUsedCandidate.ip : remoteUsedCandidate.address;
                    const remotePort = remoteUsedCandidate.port;
                    const ip = `${remoteIpAddress}:${remotePort}`;

                    const localIpAddress =
                        localUsedCandidate.ip !== undefined ? localUsedCandidate.ip : localUsedCandidate.address;
                    const localPort = localUsedCandidate.port;
                    const localIp = `${localIpAddress}:${localPort}`;
                    const type = remoteUsedCandidate.protocol;

                    // Save the address unless it has been saved already.
                    const conferenceStatsTransport = this.connectionStats.transport;

                    if (
                        !conferenceStatsTransport.some(
                            (t: TransportStats) => t.ip === ip && t.type === type && t.localIp === localIp,
                        )
                    ) {
                        conferenceStatsTransport.push({
                            ip,
                            type,
                            localIp,
                            isFocus: this.isFocus,
                            localCandidateType: localUsedCandidate.candidateType,
                            remoteCandidateType: remoteUsedCandidate.candidateType,
                            networkType: localUsedCandidate.networkType,
                            rtt: now.currentRoundTripTime * 1000,
                        } as TransportStats);
                    }
                }

                // RTCReceivedRtpStreamStats
                // https://w3c.github.io/webrtc-stats/#receivedrtpstats-dict*
                // RTCSentRtpStreamStats
                // https://w3c.github.io/webrtc-stats/#sentrtpstats-dict*
            } else if (now.type === "inbound-rtp" || now.type === "outbound-rtp") {
                const ssrc = this.getNonNegativeValue(now.mid);

                if (!ssrc) {
                    return;
                }

                let ssrcStats = this.ssrc2stats.get(ssrc);

                if (!ssrcStats) {
                    ssrcStats = new SsrcStats();
                    this.ssrc2stats.set(ssrc, ssrcStats);
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

                    ssrcStats.setLoss({
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
                        ssrcStats.setResolution(resolution);
                    }
                    ssrcStats.setFramerate(Math.round(frameRate || 0));

                    if (before) {
                        ssrcStats.addBitrate({
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
                    byteSentStats.set(ssrc, this.getNonNegativeValue(now.bytesSent));
                    ssrcStats.addBitrate({
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

                    codecShortType && ssrcStats.setCodec(codecShortType);
                }

                // Use track stats for resolution and framerate of the local video source.
                // RTCVideoHandlerStats - https://w3c.github.io/webrtc-stats/#vststats-dict*
                // RTCMediaHandlerStats - https://w3c.github.io/webrtc-stats/#mststats-dict*
            } else if (now.type === "track" && now.kind === "video" && !now.remoteSource) {
                const resolution = {
                    height: now.frameHeight,
                    width: now.frameWidth,
                };
                const localVideoTracks = this.getLocalTracks("video");

                if (!localVideoTracks?.length) {
                    return;
                }

                const ssrc = this.getSsrcByTrackId(now.trackIdentifier);

                if (!ssrc) {
                    return;
                }
                let ssrcStats = this.ssrc2stats.get(ssrc);

                if (!ssrcStats) {
                    ssrcStats = new SsrcStats();
                    this.ssrc2stats.set(ssrc, ssrcStats);
                }
                if (resolution.height && resolution.width) {
                    ssrcStats.setResolution(resolution);
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
                const numberOfActiveStreams = this.getActiveSimulcastStreams();

                // Reset frame rate to 0 when video is suspended as a result of endpoint falling out of last-n.
                frameRate = numberOfActiveStreams ? Math.round(frameRate / numberOfActiveStreams) : 0;
                ssrcStats.setFramerate(frameRate);
            }
        });

        this.emitter.emitByteSendReport(byteSentStats, this.callId);
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

    private getLocalTracks(kind: "audio" | "video"): MediaStreamTrack[] | undefined {
        //@TODO implement this right by using MID
        return undefined;
    }

    private getSsrcByTrackId(trackIdentifier: any): number | undefined {
        //@TODO implement this right by using MID
        return undefined;
    }

    private getTackBySSRC(ssrc: number): MediaStreamTrack | undefined {
        //@TODO implement this right by using MID
        return undefined;
    }

    private getActiveSimulcastStreams(): number {
        //@TODO implement this right.. Check how many layer configured
        return 3;
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
        const resolutions = {};
        const framerates = {};
        const codecs = {};
        let audioBitrateDownload = 0;
        let audioBitrateUpload = 0;
        let videoBitrateDownload = 0;
        let videoBitrateUpload = 0;

        for (const [ssrc, ssrcStats] of this.ssrc2stats) {
            // process packet loss stats
            const loss = ssrcStats.getLoss();
            const type = loss.isDownloadStream ? "download" : "upload";

            totalPackets[type] += loss.packetsTotal;
            lostPackets[type] += loss.packetsLost;

            // process bitrate stats
            bitrateDownload += ssrcStats.getBitrate().download;
            bitrateUpload += ssrcStats.getBitrate().upload;

            // collect resolutions and framerates
            const track = this.getTackBySSRC(ssrc);

            if (track) {
                let audioCodec;
                let videoCodec;

                if (track.kind === "audio") {
                    audioBitrateDownload += ssrcStats.getBitrate().download;
                    audioBitrateUpload += ssrcStats.getBitrate().upload;
                    audioCodec = ssrcStats.getCodec();
                } else {
                    videoBitrateDownload += ssrcStats.getBitrate().download;
                    videoBitrateUpload += ssrcStats.getBitrate().upload;
                    videoCodec = ssrcStats.getCodec();
                }

                // @TODO Find a way to identify participant by track!!! and //@TODO implement this right by using MID
                const participantId = "uuid"; // track.getParticipantId();

                if (participantId) {
                    const resolution = ssrcStats.getResolution();

                    if (resolution.width && resolution.height && resolution.width !== -1 && resolution.height !== -1) {
                        // @ts-ignore Fix with Type
                        const userResolutions = resolutions[participantId] || {};

                        userResolutions[ssrc] = resolution;
                        // @ts-ignore Fix with Type
                        resolutions[participantId] = userResolutions;
                    }

                    if (ssrcStats.getFramerate() > 0) {
                        // @ts-ignore Fix with Type
                        const userFramerates = framerates[participantId] || {};
                        userFramerates[ssrc] = ssrcStats.getFramerate();
                        // @ts-ignore Fix with Type
                        framerates[participantId] = userFramerates;
                    }

                    // @ts-ignore Fix with Type
                    const userCodecs = codecs[participantId] ?? {};

                    userCodecs[ssrc] = {
                        audio: audioCodec,
                        video: videoCodec,
                    };

                    // @ts-ignore Fix with Type
                    codecs[participantId] = userCodecs;
                } else {
                    // No participant ID returned by ${track}`;
                }
            }

            ssrcStats.resetBitrate();
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

        this.emitter.emit(StatsEvent.CONNECTION_STATS, this.pc, {
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

    private calculatePacketLoss(number: number, number2: number): number {
        return 0;
    }
}
