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

import { type TransportStats } from "./transportStats.ts";
import { type Bitrate } from "./media/mediaTrackStats.ts";

export interface ConnectionStatsBandwidth {
    /**
     * bytes per second
     */
    download: number;
    /**
     * bytes per second
     */
    upload: number;
}

export interface ConnectionStatsBitrate extends Bitrate {
    audio?: Bitrate;
    video?: Bitrate;
}

export interface PacketLoss {
    total: number;
    download: number;
    upload: number;
}

export class ConnectionStats {
    public bandwidth: ConnectionStatsBitrate = {} as ConnectionStatsBitrate;
    public bitrate: ConnectionStatsBitrate = {} as ConnectionStatsBitrate;
    public packetLoss: PacketLoss = {} as PacketLoss;
    public transport: TransportStats[] = [];
}
