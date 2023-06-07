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
import { CallFeedStatsReporter } from "../../../../src/webrtc/stats/callFeedStatsReporter";
import { CallFeedReport } from "../../../../src/webrtc/stats/statsReport";
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
        it("builds CallFeedReport", async () => {
            expect(CallFeedStatsReporter.buildCallFeedReport(CALL_ID, USER_ID, rtcSpy)).toEqual({
                callId: CALL_ID,
                opponentMemberId: USER_ID,
                callFeeds: [],
                transceiver: [
                    {
                        currentDirection: "sendonly",
                        direction: "sendrecv",
                        mid: "0",
                        receiver: {
                            constrainDeviceId: "constrainDeviceId-receiver_audio_0",
                            enabled: true,
                            id: "receiver_audio_0",
                            kind: "audio",
                            label: "receiver",
                            muted: false,
                            readyState: "live",
                            settingDeviceId: "settingDeviceId-receiver_audio_0",
                        },
                        sender: {
                            constrainDeviceId: "constrainDeviceId-sender_audio_0",
                            enabled: true,
                            id: "sender_audio_0",
                            kind: "audio",
                            label: "sender",
                            muted: false,
                            readyState: "live",
                            settingDeviceId: "settingDeviceId-sender_audio_0",
                        },
                    },
                    {
                        currentDirection: "sendrecv",
                        direction: "recvonly",
                        mid: "1",
                        receiver: {
                            constrainDeviceId: "constrainDeviceId-receiver_video_1",
                            enabled: true,
                            id: "receiver_video_1",
                            kind: "video",
                            label: "receiver",
                            muted: false,
                            readyState: "live",
                            settingDeviceId: "settingDeviceId-receiver_video_1",
                        },
                        sender: {
                            constrainDeviceId: "constrainDeviceId-sender_video_1",
                            enabled: true,
                            id: "sender_video_1",
                            kind: "video",
                            label: "sender",
                            muted: false,
                            readyState: "live",
                            settingDeviceId: "settingDeviceId-sender_video_1",
                        },
                    },
                    {
                        currentDirection: "recvonly",
                        direction: "recvonly",
                        mid: "2",
                        receiver: {
                            constrainDeviceId: "constrainDeviceId-receiver_video_2",
                            enabled: true,
                            id: "receiver_video_2",
                            kind: "video",
                            label: "receiver",
                            muted: false,
                            readyState: "live",
                            settingDeviceId: "settingDeviceId-receiver_video_2",
                        },
                        sender: null,
                    },
                ],
            } as CallFeedReport);
        });

        it("extends CallFeedReport with call feeds", async () => {
            const feed = buildCallFeedMock("1");
            const callFeedList: CallFeed[] = [feed];
            const report = {
                callId: "callId",
                opponentMemberId: "opponentMemberId",
                transceiver: [],
                callFeeds: [],
            } as CallFeedReport;

            expect(CallFeedStatsReporter.expandCallFeedReport(report, callFeedList).callFeeds).toEqual([
                {
                    audio: {
                        constrainDeviceId: "constrainDeviceId-video-1",
                        enabled: true,
                        id: "video-1",
                        kind: "video",
                        label: "--",
                        muted: false,
                        readyState: "live",
                        settingDeviceId: "settingDeviceId-video-1",
                    },
                    isAudioMuted: true,
                    isVideoMuted: false,
                    prefix: "unknown",
                    stream: "stream-1",
                    type: "local",
                    video: {
                        constrainDeviceId: "constrainDeviceId-audio-1",
                        enabled: true,
                        id: "audio-1",
                        kind: "audio",
                        label: "--",
                        muted: false,
                        readyState: "live",
                        settingDeviceId: "settingDeviceId-audio-1",
                    },
                },
            ]);
        });
    });

    const buildTransceiverMocks = (): RTCRtpTransceiver[] => {
        const trans1 = {
            mid: "0",
            direction: "sendrecv",
            currentDirection: "sendonly",
            sender: buildSenderMock("sender_audio_0", "audio"),
            receiver: buildReceiverMock("receiver_audio_0", "audio"),
        } as RTCRtpTransceiver;
        const trans2 = {
            mid: "1",
            direction: "recvonly",
            currentDirection: "sendrecv",
            sender: buildSenderMock("sender_video_1", "video"),
            receiver: buildReceiverMock("receiver_video_1", "video"),
        } as RTCRtpTransceiver;
        const trans3 = {
            mid: "2",
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
            getSettings: () => ({ deviceId: `settingDeviceId-${id}` }),
            getConstraints: () => ({ deviceId: `constrainDeviceId-${id}` }),
        } as MediaStreamTrack;
    };

    const buildCallFeedMock = (id: string, isLocal = true): CallFeed => {
        const stream = {
            id: `stream-${id}`,
            getAudioTracks(): MediaStreamTrack[] {
                return [buildTrackMock(`video-${id}`, "video")];
            },
            getVideoTracks(): MediaStreamTrack[] {
                return [buildTrackMock(`audio-${id}`, "audio")];
            },
        } as MediaStream;
        return {
            stream,
            isLocal: () => isLocal,
            isVideoMuted: () => false,
            isAudioMuted: () => true,
        } as CallFeed;
    };
});
