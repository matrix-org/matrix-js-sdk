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

import { logger } from "../logger";

export class MediaHandler {
    private audioInput: string;
    private videoInput: string;
    private userMediaStreams: MediaStream[] = [];
    private screensharingStreams: MediaStream[] = [];

    /**
     * Set an audio input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public setAudioInput(deviceId: string): void {
        this.audioInput = deviceId;
    }

    /**
     * Set a video input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    public setVideoInput(deviceId: string): void {
        this.videoInput = deviceId;
    }

    /**
     * @returns {MediaStream} based on passed parameters
     */
    public async getUserMediaStream(audio: boolean, video: boolean): Promise<MediaStream> {
        let stream: MediaStream;

        if (this.userMediaStreams.length === 0) {
            const constraints = this.getUserMediaContraints(audio, video);
            logger.log("Getting user media with constraints", constraints);
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } else {
            stream = this.userMediaStreams[this.userMediaStreams.length - 1].clone();
        }

        this.userMediaStreams.push(stream);

        return stream;
    }

    /**
     * Stops all tracks on the provided usermedia stream
     */
    public stopUserMediaStream(mediaStream: MediaStream) {
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        const index = this.userMediaStreams.indexOf(mediaStream);

        if (index !== -1) {
            this.userMediaStreams.splice(index, 0);
        }
    }

    /**
     * @returns {MediaStream} based on passed parameters
     */
    public async getScreensharingStream(desktopCapturerSourceId: string): Promise<MediaStream | null> {
        let stream: MediaStream;

        if (this.screensharingStreams.length === 0) {
            const screenshareConstraints = this.getScreenshareContraints(desktopCapturerSourceId);
            if (!screenshareConstraints) return null;

            if (desktopCapturerSourceId) {
                // We are using Electron
                logger.debug("Getting screen stream using getUserMedia()...");
                stream = await navigator.mediaDevices.getUserMedia(screenshareConstraints);
            } else {
                // We are not using Electron
                logger.debug("Getting screen stream using getDisplayMedia()...");
                stream = await navigator.mediaDevices.getDisplayMedia(screenshareConstraints);
            }
        } else {
            stream = this.screensharingStreams[this.screensharingStreams.length - 1].clone();
        }

        this.screensharingStreams.push(stream);

        return stream;
    }

    /**
     * Stops all tracks on the provided screensharing stream
     */
    public stopScreensharingStream(mediaStream: MediaStream) {
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        const index = this.userMediaStreams.indexOf(mediaStream);

        if (index !== -1) {
            this.userMediaStreams.splice(index, 0);
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
