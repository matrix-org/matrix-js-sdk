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

import { ConnectionStatsBandwidth, ConnectionStatsBitrate, PacketLoss } from "./connectionStats";
import { TransportStats } from "./transportStats";
import { Resolution } from "./media/mediaTrackStats";

export enum StatsReport {
    CONNECTION_STATS = "StatsReport.connection_stats",
    BYTE_SENT_STATS = "StatsReport.byte_sent_stats",
    SUMMARY_STATS = "StatsReport.summary_stats",
}

export type TrackID = string;
export type ByteSend = number;

export interface ByteSentStatsReport extends Map<TrackID, ByteSend> {
    callId?: string;
    opponentMemberId?: string;
    // is a map: `local trackID` => byte send
}

export interface ConnectionStatsReport {
    callId?: string;
    opponentMemberId?: string;
    bandwidth: ConnectionStatsBandwidth;
    bitrate: ConnectionStatsBitrate;
    packetLoss: PacketLoss;
    audioConcealment: Map<TrackID, AudioConcealment>;
    totalAudioConcealment: AudioConcealment;
    resolution: ResolutionMap;
    framerate: FramerateMap;
    codec: CodecMap;
    jitter: Map<TrackID, number>;
    transport: TransportStats[];
}

export interface AudioConcealment {
    concealedAudio: number;
    totalAudioDuration: number;
}

export interface ResolutionMap {
    local: Map<TrackID, Resolution>;
    remote: Map<TrackID, Resolution>;
}

export interface FramerateMap {
    local: Map<TrackID, number>;
    remote: Map<TrackID, number>;
}

export interface CodecMap {
    local: Map<TrackID, string>;
    remote: Map<TrackID, string>;
}

export interface SummaryStatsReport {
    /**
     * Aggregated the information for percentage of received media
     *
     * This measure whether the current user receive data from a call participants.
     * As soon as a participant sends at least a byte media to this user, this counts as one measurement unit.
     * The units of measure divided by the total number of participants is a value between 0 and 1.
     */
    percentageReceivedMedia: number;
    percentageReceivedAudioMedia: number;
    percentageReceivedVideoMedia: number;
    maxJitter: number;
    maxPacketLoss: number;
    percentageConcealedAudio: number;
    peerConnections: number;
}
