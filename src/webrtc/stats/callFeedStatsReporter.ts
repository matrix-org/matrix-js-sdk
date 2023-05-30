import { CallFeedReport } from "./statsReport";

export class CallFeedStatsReporter {
    static buildCallFeedReport(callId: string, opponentMemberId: string, pc: RTCPeerConnection): CallFeedReport {
        return { callId, opponentMemberId };
    }
}
