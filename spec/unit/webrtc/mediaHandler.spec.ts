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

import { GroupCall, MatrixCall, MatrixClient } from "../../../src";
import { MediaHandler, MediaHandlerEvent } from "../../../src/webrtc/mediaHandler";
import { MockMediaDeviceInfo, MockMediaDevices, MockMediaStream, MockMediaStreamTrack } from "../../test-utils/webrtc";

const FAKE_AUDIO_INPUT_ID = "aaaaaaaa";
const FAKE_VIDEO_INPUT_ID = "vvvvvvvv";

describe('Media Handler', function() {
    let mockMediaDevices: MockMediaDevices;
    let mediaHandler: MediaHandler;
    let calls: Map<string, MatrixCall>;
    let groupCalls: Map<string, GroupCall>;

    beforeEach(() => {
        mockMediaDevices = new MockMediaDevices();

        global.navigator = {
            mediaDevices: mockMediaDevices.typed(),
        } as unknown as Navigator;

        calls = new Map();
        groupCalls = new Map();

        mediaHandler = new MediaHandler({
            callEventHandler: {
                calls,
            },
            groupCallEventHandler: {
                groupCalls,
            },
        } as unknown as MatrixClient);
    });

    it("does not trigger update after restore media settings ", () => {
        mediaHandler.restoreMediaSettings(FAKE_AUDIO_INPUT_ID, FAKE_VIDEO_INPUT_ID);

        expect(mockMediaDevices.getUserMedia).not.toHaveBeenCalled();
    });

    it("sets device IDs on restore media settings", async () => {
        mediaHandler.restoreMediaSettings(FAKE_AUDIO_INPUT_ID, FAKE_VIDEO_INPUT_ID);

        await mediaHandler.getUserMediaStream(true, true);
        expect(mockMediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
            audio: expect.objectContaining({
                deviceId: { ideal: FAKE_AUDIO_INPUT_ID },
            }),
            video: expect.objectContaining({
                deviceId: { ideal: FAKE_VIDEO_INPUT_ID },
            }),
        }));
    });

    it("sets audio device ID", async () => {
        await mediaHandler.setAudioInput(FAKE_AUDIO_INPUT_ID);

        await mediaHandler.getUserMediaStream(true, false);
        expect(mockMediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
            audio: expect.objectContaining({
                deviceId: { ideal: FAKE_AUDIO_INPUT_ID },
            }),
        }));
    });

    it("sets video device ID", async () => {
        await mediaHandler.setVideoInput(FAKE_VIDEO_INPUT_ID);

        await mediaHandler.getUserMediaStream(false, true);
        expect(mockMediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
            video: expect.objectContaining({
                deviceId: { ideal: FAKE_VIDEO_INPUT_ID },
            }),
        }));
    });

    it("sets media inputs", async () => {
        await mediaHandler.setMediaInputs(FAKE_AUDIO_INPUT_ID, FAKE_VIDEO_INPUT_ID);

        await mediaHandler.getUserMediaStream(true, true);
        expect(mockMediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
            audio: expect.objectContaining({
                deviceId: { ideal: FAKE_AUDIO_INPUT_ID },
            }),
            video: expect.objectContaining({
                deviceId: { ideal: FAKE_VIDEO_INPUT_ID },
            }),
        }));
    });

    describe("updateLocalUsermediaStreams", () => {
        let localStreamsChangedHandler: jest.Mock<void, []>;

        beforeEach(() => {
            localStreamsChangedHandler = jest.fn();
            mediaHandler.on(MediaHandlerEvent.LocalStreamsChanged, localStreamsChangedHandler);
        });

        it("does nothing if it has no streams", async () => {
            mediaHandler.updateLocalUsermediaStreams();
            expect(mockMediaDevices.getUserMedia).not.toHaveBeenCalled();
        });

        it("does not emit LocalStreamsChanged if it had no streams", async () => {
            const onLocalStreamsChanged = jest.fn();
            mediaHandler.on(MediaHandlerEvent.LocalStreamsChanged, onLocalStreamsChanged);

            await mediaHandler.updateLocalUsermediaStreams();

            expect(onLocalStreamsChanged).not.toHaveBeenCalled();
        });

        describe("with existing streams", () => {
            let stopTrack: jest.Mock<void, []>;

            beforeEach(() => {
                stopTrack = jest.fn();

                mediaHandler.userMediaStreams = [
                    {
                        getTracks: () => [{
                            stop: stopTrack,
                        } as unknown as MediaStreamTrack],
                    } as unknown as MediaStream,
                ];
            });

            it("stops existing streams", async () => {
                mediaHandler.updateLocalUsermediaStreams();
                expect(stopTrack).toHaveBeenCalled();
            });

            it("replaces streams on calls", async () => {
                const updateLocalUsermediaStream = jest.fn();

                calls.set("some_call", {
                    hasLocalUserMediaAudioTrack: true,
                    hasLocalUserMediaVideoTrack: true,
                    callHasEnded: jest.fn().mockReturnValue(false),
                    updateLocalUsermediaStream,
                } as unknown as MatrixCall);

                await mediaHandler.updateLocalUsermediaStreams();
                expect(updateLocalUsermediaStream).toHaveBeenCalled();
            });

            it("doesn't replace streams on ended calls", async () => {
                const updateLocalUsermediaStream = jest.fn();

                calls.set("some_call", {
                    hasLocalUserMediaAudioTrack: true,
                    hasLocalUserMediaVideoTrack: true,
                    callHasEnded: jest.fn().mockReturnValue(true),
                    updateLocalUsermediaStream,
                } as unknown as MatrixCall);

                await mediaHandler.updateLocalUsermediaStreams();
                expect(updateLocalUsermediaStream).not.toHaveBeenCalled();
            });

            it("replaces streams on group calls", async () => {
                const updateLocalUsermediaStream = jest.fn();

                groupCalls.set("some_group_call", {
                    localCallFeed: {},
                    updateLocalUsermediaStream,
                } as unknown as GroupCall);

                await mediaHandler.updateLocalUsermediaStreams();
                expect(updateLocalUsermediaStream).toHaveBeenCalled();
            });

            it("doesn't replace streams on group calls with no localCallFeed", async () => {
                const updateLocalUsermediaStream = jest.fn();

                groupCalls.set("some_group_call", {
                    localCallFeed: null,
                    updateLocalUsermediaStream,
                } as unknown as GroupCall);

                await mediaHandler.updateLocalUsermediaStreams();
                expect(updateLocalUsermediaStream).not.toHaveBeenCalled();
            });

            it("emits LocalStreamsChanged", async () => {
                const onLocalStreamsChanged = jest.fn();
                mediaHandler.on(MediaHandlerEvent.LocalStreamsChanged, onLocalStreamsChanged);

                await mediaHandler.updateLocalUsermediaStreams();

                expect(onLocalStreamsChanged).toHaveBeenCalled();
            });
        });
    });

    describe("hasAudioDevice", () => {
        it("returns true if the system has audio inputs", async () => {
            expect(await mediaHandler.hasAudioDevice()).toEqual(true);
        });

        it("returns false if the system has no audio inputs", async () => {
            mockMediaDevices.enumerateDevices.mockReturnValue(Promise.resolve([
                new MockMediaDeviceInfo("videoinput").typed(),
            ]));
            expect(await mediaHandler.hasAudioDevice()).toEqual(false);
        });
    });

    describe("hasVideoDevice", () => {
        it("returns true if the system has video inputs", async () => {
            expect(await mediaHandler.hasVideoDevice()).toEqual(true);
        });

        it("returns false if the system has no video inputs", async () => {
            mockMediaDevices.enumerateDevices.mockReturnValue(Promise.resolve([
                new MockMediaDeviceInfo("audioinput").typed(),
            ]));
            expect(await mediaHandler.hasVideoDevice()).toEqual(false);
        });
    });

    describe("getUserMediaStream", () => {
        beforeEach(() => {
            // replace this with one that returns a new object each time so we can
            // tell whether we've ended up with the same stream
            mockMediaDevices.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => {
                const stream = new MockMediaStream("local_stream");
                if (constraints.audio) {
                    const track = new MockMediaStreamTrack("audio_track", "audio");
                    track.settings = { deviceId: FAKE_AUDIO_INPUT_ID };
                    stream.addTrack(track);
                }
                if (constraints.video) {
                    const track = new MockMediaStreamTrack("video_track", "video");
                    track.settings = { deviceId: FAKE_VIDEO_INPUT_ID };
                    stream.addTrack(track);
                }

                return Promise.resolve(stream.typed());
            });

            mediaHandler.restoreMediaSettings(FAKE_AUDIO_INPUT_ID, FAKE_VIDEO_INPUT_ID);
        });

        it("returns the same stream for reusable streams", async () => {
            const stream1 = await mediaHandler.getUserMediaStream(true, false);
            const stream2 = await mediaHandler.getUserMediaStream(true, false) as unknown as MockMediaStream;

            expect(stream2.isCloneOf(stream1)).toEqual(true);
        });

        it("doesn't re-use stream if reusable is false", async () => {
            const stream1 = await mediaHandler.getUserMediaStream(true, false, false);
            const stream2 = await mediaHandler.getUserMediaStream(true, false);

            expect(stream1).not.toBe(stream2);
        });
    });
});
