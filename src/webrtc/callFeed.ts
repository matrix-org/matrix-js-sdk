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

export enum CallFeedType {
    Webcam = "webcam",
    Screenshare = "screenshare",
}

export enum CallFeedEvent {
    NewStream = "new_stream",
}

export class CallFeed extends EventEmitter {
    constructor(
        public stream: MediaStream,
        public userId: string,
        public type: CallFeedType,
        private client: any, // Fix when client is TSified
    ) {
        super()
    }

    public isLocal() {
        return this.userId === this.client.getUserId();
    }

    // TODO: This should be later replaced by a method
    // that will also check if the remote is muted.
    public isAudioOnly(): boolean {
        // We assume only one video track
        return !this.stream.getTracks().some((track) => track.kind === "video");
    }

    public setNewStream(newStream: MediaStream) {
        this.stream = newStream;
        this.emit(CallFeedEvent.NewStream, this.stream);
    }
}
