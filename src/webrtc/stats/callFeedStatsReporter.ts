import { CallFeedReport, CallFeedStats, TrackStats, TransceiverStats } from "./statsReport";
import { CallFeed } from "../callFeed";

export class CallFeedStatsReporter {
    public static buildCallFeedReport(callId: string, opponentMemberId: string, pc: RTCPeerConnection): CallFeedReport {
        const rtpTransceivers = pc.getTransceivers();
        const transceiver: TransceiverStats[] = [];
        const callFeeds: CallFeedStats[] = [];

        rtpTransceivers.forEach((t) => {
            const sender = t.sender?.track ? CallFeedStatsReporter.buildTrackStats(t.sender.track, "sender") : null;
            const receiver = CallFeedStatsReporter.buildTrackStats(t.receiver.track, "receiver");
            transceiver.push({
                mid: t.mid == null ? "null" : t.mid,
                direction: t.direction,
                currenDirection: t.currentDirection == null ? "null" : t.currentDirection,
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

    private static buildTrackStats(track: MediaStreamTrack, label = "--"): TrackStats {
        const settingDeviceId = track.getSettings()?.deviceId;
        const constrainDeviceId = track.getConstraints()?.deviceId;

        return {
            id: track.id,
            kind: track.kind,
            settingDeviceId: settingDeviceId ? settingDeviceId : "unknown",
            constrainDeviceId: constrainDeviceId ? constrainDeviceId : "unknown",
            muted: track.muted,
            enabled: track.enabled,
            readyState: track.readyState,
            label,
        } as TrackStats;
    }

    public static expandCallFeedReport(
        report: CallFeedReport,
        callFeeds: CallFeed[],
        prefix = "unknown",
    ): CallFeedReport {
        if (!report.callFeeds) {
            report.callFeeds = [];
        }
        callFeeds.forEach((feed) => {
            const audioTracks = feed.stream.getAudioTracks();
            const videoTracks = feed.stream.getVideoTracks();
            const audio =
                audioTracks.length > 0
                    ? CallFeedStatsReporter.buildTrackStats(feed.stream.getAudioTracks()[0], feed.purpose)
                    : null;
            const video =
                videoTracks.length > 0
                    ? CallFeedStatsReporter.buildTrackStats(feed.stream.getVideoTracks()[0], feed.purpose)
                    : null;
            const feedStats = {
                stream: feed.stream.id,
                type: feed.isLocal() ? "local" : "remote",
                audio,
                video,
                purpose: feed.purpose,
                prefix,
                isVideoMuted: feed.isVideoMuted(),
                isAudioMuted: feed.isAudioMuted(),
            } as CallFeedStats;
            report.callFeeds.push(feedStats);
        });
        return report;
    }
}
