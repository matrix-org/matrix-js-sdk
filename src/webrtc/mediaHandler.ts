/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.
Copyright 2021 Šimon Brandner <simon.bra.ag@gmail.com>

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

import EventEmitter from "events";
import { GroupCallType, GroupCallState } from "../webrtc/groupCall";
import { MatrixClient } from "../client";
import { logger } from "../logger";

export enum MediaHandlerEvent {
    LocalStreamsChanged = "local_streams_changed"
}

export class MediaHandler extends EventEmitter {
    private audioInput: string;
    private videoInput: string;
    private localUserMediaStream?: MediaStream;
    public userMediaStreams: MediaStream[] = [];
    public screensharingStreams: MediaStream[] = [];

    constructor(private client: MatrixClient) {
        super();
    }

    public restoreMediaSettings(audioInput: string, videoInput: string) {
        this.audioInput = audioInput;
        this.videoInput = videoInput;
    }

    /**
     * Set an audio input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public async setAudioInput(deviceId: string): Promise<void> {
        logger.log(`mediaHandler setAudioInput ${deviceId}`);
        this.audioInput = deviceId;
        await this.updateLocalUsermediaStreams();
    }

    /**
     * Set a video input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public async setVideoInput(deviceId: string): Promise<void> {
        logger.log(`mediaHandler setVideoInput ${deviceId}`);
        this.videoInput = deviceId;
        await this.updateLocalUsermediaStreams();
    }

    /**
     * Set media input devices to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public async setMediaInputs(audioInput: string, videoInput: string): Promise<void> {
        logger.log(`mediaHandler setMediaInputs audioInput: ${audioInput} videoInput: ${videoInput}`);
        this.audioInput = audioInput;
        this.videoInput = videoInput;
        await this.updateLocalUsermediaStreams();
    }

    public async updateLocalUsermediaStreams(): Promise<void> {
        const callMediaStreamParams: Map<string, { audio: boolean, video: boolean }> = new Map();
        for (const call of this.client.callEventHandler.calls.values()) {
            callMediaStreamParams.set(call.callId, {
                audio: call.hasLocalUserMediaAudioTrack,
                video: call.hasLocalUserMediaVideoTrack,
            });
        }

        for (const stream of this.userMediaStreams) {
            logger.log(`mediaHandler stopping all tracks for stream ${stream.id}`);
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }

        this.userMediaStreams = [];
        this.localUserMediaStream = undefined;

        for (const call of this.client.callEventHandler.calls.values()) {
            if (call.callHasEnded() || !callMediaStreamParams.has(call.callId)) {
                continue;
            }

            const { audio, video } = callMediaStreamParams.get(call.callId);

            logger.log(`mediaHandler updateLocalUsermediaStreams getUserMediaStream call ${call.callId}`);
            const stream = await this.getUserMediaStream(audio, video);

            if (call.callHasEnded()) {
                continue;
            }

            await call.updateLocalUsermediaStream(stream);
        }

        for (const groupCall of this.client.groupCallEventHandler.groupCalls.values()) {
            if (!groupCall.localCallFeed) {
                continue;
            }

            logger.log(`mediaHandler updateLocalUsermediaStreams getUserMediaStream groupCall ${
                groupCall.groupCallId}`);
            const stream = await this.getUserMediaStream(
                true,
                groupCall.type === GroupCallType.Video,
            );

            if (groupCall.state === GroupCallState.Ended) {
                continue;
            }

            await groupCall.updateLocalUsermediaStream(stream);
        }

        this.emit(MediaHandlerEvent.LocalStreamsChanged);
    }

    public async hasAudioDevice(): Promise<boolean> {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === "audioinput").length > 0;
    }

    public async hasVideoDevice(): Promise<boolean> {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === "videoinput").length > 0;
    }

    /**
     * @returns {MediaStream} based on passed parameters
     */
    public async getUserMediaStream(audio: boolean, video: boolean): Promise<MediaStream> {
        const shouldRequestAudio = audio && await this.hasAudioDevice();
        const shouldRequestVideo = video && await this.hasVideoDevice();

        let stream: MediaStream;

        if (
            !this.localUserMediaStream ||
            (this.localUserMediaStream.getAudioTracks().length === 0 && shouldRequestAudio) ||
            (this.localUserMediaStream.getVideoTracks().length === 0 && shouldRequestVideo)
        ) {
            const constraints = this.getUserMediaContraints(shouldRequestAudio, shouldRequestVideo);
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            logger.log(`mediaHandler getUserMediaStream streamId ${stream.id} shouldRequestAudio ${
                shouldRequestAudio} shouldRequestVideo ${shouldRequestVideo}`, constraints);

            for (const track of stream.getTracks()) {
                const settings = track.getSettings();

                if (track.kind === "audio") {
                    this.audioInput = settings.deviceId;
                } else if (track.kind === "video") {
                    this.videoInput = settings.deviceId;
                }
            }

            this.localUserMediaStream = stream;
        } else {
            stream = this.localUserMediaStream.clone();
            logger.log(`mediaHandler clone userMediaStream ${this.localUserMediaStream.id} new stream ${
                stream.id} shouldRequestAudio ${shouldRequestAudio} shouldRequestVideo ${shouldRequestVideo}`);

            if (!shouldRequestAudio) {
                for (const track of stream.getAudioTracks()) {
                    stream.removeTrack(track);
                }
            }

            if (!shouldRequestVideo) {
                for (const track of stream.getVideoTracks()) {
                    stream.removeTrack(track);
                }
            }
        }

        this.userMediaStreams.push(stream);

        this.emit(MediaHandlerEvent.LocalStreamsChanged);

        return stream;
    }

    /**
     * Stops all tracks on the provided usermedia stream
     */
    public stopUserMediaStream(mediaStream: MediaStream) {
        logger.log(`mediaHandler stopUserMediaStream stopping stream ${mediaStream.id}`);
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        const index = this.userMediaStreams.indexOf(mediaStream);

        if (index !== -1) {
            logger.debug("Splicing usermedia stream out stream array", mediaStream.id);
            this.userMediaStreams.splice(index, 1);
        }

        this.emit(MediaHandlerEvent.LocalStreamsChanged);
    }

    /**
     * @returns {MediaStream} based on passed parameters
     */
    public async getScreensharingStream(desktopCapturerSourceId?: string): Promise<MediaStream | null> {
        let stream: MediaStream;

        if (this.screensharingStreams.length === 0) {
            const screenshareConstraints = this.getScreenshareContraints(desktopCapturerSourceId);
            if (!screenshareConstraints) return null;

            if (desktopCapturerSourceId) {
                // We are using Electron
                logger.debug("Getting screensharing stream using getUserMedia()", desktopCapturerSourceId);
                stream = await navigator.mediaDevices.getUserMedia(screenshareConstraints);
            } else {
                // We are not using Electron
                logger.debug("Getting screensharing stream using getDisplayMedia()");
                stream = await navigator.mediaDevices.getDisplayMedia(screenshareConstraints);
            }
        } else {
            const matchingStream = this.screensharingStreams[this.screensharingStreams.length - 1];
            logger.log("Cloning screensharing stream", matchingStream.id);
            stream = matchingStream.clone();
        }

        this.screensharingStreams.push(stream);

        this.emit(MediaHandlerEvent.LocalStreamsChanged);

        return stream;
    }

    /**
     * Stops all tracks on the provided screensharing stream
     */
    public stopScreensharingStream(mediaStream: MediaStream) {
        logger.debug("Stopping screensharing stream", mediaStream.id);
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        const index = this.screensharingStreams.indexOf(mediaStream);

        if (index !== -1) {
            logger.debug("Splicing screensharing stream out stream array", mediaStream.id);
            this.screensharingStreams.splice(index, 1);
        }

        this.emit(MediaHandlerEvent.LocalStreamsChanged);
    }

    /**
     * Stops all local media tracks
     */
    public stopAllStreams() {
        for (const stream of this.userMediaStreams) {
            logger.log(`mediaHandler stopAllStreams stopping stream ${stream.id}`);
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }

        for (const stream of this.screensharingStreams) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }

        this.userMediaStreams = [];
        this.screensharingStreams = [];
        this.localUserMediaStream = undefined;

        this.emit(MediaHandlerEvent.LocalStreamsChanged);
    }

    private getUserMediaContraints(audio: boolean, video: boolean): MediaStreamConstraints {
        const isWebkit = !!navigator.webkitGetUserMedia;

        return {
            audio: audio
                ? {
                    deviceId: this.audioInput ? { ideal: this.audioInput } : undefined,
                }
                : false,
            video: video
                ? {
                    deviceId: this.videoInput ? { ideal: this.videoInput } : undefined,
                    /* We want 640x360.  Chrome will give it only if we ask exactly,
                   FF refuses entirely if we ask exactly, so have to ask for ideal
                   instead
                   XXX: Is this still true?
                 */
                    width: isWebkit ? { exact: 640 } : { ideal: 640 },
                    height: isWebkit ? { exact: 360 } : { ideal: 360 },
                }
                : false,
        };
    }

    private getScreenshareContraints(desktopCapturerSourceId?: string): DesktopCapturerConstraints {
        if (desktopCapturerSourceId) {
            logger.debug("Using desktop capturer source", desktopCapturerSourceId);
            return {
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: desktopCapturerSourceId,
                    },
                },
            };
        } else {
            logger.debug("Not using desktop capturer source");
            return {
                audio: false,
                video: true,
            };
        }
    }
}
