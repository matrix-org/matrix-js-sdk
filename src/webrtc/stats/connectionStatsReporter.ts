import { Bitrate } from "./trackStats";

export class ConnectionStatsReporter {
    public static buildBandwidthReport(now: RTCIceCandidatePairStats): Bitrate {
        const availableIncomingBitrate = now.availableIncomingBitrate;
        const availableOutgoingBitrate = now.availableOutgoingBitrate;

        return {
            download: availableIncomingBitrate ? Math.round(availableIncomingBitrate / 1000) : 0,
            upload: availableOutgoingBitrate ? Math.round(availableOutgoingBitrate / 1000) : 0,
        };
    }
}
