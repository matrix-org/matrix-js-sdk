import { CallFeedStatsReporter } from "../../../../src/webrtc/stats/callFeedStatsReporter";
import { CallFeedReport } from "../../../../src/webrtc/stats/statsReport";
import { MockRTCPeerConnection } from "../../../test-utils/webrtc";
import { CallFeed } from "../../../../src/webrtc/callFeed";

const CALL_ID = "CALL_ID";
const USER_ID = "USER_ID";
describe("CallFeedStatsReporter", () => {
    let rtcSpy: RTCPeerConnection;
    beforeEach(() => {
        rtcSpy = {} as RTCPeerConnection;
        rtcSpy.getTransceivers = jest.fn().mockReturnValue(buildTransceiverMocks());
    });

    describe("should", () => {
        it("build CallFeedReport", async () => {
            rtcSpy.getTransceivers();
            expect(CallFeedStatsReporter.buildCallFeedReport(CALL_ID, USER_ID, rtcSpy)).toEqual({
                callId: CALL_ID,
                opponentMemberId: USER_ID,
                callFeeds: [],
                transceiver: [
                    {
                        currenDirection: "sendonly",
                        direction: "sendrecv",
                        mid: 0,
                        receiver: {
                            enabled: true,
                            id: "receiver_audio_0",
                            kind: "audio",
                            muted: false,
                            readyState: "live",
                            stream: "",
                        },
                        sender: {
                            enabled: true,
                            id: "sender_audio_0",
                            kind: "audio",
                            muted: false,
                            readyState: "live",
                            stream: "",
                        },
                    },
                    {
                        currenDirection: "sendrecv",
                        direction: "recvonly",
                        mid: 1,
                        receiver: {
                            enabled: true,
                            id: "receiver_video_1",
                            kind: "video",
                            muted: false,
                            readyState: "live",
                            stream: "",
                        },
                        sender: {
                            enabled: true,
                            id: "sender_video_1",
                            kind: "video",
                            muted: false,
                            readyState: "live",
                            stream: "",
                        },
                    },
                    {
                        currenDirection: "recvonly",
                        direction: "recvonly",
                        mid: 2,
                        receiver: {
                            enabled: true,
                            id: "receiver_video_2",
                            kind: "video",
                            muted: false,
                            readyState: "live",
                            stream: "",
                        },
                        sender: null,
                    },
                ],
            } as CallFeedReport);
        });

        it("extend CallFeedReport with call feeds", async () => {
            const callFeeds: CallFeed[] = [];
            expect(
                CallFeedStatsReporter.expandCallFeedReport({ callFeeds: [] } as CallFeedReport, callFeeds).callFeeds,
            ).toEqual([]);
        });
    });

    const buildTransceiverMocks = (): RTCRtpTransceiver[] => {
        const trans1 = {
            mid: 0,
            direction: "sendrecv",
            currentDirection: "sendonly",
            sender: buildSenderMock("sender_audio_0", "audio"),
            receiver: buildReceiverMock("receiver_audio_0", "audio"),
        } as RTCRtpTransceiver;
        const trans2 = {
            mid: 1,
            direction: "recvonly",
            currentDirection: "sendrecv",
            sender: buildSenderMock("sender_video_1", "video"),
            receiver: buildReceiverMock("receiver_video_1", "video"),
        } as RTCRtpTransceiver;
        const trans3 = {
            mid: 2,
            direction: "recvonly",
            currentDirection: "recvonly",
            sender: { track: null } as RTCRtpSender,
            receiver: buildReceiverMock("receiver_video_2", "video"),
        } as RTCRtpTransceiver;
        return [trans1, trans2, trans3];
    };

    const buildSenderMock = (id: string, kind: "audio" | "video"): RTCRtpSender => {
        const track = buildTrackMock(id, kind);
        return {
            track,
        } as RTCRtpSender;
    };

    const buildReceiverMock = (id: string, kind: "audio" | "video"): RTCRtpReceiver => {
        const track = buildTrackMock(id, kind);
        return {
            track,
        } as RTCRtpReceiver;
    };

    const buildTrackMock = (id: string, kind: "audio" | "video"): MediaStreamTrack => {
        return {
            id,
            kind,
            enabled: true,
            label: "--",
            muted: false,
            readyState: "live",
        } as MediaStreamTrack;
    };
});
