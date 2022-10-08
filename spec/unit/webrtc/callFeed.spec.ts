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

        describe("muting by default", () => {
            it("should mute audio by default", () => {
                expect(feed.isAudioMuted()).toBeTruthy();
            });

            it("should mute video by default", () => {
                expect(feed.isVideoMuted()).toBeTruthy();
            });
        });

        describe("muting after adding a track", () => {
            it("should un-mute audio", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));
                expect(feed.isAudioMuted()).toBeFalsy();
            });

            it("should un-mute video", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "video", true));
                expect(feed.isVideoMuted()).toBeFalsy();
            });
        });

        describe("muting after calling setAudioVideoMuted()", () => {
            it("should mute audio by default ", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));
                feed.setAudioVideoMuted(true, false);
                expect(feed.isAudioMuted()).toBeTruthy();
            });

            it("should mute video by default", () => {
                // @ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "video", true));
                feed.setAudioVideoMuted(false, true);
                expect(feed.isVideoMuted()).toBeTruthy();
            });
        });

        describe("voice activity detection", () => {
            it("voice activity should disable audio track", () => {
                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(Infinity);

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 1000);
            });

            it("voice activity should enable audio track", () => {
                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-Infinity);
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 1000);
            });

            it("enables track when volume is above threshold", () => {
                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-50);
                feed.speakingVolumeSamples = [-40];

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 1000);
            });

            it("voice activity should disable audio track", () => {
                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-50);
                feed.speakingVolumeSamples = [-60];

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 1000);
            });

            it("voice activity should not disable audio track after a few milliseconds", async () => {
                // Someone speaking
                // Stops speaking for a few milliseconds
                // Starts speaking again
                // -> Is not muted in between (VAD_COOLDOWN)

                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-50);
                feed.speakingVolumeSamples = [-60];

                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 150);
            });

            it("voice activity should disable audio track after cooldown", async () => {
                // Someone speaking
                // Stops speaking
                // -> Is muted after some time (VAD_COOLDOWN)

                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-50);
                feed.speakingVolumeSamples = [-60];

                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 310);
            });

            it("voice activity cooldown should be reset when speaking", async () => {
                // Cooldown is reseted after speaking again

                feed.stream.addTrack(
                    //@ts-ignore Mock
                    new MockMediaStreamTrack("track", "audio", true),
                );

                feed.setVoiceActivityThreshold(-50);
                feed.speakingVolumeSamples = [-60];

                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                setTimeout(() => {
                    feed.speakingVolumeSamples = [-50];
                }, 200);

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 310);
            });
        });
    });
});
