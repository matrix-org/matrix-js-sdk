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

export class MockRTCPeerConnection {
    localDescription: RTCSessionDescription;

    constructor() {
        this.localDescription = {
            sdp: DUMMY_SDP,
            type: 'offer',
            toJSON: function() { },
        };
    }

    addEventListener() { }
    createDataChannel(label: string, opts: RTCDataChannelInit) { return { label, ...opts }; }
    createOffer() {
        return Promise.resolve({});
    }
    setRemoteDescription() {
        return Promise.resolve();
    }
    setLocalDescription() {
        return Promise.resolve();
    }
    close() { }
    getStats() { return []; }
    addTrack(track: MockMediaStreamTrack) { return new MockRTCRtpSender(track); }
}

export class MockRTCRtpSender {
    constructor(public track: MockMediaStreamTrack) { }

    replaceTrack(track: MockMediaStreamTrack) { this.track = track; }
}

export class MockMediaStreamTrack {
    constructor(public readonly id: string, public readonly kind: "audio" | "video", public enabled = true) { }

    stop() { }
}

// XXX: Using EventTarget in jest doesn't seem to work, so we write our own
// implementation
export class MockMediaStream {
    constructor(
        public id: string,
        private tracks: MockMediaStreamTrack[] = [],
    ) {}

    listeners: [string, (...args: any[]) => any][] = [];

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
}

export class MockMediaDeviceInfo {
    constructor(
        public kind: "audio" | "video",
    ) { }
}

export class MockMediaHandler {
    getUserMediaStream(audio: boolean, video: boolean) {
        const tracks = [];
        if (audio) tracks.push(new MockMediaStreamTrack("audio_track", "audio"));
        if (video) tracks.push(new MockMediaStreamTrack("video_track", "video"));

        return new MockMediaStream("mock_stream_from_media_handler", tracks);
    }
    stopUserMediaStream() { }
    hasAudioDevice() { return true; }
}
