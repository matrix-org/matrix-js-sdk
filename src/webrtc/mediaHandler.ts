/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.
Copyright 2021 - 2022 Šimon Brandner <simon.bra.ag@gmail.com>

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

import { logger } from "../logger";
import { MatrixClient } from "../client";
import { CallState } from "./call";

export class MediaHandler {
    private audioInput: string;
    private videoInput: string;
    private localUserMediaStream?: MediaStream;
    public userMediaStreams: MediaStream[] = [];
    public screensharingStreams: MediaStream[] = [];

    constructor(private client: MatrixClient) { }

    /**
     * Set an audio input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public async setAudioInput(deviceId: string): Promise<void> {
        logger.info("LOG setting audio input to", deviceId);

        if (this.audioInput === deviceId) return;

        this.audioInput = deviceId;
        await this.updateLocalUsermediaStreams();
    }

    /**
     * Set a video input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public async setVideoInput(deviceId: string): Promise<void> {
        logger.info("LOG setting video input to", deviceId);

        if (this.videoInput === deviceId) return;

        this.videoInput = deviceId;
        await this.updateLocalUsermediaStreams();
    }

    /**
     * Requests new usermedia streams and replace the old ones
     */
    public async updateLocalUsermediaStreams(): Promise<void> {
        if (this.userMediaStreams.length === 0) return;

        const callMediaStreamParams: Map<string, { audio: boolean, video: boolean }> = new Map();
        for (const call of this.client.callEventHandler.calls.values()) {
            callMediaStreamParams.set(call.callId, {
                audio: call.hasLocalUserMediaAudioTrack,
                video: call.hasLocalUserMediaVideoTrack,
            });
        }

        for (const call of this.client.callEventHandler.calls.values()) {
            if (call.state === CallState.Ended || !callMediaStreamParams.has(call.callId)) continue;

            const { audio, video } = callMediaStreamParams.get(call.callId);

            // This stream won't be reusable as we will replace the tracks of the old stream
            const stream = await this.getUserMediaStream(audio, video, false);

            await call.updateLocalUsermediaStream(stream);
        }
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
     * @param audio should have an audio track
     * @param video should have a video track
     * @param reusable is allowed to be reused by the MediaHandler
     * @returns {MediaStream} based on passed parameters
     */
    public async getUserMediaStream(audio: boolean, video: boolean, reusable = true): Promise<MediaStream> {
        const shouldRequestAudio = audio && await this.hasAudioDevice();
        const shouldRequestVideo = video && await this.hasVideoDevice();

        let stream: MediaStream;

        if (
            !this.localUserMediaStream ||
            (this.localUserMediaStream.getAudioTracks().length === 0 && shouldRequestAudio) ||
            (this.localUserMediaStream.getVideoTracks().length === 0 && shouldRequestVideo) ||
            (this.localUserMediaStream.getAudioTracks()[0]?.getSettings()?.deviceId !== this.audioInput) ||
            (this.localUserMediaStream.getVideoTracks()[0]?.getSettings()?.deviceId !== this.videoInput)
        ) {
            const constraints = this.getUserMediaContraints(shouldRequestAudio, shouldRequestVideo);
            logger.log("Getting user media with constraints", constraints);
            stream = await navigator.mediaDevices.getUserMedia(constraints);

            for (const track of stream.getTracks()) {
                const settings = track.getSettings();

                if (track.kind === "audio") {
                    this.audioInput = settings.deviceId;
                } else if (track.kind === "video") {
                    this.videoInput = settings.deviceId;
                }
            }

            if (reusable) {
                this.localUserMediaStream = stream;
            }
        } else {
            stream = this.localUserMediaStream.clone();

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

        if (reusable) {
            this.userMediaStreams.push(stream);
        }

        return stream;
    }

    /**
     * Stops all tracks on the provided usermedia stream
     */
    public stopUserMediaStream(mediaStream: MediaStream) {
        logger.debug("Stopping usermedia stream", mediaStream.id);
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        const index = this.userMediaStreams.indexOf(mediaStream);

        if (index !== -1) {
            logger.debug("Splicing usermedia stream out stream array", mediaStream.id);
            this.userMediaStreams.splice(index, 1);
        }

        if (this.localUserMediaStream === mediaStream) {
            this.localUserMediaStream = undefined;
        }
    }

    /**
     * @param desktopCapturerSourceId sourceId for Electron DesktopCapturer
     * @param reusable is allowed to be reused by the MediaHandler
     * @returns {MediaStream} based on passed parameters
     */
    public async getScreensharingStream(desktopCapturerSourceId: string, reusable = true): Promise<MediaStream | null> {
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

        if (reusable) {
            this.screensharingStreams.push(stream);
        }

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
    }

    /**
     * Stops all local media tracks
     */
    public stopAllStreams() {
        for (const stream of this.userMediaStreams) {
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
