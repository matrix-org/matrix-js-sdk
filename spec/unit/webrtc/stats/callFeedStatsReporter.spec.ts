import { CallFeedStatsReporter } from "../../../../src/webrtc/stats/callFeedStatsReporter";
import { CallFeedReport } from "../../../../src/webrtc/stats/statsReport";

const CALL_ID = "CALL_ID";
const USER_ID = "USER_ID";
describe("CallFeedStatsReporter", () => {
    let rtcSpy: RTCPeerConnection;
    beforeEach(() => {});

    describe("", () => {
        it("should emit and receive ByteSendStatsReport", async () => {
            expect(CallFeedStatsReporter.buildCallFeedReport(CALL_ID, USER_ID, rtcSpy)).toEqual({
                callId: CALL_ID,
                opponentMemberId: USER_ID,
            } as CallFeedReport);
        });
    });
});
