/// <reference types="node" />
import EventEmitter from "events";
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { MatrixClient } from "../client";
import { RoomMember } from "../models/room-member";
export declare const SPEAKING_THRESHOLD = -60;
export interface ICallFeedOpts {
    client: MatrixClient;
    roomId: string;
    userId: string;
    stream: MediaStream;
    purpose: SDPStreamMetadataPurpose;
    audioMuted: boolean;
    videoMuted: boolean;
}
export declare enum CallFeedEvent {
    NewStream = "new_stream",
    MuteStateChanged = "mute_state_changed",
    VolumeChanged = "volume_changed",
    Speaking = "speaking"
}
export declare class CallFeed extends EventEmitter {
    stream: MediaStream;
    userId: string;
    purpose: SDPStreamMetadataPurpose;
    speakingVolumeSamples: number[];
    private client;
    private roomId;
    private audioMuted;
    private videoMuted;
    private measuringVolumeActivity;
    private audioContext;
    private analyser;
    private frequencyBinCount;
    private speakingThreshold;
    private speaking;
    private volumeLooperTimeout;
    constructor(opts: ICallFeedOpts);
    private get hasAudioTrack();
    private updateStream;
    private initVolumeMeasuring;
    private onAddTrack;
    /**
     * Returns callRoom member
     * @returns member of the callRoom
     */
    getMember(): RoomMember;
    /**
     * Returns true if CallFeed is local, otherwise returns false
     * @returns {boolean} is local?
     */
    isLocal(): boolean;
    /**
     * Returns true if audio is muted or if there are no audio
     * tracks, otherwise returns false
     * @returns {boolean} is audio muted?
     */
    isAudioMuted(): boolean;
    /**
     * Returns true video is muted or if there are no video
     * tracks, otherwise returns false
     * @returns {boolean} is video muted?
     */
    isVideoMuted(): boolean;
    isSpeaking(): boolean;
    /**
     * Replaces the current MediaStream with a new one.
     * This method should be only used by MatrixCall.
     * @param newStream new stream with which to replace the current one
     */
    setNewStream(newStream: MediaStream): void;
    /**
     * Set feed's internal audio mute state
     * @param muted is the feed's audio muted?
     */
    setAudioMuted(muted: boolean): void;
    /**
     * Set feed's internal video mute state
     * @param muted is the feed's video muted?
     */
    setVideoMuted(muted: boolean): void;
    /**
     * Starts emitting volume_changed events where the emitter value is in decibels
     * @param enabled emit volume changes
     */
    measureVolumeActivity(enabled: boolean): void;
    setSpeakingThreshold(threshold: number): void;
    private volumeLooper;
    dispose(): void;
}
//# sourceMappingURL=callFeed.d.ts.map