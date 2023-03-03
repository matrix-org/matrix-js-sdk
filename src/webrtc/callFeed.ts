/*
Copyright 2021 - 2022 Šimon Brandner <simon.bra.ag@gmail.com>
Copyright 2021 - 2023 The Matrix.org Foundation C.I.C.

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

import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { acquireContext, releaseContext } from "./audioContext";
import { MatrixClient } from "../client";
import { RoomMember } from "../models/room-member";
import { TypedEventEmitter } from "../models/typed-event-emitter";
import { CallTrack } from "./callTrack";
import { randomString } from "../randomstring";

const POLLING_INTERVAL = 200; // ms
export const SPEAKING_THRESHOLD = -60; // dB
const SPEAKING_SAMPLE_COUNT = 8; // samples

export interface ICallFeedOpts {
    client: MatrixClient;
    roomId?: string;
}

export enum CallFeedEvent {
    NewStream = "new_stream",
    MuteStateChanged = "mute_state_changed",
    LocalVolumeChanged = "local_volume_changed",
    VolumeChanged = "volume_changed",
    ConnectedChanged = "connected_changed",
    SizeChanged = "size_changed",
    Speaking = "speaking",
    Disposed = "disposed",
}

type EventHandlerMap = {
    [CallFeedEvent.NewStream]: (stream?: MediaStream) => void;
    [CallFeedEvent.MuteStateChanged]: (audioMuted: boolean, videoMuted: boolean) => void;
    [CallFeedEvent.LocalVolumeChanged]: (localVolume: number) => void;
    [CallFeedEvent.VolumeChanged]: (volume: number) => void;
    [CallFeedEvent.ConnectedChanged]: (connected: boolean) => void;
    [CallFeedEvent.SizeChanged]: () => void;
    [CallFeedEvent.Speaking]: (speaking: boolean) => void;
    [CallFeedEvent.Disposed]: () => void;
};

/**
 * CallFeed is a wrapper around a MediaStream. It includes useful information
 * such as the userId and deviceId of the stream's sender, mute state, volume
 * activity etc. This class would be usually used to display the video tiles in
 * the UI.
 */
export abstract class CallFeed extends TypedEventEmitter<CallFeedEvent, EventHandlerMap> {
    public abstract get id(): string;
    public abstract get purpose(): SDPStreamMetadataPurpose;
    public abstract get connected(): boolean;
    public abstract get userId(): string;
    public abstract get deviceId(): string | undefined;

    public abstract isLocal: boolean;
    public abstract isRemote: boolean;

    public speakingVolumeSamples: number[];

    protected readonly _id: string;
    protected _tracks: CallTrack[] = [];
    protected _stream?: MediaStream;
    protected roomId?: string;
    protected client: MatrixClient;

    private localVolume = 1;
    private measuringVolumeActivity = false;
    private audioContext?: AudioContext;
    private analyser?: AnalyserNode;
    private audioSourceNode?: MediaStreamAudioSourceNode;
    private frequencyBinCount?: Float32Array;
    private speakingThreshold = SPEAKING_THRESHOLD;
    private speaking = false;
    private volumeLooperTimeout?: ReturnType<typeof setTimeout>;
    private _disposed = false;
    private _width = 0;
    private _height = 0;
    private _isVisible = false;

    public constructor(opts: ICallFeedOpts) {
        super();

        this._id = randomString(32);
        this.client = opts.client;
        this.roomId = opts.roomId;
        this.speakingVolumeSamples = new Array(SPEAKING_SAMPLE_COUNT).fill(-Infinity);

        this.startMeasuringVolume();
    }

    public get stream(): MediaStream | undefined {
        return this._stream;
    }

    public get isVisible(): boolean {
        return this._isVisible;
    }

    public get width(): number | undefined {
        return this._width;
    }

    public get height(): number | undefined {
        return this._height;
    }

    public get audioTracks(): CallTrack[] {
        return this._tracks.filter((track) => track.isAudio);
    }

    public get videoTracks(): CallTrack[] {
        return this._tracks.filter((track) => track.isVideo);
    }

    public get audioTrack(): CallTrack | undefined {
        return this.audioTracks[0];
    }

    public get videoTrack(): CallTrack | undefined {
        return this.videoTracks[0];
    }

    public get audioMuted(): boolean {
        return !this.audioTracks.some((track) => !track.muted);
    }

    public get videoMuted(): boolean {
        return !this.videoTracks.some((track) => !track.muted);
    }

    private get hasAudioTrack(): boolean {
        return this.stream ? this.stream.getAudioTracks().length > 0 : false;
    }

    protected get tracks(): CallTrack[] {
        return [...this._tracks];
    }

    protected updateStream(oldStream?: MediaStream, newStream?: MediaStream): void {
        if (newStream === oldStream) return;

        if (oldStream) {
            clearTimeout(this.volumeLooperTimeout);
        }

        this._stream = newStream;

        this.startMeasuringVolume();

        this.emit(CallFeedEvent.NewStream, this.stream);
    }

    /**
     * Sets up the volume measuring and/or starts the measuring loop
     */
    protected startMeasuringVolume(): void {
        if (!this.stream) return;
        if (!this.hasAudioTrack) return;
        if (!this.audioContext) this.audioContext = acquireContext();

        // If streams changed, setup the things we need for measuring volume
        if (this.audioSourceNode?.mediaStream !== this.stream) {
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 512;
            this.analyser.smoothingTimeConstant = 0.1;

            this.audioSourceNode = this.audioContext.createMediaStreamSource(this.stream);
            this.audioSourceNode.connect(this.analyser);

            this.frequencyBinCount = new Float32Array(this.analyser.frequencyBinCount);
        }

        // If we should not be measuring volume activity atm, don't start the loop
        if (!this.measuringVolumeActivity) return;

        const loop = (): void => {
            if (!this.analyser || !this.frequencyBinCount) {
                clearTimeout(this.volumeLooperTimeout);
                this.volumeLooperTimeout = undefined;
                return;
            }

            this.analyser.getFloatFrequencyData(this.frequencyBinCount);

            let maxVolume = -Infinity;
            for (const volume of this.frequencyBinCount!) {
                if (volume > maxVolume) {
                    maxVolume = volume;
                }
            }

            this.speakingVolumeSamples.shift();
            this.speakingVolumeSamples.push(maxVolume);

            this.emit(CallFeedEvent.VolumeChanged, maxVolume);

            let newSpeaking = false;

            for (const volume of this.speakingVolumeSamples) {
                if (volume > this.speakingThreshold) {
                    newSpeaking = true;
                    break;
                }
            }

            if (this.speaking !== newSpeaking) {
                this.speaking = newSpeaking;
                this.emit(CallFeedEvent.Speaking, this.speaking);
            }

            this.volumeLooperTimeout = setTimeout(loop, POLLING_INTERVAL);
        };

        loop();
    }

    /**
     * Returns callRoom member
     * @returns member of the callRoom
     */
    public getMember(): RoomMember | null {
        const callRoom = this.client.getRoom(this.roomId);
        return callRoom?.getMember(this.userId) ?? null;
    }

    /**
     * Returns true if audio is muted or if there are no audio
     * tracks, otherwise returns false
     * @deprecated use audioMuted instead
     * @returns is audio muted?
     */
    public isAudioMuted(): boolean {
        return this.audioMuted;
    }

    /**
     * Returns true video is muted or if there are no video
     * tracks, otherwise returns false
     * @deprecated use videoMuted instead
     * @returns is video muted?
     */
    public isVideoMuted(): boolean {
        return this.videoMuted;
    }

    public isSpeaking(): boolean {
        return this.speaking;
    }

    /**
     * Starts emitting volume_changed events where the emitter value is in decibels
     * @param enabled - emit volume changes
     */
    public measureVolumeActivity(enabled: boolean): void {
        if (enabled) {
            clearTimeout(this.volumeLooperTimeout);
            this.measuringVolumeActivity = true;
            this.startMeasuringVolume();
        } else {
            this.measuringVolumeActivity = false;
            this.speakingVolumeSamples.fill(-Infinity);
            this.emit(CallFeedEvent.VolumeChanged, -Infinity);
        }
    }

    public setSpeakingThreshold(threshold: number): void {
        this.speakingThreshold = threshold;
    }

    public dispose(): void {
        clearTimeout(this.volumeLooperTimeout);
        if (this.audioContext) {
            this.audioContext = undefined;
            this.analyser = undefined;
            releaseContext();
        }
        this._disposed = true;
        this.emit(CallFeedEvent.Disposed);
    }

    public get disposed(): boolean {
        return this._disposed;
    }

    private set disposed(value: boolean) {
        this._disposed = value;
    }

    public getLocalVolume(): number {
        return this.localVolume;
    }

    public setLocalVolume(localVolume: number): void {
        this.localVolume = localVolume;
        this.emit(CallFeedEvent.LocalVolumeChanged, localVolume);
    }

    public setResolution(width: number, height: number): void {
        this._width = Math.round(width);
        this._height = Math.round(height);

        this.emit(CallFeedEvent.SizeChanged);
    }

    public setIsVisible(isVisible: boolean): void {
        this._isVisible = isVisible;

        this.emit(CallFeedEvent.SizeChanged);
    }
}
