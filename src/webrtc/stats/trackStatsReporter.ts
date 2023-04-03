import { MediaTrackStats } from "./media/mediaTrackStats";
import { StatsValueFormatter } from "./statsValueFormatter";

export class TrackStatsReporter {
    public static buildFramerateResolution(trackStats: MediaTrackStats, now: any): void {
        const resolution = {
            height: now.frameHeight,
            width: now.frameWidth,
        };
        const frameRate = now.framesPerSecond;

        if (resolution.height && resolution.width) {
            trackStats.setResolution(resolution);
        }
        trackStats.setFramerate(Math.round(frameRate || 0));
    }

    public static calculateSimulcastFramerate(trackStats: MediaTrackStats, now: any, before: any, layer: number): void {
        let frameRate = trackStats.getFramerate();
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

        // Reset frame rate to 0 when video is suspended as a result of endpoint falling out of last-n.
        frameRate = layer ? Math.round(frameRate / layer) : 0;
        trackStats.setFramerate(frameRate);
    }

    public static buildCodec(report: RTCStatsReport | undefined, trackStats: MediaTrackStats, now: any): void {
        const codec = report?.get(now.codecId);

        if (codec) {
            /**
             * The mime type has the following form: video/VP8 or audio/ISAC,
             * so we what to keep just the type after the '/', audio and video
             * keys will be added on the processing side.
             */
            const codecShortType = codec.mimeType.split("/")[1];

            codecShortType && trackStats.setCodec(codecShortType);
        }
    }

    public static buildBitrateReceived(trackStats: MediaTrackStats, now: any, before: any): void {
        trackStats.setBitrate({
            download: TrackStatsReporter.calculateBitrate(
                now.bytesReceived,
                before.bytesReceived,
                now.timestamp,
                before.timestamp,
            ),
            upload: 0,
        });
    }

    public static buildBitrateSend(trackStats: MediaTrackStats, now: any, before: any): void {
        trackStats.setBitrate({
            download: 0,
            upload: this.calculateBitrate(now.bytesSent, before.bytesSent, now.timestamp, before.timestamp),
        });
    }

    public static buildPacketsLost(trackStats: MediaTrackStats, now: any, before: any): void {
        const key = now.type === "outbound-rtp" ? "packetsSent" : "packetsReceived";

        let packetsNow = now[key];
        if (!packetsNow || packetsNow < 0) {
            packetsNow = 0;
        }

        const packetsBefore = StatsValueFormatter.getNonNegativeValue(before[key]);
        const packetsDiff = Math.max(0, packetsNow - packetsBefore);

        const packetsLostNow = StatsValueFormatter.getNonNegativeValue(now.packetsLost);
        const packetsLostBefore = StatsValueFormatter.getNonNegativeValue(before.packetsLost);
        const packetsLostDiff = Math.max(0, packetsLostNow - packetsLostBefore);

        trackStats.setLoss({
            packetsTotal: packetsDiff + packetsLostDiff,
            packetsLost: packetsLostDiff,
            isDownloadStream: now.type !== "outbound-rtp",
        });
    }

    private static calculateBitrate(
        bytesNowAny: any,
        bytesBeforeAny: any,
        nowTimestamp: number,
        beforeTimestamp: number,
    ): number {
        const bytesNow = StatsValueFormatter.getNonNegativeValue(bytesNowAny);
        const bytesBefore = StatsValueFormatter.getNonNegativeValue(bytesBeforeAny);
        const bytesProcessed = Math.max(0, bytesNow - bytesBefore);

        const timeMs = nowTimestamp - beforeTimestamp;
        let bitrateKbps = 0;

        if (timeMs > 0) {
            // TODO is there any reason to round here?
            bitrateKbps = Math.round((bytesProcessed * 8) / timeMs);
        }

        return bitrateKbps;
    }
}
