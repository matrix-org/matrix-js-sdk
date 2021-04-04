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

export enum CallFeedPurpose {
    Usermedia = "usermedia",
    Screenshare = "screenshare",
}

export enum CallFeedEvent {
    NewStream = "new_stream",
}

export class CallFeed extends EventEmitter {
    constructor(
        public stream: MediaStream,
        public userId: string,
        public purpose: CallFeedPurpose,
        private client: any, // Fix when client is TSified
        private roomId: string,
    ) {
        super()
    }

    /**
     * Returns callRoom member
     * @returns member of the callRoom
     */
    public getMember() {
        const callRoom = this.client.getRoom(this.roomId);
        return callRoom.getMember(this.userId);
    }

    /**
     * Returns true if CallFeed is local, otherwise returns false
     * @returns {boolean} is local?
     */
    public isLocal() {
        return this.userId === this.client.getUserId();
    }

    // TODO: This should be later replaced by a method
    // that will also check if the remote is muted.
    /**
     * Returns true if there are no video tracks, otherwise returns false
     * @returns {boolean} is audio only?
     */
    public isAudioOnly(): boolean {
        // We assume only one video track
        return !this.stream.getTracks().some((track) => track.kind === "video");
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
}
