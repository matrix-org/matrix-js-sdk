/*
Copyright 2020 - 2022 The Matrix.org Foundation C.I.C.

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

import { TestClient } from '../../TestClient';
import {
    MatrixCall,
    CallErrorCode,
    CallEvent,
    supportsMatrixCall,
    CallType,
    CallState,
} from '../../../src/webrtc/call';
import { SDPStreamMetadata, SDPStreamMetadataKey, SDPStreamMetadataPurpose } from '../../../src/webrtc/callEventTypes';
import {
    DUMMY_SDP,
    MockMediaHandler,
    MockMediaStream,
    MockMediaStreamTrack,
    installWebRTCMocks,
    MockRTCPeerConnection,
    SCREENSHARE_STREAM_ID,
} from "../../test-utils/webrtc";
import { CallFeed } from "../../../src/webrtc/callFeed";
import { EventType, MatrixEvent } from "../../../src";

const FAKE_ROOM_ID = "!foo:bar";
const CALL_LIFETIME = 60000;

const startVoiceCall = async (client: TestClient, call: MatrixCall): Promise<void> => {
    const callPromise = call.placeVoiceCall();
    await client.httpBackend.flush("");
    await callPromise;

    call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });
};

const startVideoCall = async (client: TestClient, call: MatrixCall): Promise<void> => {
    const callPromise = call.placeVideoCall();
    await client.httpBackend.flush("");
    await callPromise;

    call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });
};

const fakeIncomingCall = async (client: TestClient, call: MatrixCall, version: string | number = "1") => {
    const callPromise = call.initWithInvite({
        getContent: jest.fn().mockReturnValue({
            version,
            call_id: "call_id",
            party_id: "remote_party_id",
            lifetime: CALL_LIFETIME,
            offer: {
                sdp: DUMMY_SDP,
            },
        }),
        getSender: () => "@test:foo",
        getLocalAge: () => 1,
    } as unknown as MatrixEvent);
    call.getFeeds().push(new CallFeed({
        client: client.client,
        userId: "remote_user_id",
        // @ts-ignore Mock
        stream: new MockMediaStream("remote_stream_id", [new MockMediaStreamTrack("remote_tack_id")]),
        id: "remote_feed_id",
        purpose: SDPStreamMetadataPurpose.Usermedia,
    }));
    await callPromise;
};

describe('Call', function() {
    let client;
    let call;
    let prevNavigator;
    let prevDocument;
    let prevWindow;

    beforeEach(function() {
        prevNavigator = global.navigator;
        prevDocument = global.document;
        prevWindow = global.window;

        installWebRTCMocks();

        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {});
        // We just stub out sendEvent: we're not interested in testing the client's
        // event sending code here
        client.client.sendEvent = jest.fn();
        client.client.mediaHandler = new MockMediaHandler;
        client.client.getMediaHandler = () => client.client.mediaHandler;
        client.client.turnServersExpiry = Date.now() + 60 * 60 * 1000;
        client.httpBackend.when("GET", "/voip/turnServer").respond(200, {});
        client.client.getRoom = () => {
            return {
                getMember: () => {
                    return {};
                },
            };
        };

        call = new MatrixCall({
            client: client.client,
            roomId: FAKE_ROOM_ID,
        });
        // call checks one of these is wired up
        call.on('error', () => {});
    });

    afterEach(function() {
        client.stop();
        global.navigator = prevNavigator;
        global.window = prevWindow;
        global.document = prevDocument;

        jest.useRealTimers();
    });

    it('should ignore candidate events from non-matching party ID', async function() {
        await startVoiceCall(client, call);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        call.peerConn.addIceCandidate = jest.fn();
        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    candidates: [
                        {
                            candidate: '',
                            sdpMid: '',
                        },
                    ],
                };
            },
            getSender: () => "@test:foo",
        });
        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'some_other_party_id',
                    candidates: [
                        {
                            candidate: '',
                            sdpMid: '',
                        },
                    ],
                };
            },
            getSender: () => "@test:foo",
        });
        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);

        // Hangup to stop timers
        call.hangup(CallErrorCode.UserHangup, true);
    });

    it('should add candidates received before answer if party ID is correct', async function() {
        await startVoiceCall(client, call);
        call.peerConn.addIceCandidate = jest.fn();

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    candidates: [
                        {
                            candidate: 'the_correct_candidate',
                            sdpMid: '',
                        },
                    ],
                };
            },
            getSender: () => "@test:foo",
        });

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'some_other_party_id',
                    candidates: [
                        {
                            candidate: 'the_wrong_candidate',
                            sdpMid: '',
                        },
                    ],
                };
            },
            getSender: () => "@test:foo",
        });

        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(0);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);
        expect(call.peerConn.addIceCandidate).toHaveBeenCalledWith({
            candidate: 'the_correct_candidate',
            sdpMid: '',
        });
    });

    it('should map asserted identity messages to remoteAssertedIdentity', async function() {
        await startVoiceCall(client, call);
        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        const identChangedCallback = jest.fn();
        call.on(CallEvent.AssertedIdentityChanged, identChangedCallback);

        await call.onAssertedIdentityReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    asserted_identity: {
                        id: "@steve:example.com",
                        display_name: "Steve Gibbons",
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        expect(identChangedCallback).toHaveBeenCalled();

        const ident = call.getRemoteAssertedIdentity();
        expect(ident.id).toEqual("@steve:example.com");
        expect(ident.displayName).toEqual("Steve Gibbons");

        // Hangup to stop timers
        call.hangup(CallErrorCode.UserHangup, true);
    });

    it("should map SDPStreamMetadata to feeds", async () => {
        await startVoiceCall(client, call);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                    [SDPStreamMetadataKey]: {
                        "remote_stream": {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            audio_muted: true,
                            video_muted: false,
                        },
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        call.pushRemoteFeed(
            new MockMediaStream(
                "remote_stream",
                [
                    new MockMediaStreamTrack("remote_audio_track", "audio"),
                    new MockMediaStreamTrack("remote_video_track", "video"),
                ],
            ),
        );
        const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream");
        expect(feed?.purpose).toBe(SDPStreamMetadataPurpose.Usermedia);
        expect(feed?.isAudioMuted()).toBeTruthy();
        expect(feed?.isVideoMuted()).not.toBeTruthy();
    });

    it("should fallback to replaceTrack() if the other side doesn't support SPDStreamMetadata", async () => {
        await startVoiceCall(client, call);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        call.setScreensharingEnabledWithoutMetadataSupport = jest.fn();

        call.setScreensharingEnabled(true);
        expect(call.setScreensharingEnabledWithoutMetadataSupport).toHaveBeenCalled();
    });

    it("should fallback to answering with no video", async () => {
        await client.httpBackend.flush();

        call.shouldAnswerWithMediaType = (wantedValue: boolean) => wantedValue;
        client.client.mediaHandler.getUserMediaStream = jest.fn().mockRejectedValue("reject");

        await call.answer(true, true);

        expect(client.client.mediaHandler.getUserMediaStream).toHaveBeenNthCalledWith(1, true, true);
        expect(client.client.mediaHandler.getUserMediaStream).toHaveBeenNthCalledWith(2, true, false);
    });

    it("should handle mid-call device changes", async () => {
        client.client.mediaHandler.getUserMediaStream = jest.fn().mockReturnValue(
            new MockMediaStream(
                "stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ],
            ),
        );

        await startVoiceCall(client, call);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
            getSender: () => "@test:foo",
        });

        await call.updateLocalUsermediaStream(
            new MockMediaStream(
                "replacement_stream",
                [
                    new MockMediaStreamTrack("new_audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ],
            ),
        );
        expect(call.localUsermediaStream.id).toBe("stream");
        expect(call.localUsermediaStream.getAudioTracks()[0].id).toBe("new_audio_track");
        expect(call.localUsermediaStream.getVideoTracks()[0].id).toBe("video_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "audio";
        }).track.id).toBe("new_audio_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "video";
        }).track.id).toBe("video_track");
    });

    it("should handle upgrade to video call", async () => {
        await startVoiceCall(client, call);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                    [SDPStreamMetadataKey]: {},
                };
            },
            getSender: () => "@test:foo",
        });

        await call.upgradeCall(false, true);

        expect(call.localUsermediaStream.getAudioTracks()[0].id).toBe("audio_track");
        expect(call.localUsermediaStream.getVideoTracks()[0].id).toBe("video_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "audio";
        }).track.id).toBe("audio_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "video";
        }).track.id).toBe("video_track");
    });

    it("should handle SDPStreamMetadata changes", async () => {
        await startVoiceCall(client, call);

        call.updateRemoteSDPStreamMetadata({
            "remote_stream": {
                purpose: SDPStreamMetadataPurpose.Usermedia,
                audio_muted: false,
                video_muted: false,
            },
        });
        call.pushRemoteFeed(new MockMediaStream("remote_stream", []));
        const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream");

        call.onSDPStreamMetadataChangedReceived({
            getContent: () => ({
                [SDPStreamMetadataKey]: {
                    "remote_stream": {
                        purpose: SDPStreamMetadataPurpose.Screenshare,
                        audio_muted: true,
                        video_muted: true,
                        id: "feed_id2",
                    },
                },
            }),
        });

        expect(feed?.purpose).toBe(SDPStreamMetadataPurpose.Screenshare);
        expect(feed?.audioMuted).toBe(true);
        expect(feed?.videoMuted).toBe(true);
    });

    it("should choose opponent member", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        const opponentMember = {
            roomId: call.roomId,
            userId: "opponentUserId",
        };

        client.client.getRoom = () => {
            return {
                getMember: (userId) => {
                    if (userId === opponentMember.userId) {
                        return opponentMember;
                    }
                },
            };
        };

        const opponentCaps = {
            "m.call.transferee": true,
            "m.call.dtmf": false,
        };
        call.chooseOpponent({
            getContent: () => ({
                version: 1,
                party_id: "party_id",
                capabilities: opponentCaps,
            }),
            getSender: () => opponentMember.userId,
        });

        expect(call.getOpponentMember()).toBe(opponentMember);
        expect(call.opponentPartyId).toBe("party_id");
        expect(call.opponentCaps).toBe(opponentCaps);
        expect(call.opponentCanBeTransferred()).toBe(true);
        expect(call.opponentSupportsDTMF()).toBe(false);
    });

    describe("should deduce the call type correctly", () => {
        it("if no video", async () => {
            call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });

            call.pushRemoteFeed(new MockMediaStream("remote_stream1", []));
            expect(call.type).toBe(CallType.Voice);
        });

        it("if remote video", async () => {
            call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });

            call.pushRemoteFeed(new MockMediaStream("remote_stream1", [new MockMediaStreamTrack("track_id", "video")]));
            expect(call.type).toBe(CallType.Video);
        });

        it("if local video", async () => {
            call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });

            call.pushNewLocalFeed(
                new MockMediaStream("remote_stream1", [new MockMediaStreamTrack("track_id", "video")]),
                SDPStreamMetadataPurpose.Usermedia,
                false,
            );
            expect(call.type).toBe(CallType.Video);
        });
    });

    it("should correctly generate local SDPStreamMetadata", async () => {
        const callPromise = call.placeCallWithCallFeeds([new CallFeed({
            client,
            // @ts-ignore Mock
            stream: new MockMediaStream("local_stream1", [new MockMediaStreamTrack("track_id", "audio")]),
            roomId: call.roomId,
            userId: client.getUserId(),
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: false,
            videoMuted: false,
        })]);
        await client.httpBackend.flush();
        await callPromise;
        call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });

        call.pushNewLocalFeed(
            new MockMediaStream("local_stream2", [new MockMediaStreamTrack("track_id", "video")]),
            SDPStreamMetadataPurpose.Screenshare, "feed_id2",
        );
        await call.setMicrophoneMuted(true);

        expect(call.getLocalSDPStreamMetadata()).toStrictEqual({
            "local_stream1": {
                "purpose": SDPStreamMetadataPurpose.Usermedia,
                "audio_muted": true,
                "video_muted": true,
            },
            "local_stream2": {
                "purpose": SDPStreamMetadataPurpose.Screenshare,
                "audio_muted": true,
                "video_muted": false,
            },
        });
    });

    it("feed and stream getters return correctly", async () => {
        const localUsermediaStream = new MockMediaStream("local_usermedia_stream_id", []);
        const localScreensharingStream = new MockMediaStream("local_screensharing_stream_id", []);
        const remoteUsermediaStream = new MockMediaStream("remote_usermedia_stream_id", []);
        const remoteScreensharingStream = new MockMediaStream("remote_screensharing_stream_id", []);

        const callPromise = call.placeCallWithCallFeeds([
            new CallFeed({
                client,
                userId: client.getUserId(),
                // @ts-ignore Mock
                stream: localUsermediaStream,
                purpose: SDPStreamMetadataPurpose.Usermedia,
                id: "local_usermedia_feed_id",
                audioMuted: false,
                videoMuted: false,
            }),
            new CallFeed({
                client,
                userId: client.getUserId(),
                // @ts-ignore Mock
                stream: localScreensharingStream,
                purpose: SDPStreamMetadataPurpose.Screenshare,
                id: "local_screensharing_feed_id",
                audioMuted: false,
                videoMuted: false,
            }),
        ]);
        await client.httpBackend.flush();
        await callPromise;
        call.getOpponentMember = jest.fn().mockReturnValue({ userId: "@bob:bar.uk" });

        call.updateRemoteSDPStreamMetadata({
            "remote_usermedia_stream_id": {
                purpose: SDPStreamMetadataPurpose.Usermedia,
                id: "remote_usermedia_feed_id",
                audio_muted: false,
                video_muted: false,
            },
            "remote_screensharing_stream_id": {
                purpose: SDPStreamMetadataPurpose.Screenshare,
                id: "remote_screensharing_feed_id",
                audio_muted: false,
                video_muted: false,
            },
        });
        call.pushRemoteFeed(remoteUsermediaStream);
        call.pushRemoteFeed(remoteScreensharingStream);

        expect(call.localUsermediaFeed.stream).toBe(localUsermediaStream);
        expect(call.localUsermediaStream).toBe(localUsermediaStream);
        expect(call.localScreensharingFeed.stream).toBe(localScreensharingStream);
        expect(call.localScreensharingStream).toBe(localScreensharingStream);
        expect(call.remoteUsermediaFeed.stream).toBe(remoteUsermediaStream);
        expect(call.remoteUsermediaStream).toBe(remoteUsermediaStream);
        expect(call.remoteScreensharingFeed.stream).toBe(remoteScreensharingStream);
        expect(call.remoteScreensharingStream).toBe(remoteScreensharingStream);
        expect(call.hasRemoteUserMediaAudioTrack).toBe(false);
    });

    it("should end call after receiving a select event with a different party id", async () => {
        await fakeIncomingCall(client, call);

        const callHangupCallback = jest.fn();
        call.on(CallEvent.Hangup, callHangupCallback);

        await call.onSelectAnswerReceived({
            getContent: () => ({
                version: 1,
                call_id: call.callId,
                party_id: 'party_id',
                selected_party_id: "different_party_id",
            }),
        });

        expect(callHangupCallback).toHaveBeenCalled();
    });

    describe("turn servers", () => {
        it("should fallback if allowed", async () => {
            client.client.isFallbackICEServerAllowed = () => true;
            const localCall = new MatrixCall({
                client: client.client,
                roomId: '!room_id',
            });

            expect((localCall as any).turnServers).toStrictEqual([{ urls: ["stun:turn.matrix.org"] }]);
        });

        it("should not fallback if not allowed", async () => {
            client.client.isFallbackICEServerAllowed = () => false;
            const localCall = new MatrixCall({
                client: client.client,
                roomId: '!room_id',
            });

            expect((localCall as any).turnServers).toStrictEqual([]);
        });

        it("should not fallback if we supplied turn servers", async () => {
            client.client.isFallbackICEServerAllowed = () => true;
            const turnServers = [{ urls: ["turn.server.org"] }];
            const localCall = new MatrixCall({
                client: client.client,
                roomId: '!room_id',
                turnServers,
            });

            expect((localCall as any).turnServers).toStrictEqual(turnServers);
        });
    });

    it("should handle creating a data channel", async () => {
        await startVoiceCall(client, call);

        const dataChannelCallback = jest.fn();
        call.on(CallEvent.DataChannel, dataChannelCallback);

        const dataChannel = call.createDataChannel("data_channel_label", { id: 123 });

        expect(dataChannelCallback).toHaveBeenCalledWith(dataChannel);
        expect(dataChannel.label).toBe("data_channel_label");
        expect(dataChannel.id).toBe(123);
    });

    describe("supportsMatrixCall", () => {
        it("should return true when the environment is right", () => {
            expect(supportsMatrixCall()).toBe(true);
        });

        it("should return false if window or document are undefined", () => {
            global.window = undefined;
            expect(supportsMatrixCall()).toBe(false);
            global.window = prevWindow;
            global.document = undefined;
            expect(supportsMatrixCall()).toBe(false);
        });

        it("should return false if RTCPeerConnection throws", () => {
            // @ts-ignore - writing to window as we are simulating browser edge-cases
            global.window = {};
            Object.defineProperty(global.window, "RTCPeerConnection", {
                get: () => {
                    throw Error("Secure mode, naaah!");
                },
            });
            expect(supportsMatrixCall()).toBe(false);
        });

        it("should return false if RTCPeerConnection & RTCSessionDescription " +
            "& RTCIceCandidate & mediaDevices are unavailable",
        () => {
            global.window.RTCPeerConnection = undefined;
            global.window.RTCSessionDescription = undefined;
            global.window.RTCIceCandidate = undefined;
            // @ts-ignore - writing to a read-only property as we are simulating faulty browsers
            global.navigator.mediaDevices = undefined;
            expect(supportsMatrixCall()).toBe(false);
        });
    });

    describe("ignoring streams with ids for which we already have a feed", () => {
        const STREAM_ID = "stream_id";
        const FEEDS_CHANGED_CALLBACK = jest.fn();

        beforeEach(async () => {
            await startVoiceCall(client, call);
            call.on(CallEvent.FeedsChanged, FEEDS_CHANGED_CALLBACK);
            jest.spyOn(call, "pushLocalFeed");
        });

        afterEach(() => {
            FEEDS_CHANGED_CALLBACK.mockReset();
        });

        it("should ignore stream passed to pushRemoteFeed()", async () => {
            await call.onAnswerReceived({
                getContent: () => {
                    return {
                        version: 1,
                        call_id: call.callId,
                        party_id: 'party_id',
                        answer: {
                            sdp: DUMMY_SDP,
                        },
                        [SDPStreamMetadataKey]: {
                            [STREAM_ID]: {
                                purpose: SDPStreamMetadataPurpose.Usermedia,
                            },
                        },
                    };
                },
                getSender: () => "@test:foo",
            });

            call.pushRemoteFeed(new MockMediaStream(STREAM_ID));
            call.pushRemoteFeed(new MockMediaStream(STREAM_ID));

            expect(call.getRemoteFeeds().length).toBe(1);
            expect(FEEDS_CHANGED_CALLBACK).toHaveBeenCalledTimes(1);
        });

        it("should ignore stream passed to pushRemoteFeedWithoutMetadata()", async () => {
            call.pushRemoteFeedWithoutMetadata(new MockMediaStream(STREAM_ID));
            call.pushRemoteFeedWithoutMetadata(new MockMediaStream(STREAM_ID));

            expect(call.getRemoteFeeds().length).toBe(1);
            expect(FEEDS_CHANGED_CALLBACK).toHaveBeenCalledTimes(1);
        });

        it("should ignore stream passed to pushNewLocalFeed()", async () => {
            call.pushNewLocalFeed(new MockMediaStream(STREAM_ID), SDPStreamMetadataPurpose.Screenshare);
            call.pushNewLocalFeed(new MockMediaStream(STREAM_ID), SDPStreamMetadataPurpose.Screenshare);

            // We already have one local feed from placeVoiceCall()
            expect(call.getLocalFeeds().length).toBe(2);
            expect(FEEDS_CHANGED_CALLBACK).toHaveBeenCalledTimes(1);
            expect(call.pushLocalFeed).toHaveBeenCalled();
        });
    });

    describe("muting", () => {
        beforeEach(async () => {
            call.sendVoipEvent = jest.fn();
            await startVideoCall(client, call);
        });

        describe("sending sdp_stream_metadata_changed events", () => {
            it("should send sdp_stream_metadata_changed when muting audio", async () => {
                await call.setMicrophoneMuted(true);
                expect(call.sendVoipEvent).toHaveBeenCalledWith(EventType.CallSDPStreamMetadataChangedPrefix, {
                    [SDPStreamMetadataKey]: {
                        mock_stream_from_media_handler: {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            audio_muted: true,
                            video_muted: false,
                        },
                    },
                });
            });

            it("should send sdp_stream_metadata_changed when muting video", async () => {
                await call.setLocalVideoMuted(true);
                expect(call.sendVoipEvent).toHaveBeenCalledWith(EventType.CallSDPStreamMetadataChangedPrefix, {
                    [SDPStreamMetadataKey]: {
                        mock_stream_from_media_handler: {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            audio_muted: false,
                            video_muted: true,
                        },
                    },
                });
            });
        });

        describe("receiving sdp_stream_metadata_changed events", () => {
            const setupCall = (audio: boolean, video: boolean): SDPStreamMetadata => {
                const metadata = {
                    stream: {
                        purpose: SDPStreamMetadataPurpose.Usermedia,
                        audio_muted: audio,
                        video_muted: video,
                    },
                };
                call.pushRemoteFeed(new MockMediaStream("stream", [
                    new MockMediaStreamTrack("track1", "audio"),
                    new MockMediaStreamTrack("track1", "video"),
                ]));
                call.onSDPStreamMetadataChangedReceived({
                    getContent: () => ({
                        [SDPStreamMetadataKey]: metadata,
                    }),
                });
                return metadata;
            };

            it("should handle incoming sdp_stream_metadata_changed with audio muted", async () => {
                const metadata = setupCall(true, false);
                expect(call.remoteSDPStreamMetadata).toStrictEqual(metadata);
                expect(call.getRemoteFeeds()[0].isAudioMuted()).toBe(true);
                expect(call.getRemoteFeeds()[0].isVideoMuted()).toBe(false);
            });

            it("should handle incoming sdp_stream_metadata_changed with video muted", async () => {
                const metadata = setupCall(false, true);
                expect(call.remoteSDPStreamMetadata).toStrictEqual(metadata);
                expect(call.getRemoteFeeds()[0].isAudioMuted()).toBe(false);
                expect(call.getRemoteFeeds()[0].isVideoMuted()).toBe(true);
            });
        });
    });

    describe("rejecting calls", () => {
        it("sends hangup event when rejecting v0 calls", async () => {
            await fakeIncomingCall(client, call, 0);

            call.reject();

            expect(client.client.sendEvent).toHaveBeenCalledWith(
                FAKE_ROOM_ID,
                EventType.CallHangup,
                expect.objectContaining({
                    call_id: call.callId,
                }),
            );
        });

        it("sends reject event when rejecting v1 calls", async () => {
            await fakeIncomingCall(client, call, "1");

            call.reject();

            expect(client.client.sendEvent).toHaveBeenCalledWith(
                FAKE_ROOM_ID,
                EventType.CallReject,
                expect.objectContaining({
                    call_id: call.callId,
                }),
            );
        });

        it("does not reject a call that has already been answered", async () => {
            await fakeIncomingCall(client, call, "1");

            await call.answer();

            client.client.sendEvent.mockReset();

            let caught = false;
            try {
                call.reject();
            } catch (e) {
                caught = true;
            }

            expect(caught).toEqual(true);
            expect(client.client.sendEvent).not.toHaveBeenCalled();

            call.hangup();
        });

        it("hangs up a call", async () => {
            await fakeIncomingCall(client, call, "1");

            await call.answer();

            client.client.sendEvent.mockReset();

            call.hangup();

            expect(client.client.sendEvent).toHaveBeenCalledWith(
                FAKE_ROOM_ID,
                EventType.CallHangup,
                expect.objectContaining({
                    call_id: call.callId,
                }),
            );
        });
    });

    it("times out an incoming call", async () => {
        jest.useFakeTimers();
        await fakeIncomingCall(client, call, "1");

        expect(call.state).toEqual(CallState.Ringing);

        jest.advanceTimersByTime(CALL_LIFETIME + 1000);

        expect(call.state).toEqual(CallState.Ended);
    });

    describe("Screen sharing", () => {
        beforeEach(async () => {
            await startVoiceCall(client, call);

            await call.onAnswerReceived({
                getContent: () => {
                    return {
                        "version": 1,
                        "call_id": call.callId,
                        "party_id": 'party_id',
                        "answer": {
                            sdp: DUMMY_SDP,
                        },
                        "org.matrix.msc3077.sdp_stream_metadata": {
                            "foo": {
                                "purpose": "m.usermedia",
                                "audio_muted": false,
                                "video_muted": false,
                            },
                        },
                    };
                },
                getSender: () => "@test:foo",
            });
        });

        afterEach(() => {
            // Hangup to stop timers
            call.hangup(CallErrorCode.UserHangup, true);
        });

        it("enables screensharing", async () => {
            await call.setScreensharingEnabled(true);

            expect(call.feeds.filter(f => f.purpose == SDPStreamMetadataPurpose.Screenshare).length).toEqual(1);

            client.client.sendEvent.mockReset();
            const sendNegotiatePromise = new Promise<void>(resolve => {
                client.client.sendEvent.mockImplementation(() => {
                    resolve();
                });
            });

            MockRTCPeerConnection.triggerAllNegotiations();
            await sendNegotiatePromise;

            expect(client.client.sendEvent).toHaveBeenCalledWith(
                FAKE_ROOM_ID,
                EventType.CallNegotiate,
                expect.objectContaining({
                    "version": "1",
                    "call_id": call.callId,
                    "org.matrix.msc3077.sdp_stream_metadata": expect.objectContaining({
                        [SCREENSHARE_STREAM_ID]: expect.objectContaining({
                            purpose: SDPStreamMetadataPurpose.Screenshare,
                        }),
                    }),
                }),
            );
        });

        it("disables screensharing", async () => {
            await call.setScreensharingEnabled(true);

            client.client.sendEvent.mockReset();
            const sendNegotiatePromise = new Promise<void>(resolve => {
                client.client.sendEvent.mockImplementation(() => {
                    resolve();
                });
            });

            MockRTCPeerConnection.triggerAllNegotiations();
            await sendNegotiatePromise;

            await call.setScreensharingEnabled(false);

            expect(call.feeds.filter(f => f.purpose == SDPStreamMetadataPurpose.Screenshare).length).toEqual(0);
        });
    });
});
