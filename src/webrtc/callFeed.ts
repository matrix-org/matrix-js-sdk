/*
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
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { MatrixClient } from "../client";
import { RoomMember } from "../models/room-member";

export enum CallFeedEvent {
    NewStream = "new_stream",
    MuteStateChanged = "mute_state_changed"
}

export class CallFeed extends EventEmitter {
    constructor(
        public stream: MediaStream,
        public userId: string,
        public purpose: SDPStreamMetadataPurpose,
        private client: MatrixClient,
        private roomId: string,
        private audioMuted: boolean,
        private videoMuted: boolean,
    ) {
        super();
    }

    /**
     * Returns callRoom member
     * @returns member of the callRoom
     */
    public getMember(): RoomMember {
        const callRoom = this.client.getRoom(this.roomId);
        return callRoom.getMember(this.userId);
    }

    /**
     * Returns true if CallFeed is local, otherwise returns false
     * @returns {boolean} is local?
     */
    public isLocal(): boolean {
        return this.userId === this.client.getUserId();
    }

    /**
     * Returns true if audio is muted or if there are no audio
     * tracks, otherwise returns false
     * @returns {boolean} is audio muted?
     */
    public isAudioMuted(): boolean {
        return this.stream.getAudioTracks().length === 0 || this.audioMuted;
    }

    /**
     * Returns true video is muted or if there are no video
     * tracks, otherwise returns false
     * @returns {boolean} is video muted?
     */
    public isVideoMuted(): boolean {
        // We assume only one video track
        return this.stream.getVideoTracks().length === 0 || this.videoMuted;
    }

    /**
     * Replaces the current MediaStream with a new one.
     * This method should be only used by MatrixCall.
     * @param newStream new stream with which to replace the current one
     */
    public setNewStream(newStream: MediaStream) {
        this.stream = newStream;
        this.emit(CallFeedEvent.NewStream, this.stream);
    }

    public setAudioMuted(muted: boolean): void {
        this.audioMuted = muted;
        this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
    }

    public setVideoMuted(muted: boolean): void {
        this.videoMuted = muted;
        this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
    }
}
