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

import { logger } from "../logger";
import { MatrixCall } from "./call";
import { SDPStreamMetadataTrack } from "./callEventTypes";
import { CallTrack, CallTrackOpts } from "./callTrack";

export interface RemoteCallTrackOpts extends CallTrackOpts {
    call: MatrixCall;
    trackId?: string;
    metadata?: SDPStreamMetadataTrack;
    metadataMuted?: boolean;
}

/**
 * RemoteCallTrack is a wrapper around MediaStreamTrack. It represent an
 * incoming track.
 */
export class RemoteCallTrack extends CallTrack {
    private readonly _trackId?: string;
    private _metadata?: SDPStreamMetadataTrack;
    private _metadataMuted?: boolean;
    private _transceiver?: RTCRtpTransceiver;
    private call: MatrixCall;

    public constructor(opts: RemoteCallTrackOpts) {
        super(opts);

        this.call = opts.call;
        this._trackId = opts.trackId;
        this.metadata = opts.metadata;
        this.metadataMuted = opts.metadataMuted;
    }

    public get id(): string | undefined {
        return this._trackId;
    }

    public get trackId(): string | undefined {
        return this._trackId;
    }

    public get metadata(): SDPStreamMetadataTrack | undefined {
        return this._metadata;
    }

    public set metadata(metadata: SDPStreamMetadataTrack | undefined) {
        if (!metadata) return;
        this._metadata = metadata;
    }

    public get track(): MediaStreamTrack | undefined {
        return this._transceiver?.receiver?.track;
    }

    public get kind(): string | undefined {
        return this.track?.kind ?? this._metadata?.kind;
    }

    public get muted(): boolean {
        if (!this.track) return true;

        return this._metadataMuted ?? false;
    }

    public set metadataMuted(metadataMuted: boolean | undefined) {
        this._metadataMuted = metadataMuted;
    }

    public canSetTransceiver(transceiver: RTCRtpTransceiver): boolean {
        if (!this._trackId) return true;

        if (!transceiver.mid) return false;
        if (this.call.getRemoteTrackIdByMid(transceiver.mid) !== this._trackId) return false;

        return true;
    }

    public setTransceiver(transceiver: RTCRtpTransceiver): void {
        if (!this.canSetTransceiver(transceiver)) {
            throw new Error("Wrong track_id");
        }
        if (!transceiver.receiver.track) {
            throw new Error("No receiver or track");
        }
        if (!transceiver.mid) {
            throw new Error("No mid");
        }

        logger.log(
            `RemoteCallTrack ${this.id} setTransceiver() running (${this.call.getRemoteTrackInfoByMid(
                transceiver.mid,
            )})`,
        );

        this._transceiver = transceiver;
    }
}
