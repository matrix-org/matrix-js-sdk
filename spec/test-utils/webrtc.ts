/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import {
    ClientEvent,
    ClientEventHandlerMap,
    EventType,
    GroupCall,
    GroupCallIntent,
    GroupCallType,
    IContent,
    ISendEventResponse,
    MatrixClient,
    MatrixEvent,
    Room,
    RoomState,
    RoomStateEvent,
    RoomStateEventHandlerMap,
} from "../../src";
import { TypedEventEmitter } from "../../src/models/typed-event-emitter";
import { ReEmitter } from "../../src/ReEmitter";
import { SyncState } from "../../src/sync";
import { CallEvent, CallEventHandlerMap, MatrixCall } from "../../src/webrtc/call";
import { CallEventHandlerEvent, CallEventHandlerEventHandlerMap } from "../../src/webrtc/callEventHandler";
import { CallFeed } from "../../src/webrtc/callFeed";
import { GroupCallEventHandlerMap } from "../../src/webrtc/groupCall";
import { GroupCallEventHandlerEvent } from "../../src/webrtc/groupCallEventHandler";
import { IScreensharingOpts, MediaHandler } from "../../src/webrtc/mediaHandler";

export const DUMMY_SDP = (
    "v=0\r\n" +
    "o=- 5022425983810148698 2 IN IP4 127.0.0.1\r\n" +
    "s=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n" +
    "a=msid-semantic: WMS h3wAi7s8QpiQMH14WG3BnDbmlOqo9I5ezGZA\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 103 104 9 0 8 106 105 13 110 112 113 126\r\n" +
    "c=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:hLDR\r\n" +
    "a=ice-pwd:bMGD9aOldHWiI+6nAq/IIlRw\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 E4:94:84:F9:4A:98:8A:56:F5:5F:FD:AF:72:B9:32:89:49:5C:4B:9A:" +
    "4A:15:8E:41:8A:F3:69:E4:39:52:DC:D6\r\n" +
    "a=setup:active\r\n" +
    "a=mid:0\r\n" +
    "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n" +
    "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n" +
    "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\n" +
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid\r\n" +
    "a=extmap:5 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r\n" +
    "a=extmap:6 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id\r\n" +
    "a=sendrecv\r\n" +
    "a=msid:h3wAi7s8QpiQMH14WG3BnDbmlOqo9I5ezGZA 4357098f-3795-4131-bff4-9ba9c0348c49\r\n" +
    "a=rtcp-mux\r\n" +
    "a=rtpmap:111 opus/48000/2\r\n" +
    "a=rtcp-fb:111 transport-cc\r\n" +
    "a=fmtp:111 minptime=10;useinbandfec=1\r\n" +
    "a=rtpmap:103 ISAC/16000\r\n" +
    "a=rtpmap:104 ISAC/32000\r\n" +
    "a=rtpmap:9 G722/8000\r\n" +
    "a=rtpmap:0 PCMU/8000\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n" +
    "a=rtpmap:106 CN/32000\r\n" +
    "a=rtpmap:105 CN/16000\r\n" +
    "a=rtpmap:13 CN/8000\r\n" +
    "a=rtpmap:110 telephone-event/48000\r\n" +
    "a=rtpmap:112 telephone-event/32000\r\n" +
    "a=rtpmap:113 telephone-event/16000\r\n" +
    "a=rtpmap:126 telephone-event/8000\r\n" +
    "a=ssrc:3619738545 cname:2RWtmqhXLdoF4sOi\r\n"
);

export const USERMEDIA_STREAM_ID = "mock_stream_from_media_handler";
export const SCREENSHARE_STREAM_ID = "mock_screen_stream_from_media_handler";

class MockMediaStreamAudioSourceNode {
    connect() {}
}

class MockAnalyser {
    getFloatFrequencyData() { return 0.0; }
}

export class MockAudioContext {
    constructor() {}
    createAnalyser() { return new MockAnalyser(); }
    createMediaStreamSource() { return new MockMediaStreamAudioSourceNode(); }
    close() {}
}

export class MockRTCPeerConnection {
    private static instances: MockRTCPeerConnection[] = [];

    private negotiationNeededListener: () => void;
    public iceCandidateListener?: (e: RTCPeerConnectionIceEvent) => void;
    public onTrackListener?: (e: RTCTrackEvent) => void;
    public needsNegotiation = false;
    public readyToNegotiate: Promise<void>;
    private onReadyToNegotiate: () => void;
    localDescription: RTCSessionDescription;
    signalingState: RTCSignalingState = "stable";
    public transceivers: MockRTCRtpTransceiver[] = [];

    public static triggerAllNegotiations(): void {
        for (const inst of this.instances) {
            inst.doNegotiation();
        }
    }

    public static hasAnyPendingNegotiations(): boolean {
        return this.instances.some(i => i.needsNegotiation);
    }

    public static resetInstances() {
        this.instances = [];
    }

    constructor() {
        this.localDescription = {
            sdp: DUMMY_SDP,
            type: 'offer',
            toJSON: function() { },
        };

        this.readyToNegotiate = new Promise<void>(resolve => {
            this.onReadyToNegotiate = resolve;
        });

        MockRTCPeerConnection.instances.push(this);
    }

    addEventListener(type: string, listener: () => void) {
        if (type === 'negotiationneeded') {
            this.negotiationNeededListener = listener;
        } else if (type == 'icecandidate') {
            this.iceCandidateListener = listener;
        } else if (type == 'track') {
            this.onTrackListener = listener;
        }
    }
    createDataChannel(label: string, opts: RTCDataChannelInit) { return { label, ...opts }; }
    createOffer() {
        return Promise.resolve({
            type: 'offer',
            sdp: DUMMY_SDP,
        });
    }
    createAnswer() {
        return Promise.resolve({
            type: 'answer',
            sdp: DUMMY_SDP,
        });
    }
    setRemoteDescription() {
        return Promise.resolve();
    }
    setLocalDescription() {
        return Promise.resolve();
    }
    close() { }
    getStats() { return []; }
    addTransceiver(track: MockMediaStreamTrack): MockRTCRtpTransceiver {
        this.needsNegotiation = true;
        this.onReadyToNegotiate();

        const newSender = new MockRTCRtpSender(track);
        const newReceiver = new MockRTCRtpReceiver(track);

        const newTransceiver = new MockRTCRtpTransceiver(this);
        newTransceiver.sender = newSender as unknown as RTCRtpSender;
        newTransceiver.receiver = newReceiver as unknown as RTCRtpReceiver;

        this.transceivers.push(newTransceiver);

        return newTransceiver;
    }
    addTrack(track: MockMediaStreamTrack): MockRTCRtpSender {
        return this.addTransceiver(track).sender as unknown as MockRTCRtpSender;
    }

    removeTrack() {
        this.needsNegotiation = true;
        this.onReadyToNegotiate();
    }

    getTransceivers(): MockRTCRtpTransceiver[] { return this.transceivers; }
    getSenders(): MockRTCRtpSender[] { return this.transceivers.map(t => t.sender as unknown as MockRTCRtpSender); }

    doNegotiation() {
        if (this.needsNegotiation && this.negotiationNeededListener) {
            this.needsNegotiation = false;
            this.negotiationNeededListener();
        }
    }
}

export class MockRTCRtpSender {
    constructor(public track: MockMediaStreamTrack) { }

    replaceTrack(track: MockMediaStreamTrack) { this.track = track; }
}

export class MockRTCRtpReceiver {
    constructor(public track: MockMediaStreamTrack) { }
}

export class MockRTCRtpTransceiver {
    constructor(private peerConn: MockRTCPeerConnection) {}

    public sender: RTCRtpSender;
    public receiver: RTCRtpReceiver;

    public set direction(_: string) {
        this.peerConn.needsNegotiation = true;
    }

    setCodecPreferences = jest.fn<void, RTCRtpCodecCapability[]>();
}

export class MockMediaStreamTrack {
    constructor(public readonly id: string, public readonly kind: "audio" | "video", public enabled = true) { }

    stop = jest.fn<void, []>();

    listeners: [string, (...args: any[]) => any][] = [];
    public isStopped = false;
    public settings: MediaTrackSettings;

    getSettings(): MediaTrackSettings { return this.settings; }

    // XXX: Using EventTarget in jest doesn't seem to work, so we write our own
    // implementation
    dispatchEvent(eventType: string) {
        this.listeners.forEach(([t, c]) => {
            if (t !== eventType) return;
            c();
        });
    }
    addEventListener(eventType: string, callback: (...args: any[]) => any) {
        this.listeners.push([eventType, callback]);
    }
    removeEventListener(eventType: string, callback: (...args: any[]) => any) {
        this.listeners.filter(([t, c]) => {
            return t !== eventType || c !== callback;
        });
    }

    typed(): MediaStreamTrack { return this as unknown as MediaStreamTrack; }
}

// XXX: Using EventTarget in jest doesn't seem to work, so we write our own
// implementation
export class MockMediaStream {
    constructor(
        public id: string,
        private tracks: MockMediaStreamTrack[] = [],
    ) {}

    listeners: [string, (...args: any[]) => any][] = [];
    public isStopped = false;

    dispatchEvent(eventType: string) {
        this.listeners.forEach(([t, c]) => {
            if (t !== eventType) return;
            c();
        });
    }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    addEventListener(eventType: string, callback: (...args: any[]) => any) {
        this.listeners.push([eventType, callback]);
    }
    removeEventListener(eventType: string, callback: (...args: any[]) => any) {
        this.listeners.filter(([t, c]) => {
            return t !== eventType || c !== callback;
        });
    }
    addTrack(track: MockMediaStreamTrack) {
        this.tracks.push(track);
        this.dispatchEvent("addtrack");
    }
    removeTrack(track: MockMediaStreamTrack) { this.tracks.splice(this.tracks.indexOf(track), 1); }

    clone(): MediaStream {
        return new MockMediaStream(this.id + ".clone", this.tracks).typed();
    }

    isCloneOf(stream: MediaStream) {
        return this.id === stream.id + ".clone";
    }

    // syntactic sugar for typing
    typed(): MediaStream {
        return this as unknown as MediaStream;
    }
}

export class MockMediaDeviceInfo {
    constructor(
        public kind: "audioinput" | "videoinput" | "audiooutput",
    ) { }

    typed(): MediaDeviceInfo { return this as unknown as MediaDeviceInfo; }
}

export class MockMediaHandler {
    public userMediaStreams: MockMediaStream[] = [];
    public screensharingStreams: MockMediaStream[] = [];

    getUserMediaStream(audio: boolean, video: boolean) {
        const tracks: MockMediaStreamTrack[] = [];
        if (audio) tracks.push(new MockMediaStreamTrack("usermedia_audio_track", "audio"));
        if (video) tracks.push(new MockMediaStreamTrack("usermedia_video_track", "video"));

        const stream = new MockMediaStream(USERMEDIA_STREAM_ID, tracks);
        this.userMediaStreams.push(stream);
        return stream;
    }
    stopUserMediaStream(stream: MockMediaStream) {
        stream.isStopped = true;
    }
    getScreensharingStream = jest.fn((opts?: IScreensharingOpts) => {
        const tracks = [new MockMediaStreamTrack("screenshare_video_track", "video")];
        if (opts?.audio) tracks.push(new MockMediaStreamTrack("screenshare_audio_track", "audio"));

        const stream = new MockMediaStream(SCREENSHARE_STREAM_ID, tracks);
        this.screensharingStreams.push(stream);
        return stream;
    });
    stopScreensharingStream(stream: MockMediaStream) {
        stream.isStopped = true;
    }
    hasAudioDevice() { return true; }
    hasVideoDevice() { return true; }
    stopAllStreams() {}

    typed(): MediaHandler { return this as unknown as MediaHandler; }
}

export class MockMediaDevices {
    enumerateDevices = jest.fn<Promise<MediaDeviceInfo[]>, []>().mockResolvedValue([
        new MockMediaDeviceInfo("audioinput").typed(),
        new MockMediaDeviceInfo("videoinput").typed(),
    ]);

    getUserMedia = jest.fn<Promise<MediaStream>, [MediaStreamConstraints]>().mockReturnValue(
        Promise.resolve(new MockMediaStream("local_stream").typed()),
    );

    getDisplayMedia = jest.fn<Promise<MediaStream>, [DisplayMediaStreamConstraints]>().mockReturnValue(
        Promise.resolve(new MockMediaStream("local_display_stream").typed()),
    );

    typed(): MediaDevices { return this as unknown as MediaDevices; }
}

type EmittedEvents = CallEventHandlerEvent | CallEvent | ClientEvent | RoomStateEvent | GroupCallEventHandlerEvent;
type EmittedEventMap = CallEventHandlerEventHandlerMap &
    CallEventHandlerMap &
    ClientEventHandlerMap &
    RoomStateEventHandlerMap &
    GroupCallEventHandlerMap;

export class MockCallMatrixClient extends TypedEventEmitter<EmittedEvents, EmittedEventMap> {
    public mediaHandler = new MockMediaHandler();

    constructor(public userId: string, public deviceId: string, public sessionId: string) {
        super();
    }

    groupCallEventHandler = {
        groupCalls: new Map<string, GroupCall>(),
    };

    callEventHandler = {
        calls: new Map<string, MatrixCall>(),
    };

    sendStateEvent = jest.fn<Promise<ISendEventResponse>, [
        roomId: string, eventType: EventType, content: any, statekey: string,
    ]>();
    sendToDevice = jest.fn<Promise<{}>, [
        eventType: string,
        contentMap: { [userId: string]: { [deviceId: string]: Record<string, any> } },
        txnId?: string,
    ]>();

    getMediaHandler(): MediaHandler { return this.mediaHandler.typed(); }

    getUserId(): string { return this.userId; }

    getDeviceId(): string { return this.deviceId; }
    getSessionId(): string { return this.sessionId; }

    getTurnServers = () => [];
    isFallbackICEServerAllowed = () => false;
    reEmitter = new ReEmitter(new TypedEventEmitter());
    getUseE2eForGroupCall = () => false;
    checkTurnServers = () => null;

    getSyncState = jest.fn<SyncState, []>().mockReturnValue(SyncState.Syncing);

    getRooms = jest.fn<Room[], []>().mockReturnValue([]);
    getRoom = jest.fn();

    typed(): MatrixClient { return this as unknown as MatrixClient; }

    emitRoomState(event: MatrixEvent, state: RoomState): void {
        this.emit(
            RoomStateEvent.Events,
            event,
            state,
            null,
        );
    }
}

export class MockCallFeed {
    constructor(
        public userId: string,
        public stream: MockMediaStream,
    ) {}

    measureVolumeActivity(val: boolean) {}
    dispose() {}

    typed(): CallFeed {
        return this as unknown as CallFeed;
    }
}

export function installWebRTCMocks() {
    global.navigator = {
        mediaDevices: new MockMediaDevices().typed(),
    } as unknown as Navigator;

    global.window = {
        // @ts-ignore Mock
        RTCPeerConnection: MockRTCPeerConnection,
        // @ts-ignore Mock
        RTCSessionDescription: {},
        // @ts-ignore Mock
        RTCIceCandidate: {},
        getUserMedia: () => new MockMediaStream("local_stream"),
    };
    // @ts-ignore Mock
    global.document = {};

    // @ts-ignore Mock
    global.AudioContext = MockAudioContext;

    // @ts-ignore Mock
    global.RTCRtpReceiver = {
        getCapabilities: jest.fn<RTCRtpCapabilities, [string]>().mockReturnValue({
            codecs: [],
            headerExtensions: [],
        }),
    };

    // @ts-ignore Mock
    global.RTCRtpSender = {
        getCapabilities: jest.fn<RTCRtpCapabilities, [string]>().mockReturnValue({
            codecs: [],
            headerExtensions: [],
        }),
    };
}

export function makeMockGroupCallStateEvent(roomId: string, groupCallId: string, content: IContent = {
    "m.type": GroupCallType.Video,
    "m.intent": GroupCallIntent.Prompt,
}): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallPrefix),
        getRoomId: jest.fn().mockReturnValue(roomId),
        getTs: jest.fn().mockReturnValue(0),
        getContent: jest.fn().mockReturnValue(content),
        getStateKey: jest.fn().mockReturnValue(groupCallId),
    } as unknown as MatrixEvent;
}

export function makeMockGroupCallMemberStateEvent(roomId: string, groupCallId: string): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
        getRoomId: jest.fn().mockReturnValue(roomId),
        getTs: jest.fn().mockReturnValue(0),
        getContent: jest.fn().mockReturnValue({}),
        getStateKey: jest.fn().mockReturnValue(groupCallId),
    } as unknown as MatrixEvent;
}
