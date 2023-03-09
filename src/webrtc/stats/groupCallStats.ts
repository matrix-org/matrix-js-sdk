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
import { StatsCollector } from "./statsCollector";

export class GroupCallStats {
    private timer = -1;
    private readonly collectors: Map<string, StatsCollector> = new Map<string, StatsCollector>();

    public constructor(private groupCallId: string, private userId: string, private interval: number = 10000) {}

    public start(): void {
        this.timer = window.setInterval(() => {
            this.processStats();
        }, this.interval);
    }

    public stop(): void {
        if (this.timer > 0) {
            window.clearInterval(this.timer);
            this.collectors.forEach((c) => c.stopProcessingStats());
        }
    }

    public hasStatsCollector(callId: string): boolean {
        return this.collectors.has(callId);
    }

    public addStatsCollector(callId: string, userId: string, peerConnection: RTCPeerConnection): boolean {
        if (this.hasStatsCollector(callId)) {
            return false;
        }
        this.collectors.set(callId, new StatsCollector(callId, userId, peerConnection));
        return true;
    }

    public removeStatsCollector(callId: string): boolean {
        return this.collectors.delete(callId);
    }

    public getStatsCollector(callId: string): StatsCollector | undefined {
        return this.hasStatsCollector(callId) ? this.collectors.get(callId) : undefined;
    }

    private processStats(): void {
        this.collectors.forEach((c) => c.processStats(this.groupCallId, this.userId));
    }
}
