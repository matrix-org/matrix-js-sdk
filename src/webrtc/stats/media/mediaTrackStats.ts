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

import { TrackId } from "./mediaTrackHandler";

export interface PacketLoss {
    packetsTotal: number;
    packetsLost: number;
    isDownloadStream: boolean;
}

export interface Bitrate {
    /**
     * bytes per second
     */
    download: number;
    /**
     * bytes per second
     */
    upload: number;
}

export interface Resolution {
    width: number;
    height: number;
}

export type TrackStatsType = "local" | "remote";

export class MediaTrackStats {
    private loss: PacketLoss = { packetsTotal: 0, packetsLost: 0, isDownloadStream: false };
    private bitrate: Bitrate = { download: 0, upload: 0 };
    private resolution: Resolution = { width: -1, height: -1 };
    private framerate = 0;
    private codec = "";

    public constructor(
        public readonly trackId: TrackId,
        public readonly type: TrackStatsType,
        public readonly kind: "audio" | "video",
    ) {}

    public getType(): TrackStatsType {
        return this.type;
    }

    public setLoss(loos: PacketLoss): void {
        this.loss = loos;
    }

    public getLoss(): PacketLoss {
        return this.loss;
    }

    public setResolution(resolution: Resolution): void {
        this.resolution = resolution;
    }

    public getResolution(): Resolution {
        return this.resolution;
    }

    public setFramerate(framerate: number): void {
        this.framerate = framerate;
    }

    public getFramerate(): number {
        return this.framerate;
    }

    public setBitrate(bitrate: Bitrate): void {
        this.bitrate = bitrate;
    }

    public getBitrate(): Bitrate {
        return this.bitrate;
    }

    public setCodec(codecShortType: string): boolean {
        this.codec = codecShortType;
        return true;
    }

    public getCodec(): string {
        return this.codec;
    }

    public resetBitrate(): void {
        this.bitrate = { download: 0, upload: 0 };
    }
}
