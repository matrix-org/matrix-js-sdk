/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { randomString } from "../randomstring";
import { SDPStreamMetadataTrack } from "./callEventTypes";

export interface CallTrackOpts {}

export abstract class CallTrack {
    public abstract get id(): string | undefined;
    public abstract get track(): MediaStreamTrack | undefined;
    public abstract get trackId(): string | undefined;
    public abstract get metadata(): SDPStreamMetadataTrack | undefined;
    public abstract get kind(): string | undefined;
    public abstract get muted(): boolean;

    protected readonly _id: string;
    protected _transceiver?: RTCRtpTransceiver;

    public constructor(opts: CallTrackOpts) {
        this._id = randomString(32);
    }

    public get transceiver(): RTCRtpTransceiver | undefined {
        return this._transceiver;
    }

    public get isAudio(): boolean {
        return this.kind === "audio";
    }

    public get isVideo(): boolean {
        return this.kind === "video";
    }
}
