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

import { SDPStreamMetadataPurpose } from "../../../src/webrtc/callEventTypes";
import { CallFeed } from "../../../src/webrtc/callFeed";
import { TestClient } from "../../TestClient";
import { MockMediaStream, MockMediaStreamTrack } from "../../test-utils/webrtc";

describe("CallFeed", () => {
    let client;

    beforeEach(() => {
        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {});
    });

    afterEach(() => {
        client.stop();
    });

    describe("muting", () => {
        let feed: CallFeed;

        beforeEach(() => {
            feed = new CallFeed({
                client,
                roomId: "room1",
                userId: "user1",
                // @ts-ignore Mock
                stream: new MockMediaStream("stream1"),
                purpose: SDPStreamMetadataPurpose.Usermedia,
                audioMuted: false,
                videoMuted: false,
            });
        });

        describe("should by muted by default", () => {
            it("audio", () => {
                expect(feed.isAudioMuted()).toBeTruthy();
            });

            it("video", () => {
                expect(feed.isVideoMuted()).toBeTruthy();
            });
        });

        describe("should not be muted after adding track", () => {
            it("audio", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));
                expect(feed.isAudioMuted()).toBeFalsy();
            });

            it("video", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "video", true));
                expect(feed.isVideoMuted()).toBeFalsy();
            });
        });

        describe("should be muted after calling setAudioVideoMuted()", () => {
            it("audio ", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));
                feed.setAudioVideoMuted(true, false);
                expect(feed.isAudioMuted()).toBeTruthy();
            });

            it("video", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "video", true));
                feed.setAudioVideoMuted(false, true);
                expect(feed.isVideoMuted()).toBeTruthy();
            });
        });
    });
});
