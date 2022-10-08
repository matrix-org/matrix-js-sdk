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
                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                feed.setVoiceActivityThreshold(Infinity);

                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 1000);
            });

            it("voice activity should enable audio track", () => {
                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set threshold to infinity, this ensures we hit the threshold.
                //then we check if the user is unmuted.
                feed.setVoiceActivityThreshold(-Infinity);
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 1000);
            });

            it("enables track when volume is above threshold", () => {
                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set the threshold and the samples to ensure the user is unmuted at the start.
                feed.setVoiceActivityThreshold(-80);
                feed.speakingVolumeSamples = [-60];

                //user has -40db which is louder than -50db, so the user should be unmuted.
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 1000);
            });

            it("disables track when volume is below threshold", () => {
                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set the threshold and the samples to ensure the user is muted at the start.
                feed.setVoiceActivityThreshold(-80);
                feed.speakingVolumeSamples = [-90];

                //the user is too quiet, user should be muted.
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 1000);
            });

            it("voice activity should not disable audio track after a few milliseconds", async () => {
                // Someone speaks
                // Stops speaking for a few milliseconds
                // -> Is not muted before cooldown -> (VAD_COOLDOWN)

                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set the threshold and the samples to ensure the user is unmuted at the start.
                feed.setVoiceActivityThreshold(-80);
                feed.speakingVolumeSamples = [-60];

                //pretend the user is silent after 100ms
                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                //the user should still be unmuted after another 50ms.
                //Cooldown is 200ms, so this is within the range.
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 150);
            });

            it("voice activity should disable audio track after cooldown", async () => {
                // Someone speaks
                // Stops speaking
                // -> Is muted after cooldown -> (VAD_COOLDOWN)

                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set the threshold and the samples to ensure the user is unmuted at the start.
                feed.setVoiceActivityThreshold(-80);
                feed.speakingVolumeSamples = [-60];

                //pretend the user is silent after 100ms
                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                //The user should be muted after another 210ms.
                //200ms is the cooldown, so we are outside of that range.
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(false);
                }, 310);
            });

            it("voice activity cooldown should be reset when speaking", async () => {
                // Cooldown is reset after speaking again

                //@ts-ignore Mock
                feed.stream.addTrack(new MockMediaStreamTrack("track", "audio", true));

                //set the threshold and the samples to ensure the user is unmuted at the start.
                feed.setVoiceActivityThreshold(-80);
                feed.speakingVolumeSamples = [-60];

                //pretend the user is silent after 100ms
                setTimeout(() => {
                    feed.speakingVolumeSamples = [-Infinity];
                }, 100);

                //pretend the user starts speaking again after another 100ms
                setTimeout(() => {
                    feed.speakingVolumeSamples = [-60];
                }, 200);

                //after yet another 100ms check if the user is still unmuted.
                setTimeout(() => {
                    expect(feed.stream.getAudioTracks()[0].enabled).toBe(true);
                }, 310);
            });
        });
    });
});
