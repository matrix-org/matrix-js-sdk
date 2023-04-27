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
import { StatsReportGatherer } from "./statsReportGatherer";
import { StatsReportEmitter } from "./statsReportEmitter";
import { SummaryStats } from "./summaryStats";
import { SummaryStatsReporter } from "./summaryStatsReporter";

export class GroupCallStats {
    private timer: undefined | ReturnType<typeof setTimeout>;
    private readonly gatherers: Map<string, StatsReportGatherer> = new Map<string, StatsReportGatherer>();
    public readonly reports = new StatsReportEmitter();
    private readonly summaryStatsReporter = new SummaryStatsReporter(this.reports);

    public constructor(private groupCallId: string, private userId: string, private interval: number = 10000) {}

    public start(): void {
        if (this.timer === undefined && this.interval > 0) {
            this.timer = setInterval(() => {
                this.processStats();
            }, this.interval);
        }
    }

    public stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.gatherers.forEach((c) => c.stopProcessingStats());
        }
    }

    public hasStatsReportGatherer(callId: string): boolean {
        return this.gatherers.has(callId);
    }

    public addStatsReportGatherer(callId: string, userId: string, peerConnection: RTCPeerConnection): boolean {
        if (this.hasStatsReportGatherer(callId)) {
            return false;
        }
        this.gatherers.set(callId, new StatsReportGatherer(callId, userId, peerConnection, this.reports));
        return true;
    }

    public removeStatsReportGatherer(callId: string): boolean {
        return this.gatherers.delete(callId);
    }

    public getStatsReportGatherer(callId: string): StatsReportGatherer | undefined {
        return this.hasStatsReportGatherer(callId) ? this.gatherers.get(callId) : undefined;
    }

    private processStats(): void {
        const summary: Promise<SummaryStats>[] = [];
        this.gatherers.forEach((c) => {
            summary.push(c.processStats(this.groupCallId, this.userId));
        });

        Promise.all(summary).then((s: Awaited<SummaryStats>[]) => this.summaryStatsReporter.build(s));
    }

    public setInterval(interval: number): void {
        this.interval = interval;
    }
}
