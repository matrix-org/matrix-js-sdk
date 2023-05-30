import { CallFeedReport } from "./statsReport";

export class CallFeedStatsReporter {
    public static buildCallFeedReport(callId: string, opponentMemberId: string, pc: RTCPeerConnection): CallFeedReport {
        return { callId, opponentMemberId };
    }
}
