import { CallFeedReport, CallFeedStats, TrackStats, TransceiverStats } from "./statsReport";
import { CallFeed } from "../callFeed";

export class CallFeedStatsReporter {
    public static buildCallFeedReport(callId: string, opponentMemberId: string, pc: RTCPeerConnection): CallFeedReport {
        const rtpTransceivers = pc.getTransceivers();
        const transceiver: TransceiverStats[] = [];
        const callFeeds: CallFeedStats[] = [];

        rtpTransceivers.forEach((t) => {
            const sender = t.sender?.track ? CallFeedStatsReporter.buildTrackStats(t.sender.track, "") : null;
            const receiver = CallFeedStatsReporter.buildTrackStats(t.receiver.track, "");
            transceiver.push({
                mid: t.mid,
                direction: t.direction,
                currenDirection: t.currentDirection,
                sender,
                receiver,
            });
        });

        return {
            callId,
            opponentMemberId,
            transceiver,
            callFeeds,
        };
    }

    private static buildTrackStats(track: MediaStreamTrack, stream: string): TrackStats {
        return {
            id: track.id,
            kind: track.kind,
            stream,
            muted: track.muted,
            enabled: track.enabled,
            readyState: track.readyState,
        } as TrackStats;
    }

    public static expandCallFeedReport(report: CallFeedReport, callFeeds: CallFeed[]): CallFeedReport {
        return report;
    }
}
