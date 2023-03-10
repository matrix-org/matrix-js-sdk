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

import { TypedEventEmitter } from "../../models/typed-event-emitter";
import { ByteSendStatsReport, ConnectionStatsReport, StatsReport } from "./statsReport";

export type StatsReportHandlerMap = {
    /**
     * Fires whenever the timeline in a room is updated.
     * @param event - The matrix event which caused this event to fire.
     * @param room - The room, if any, whose timeline was updated.
     * @param toStartOfTimeline - True if this event was added to the start
     * @param removed - True if this event has just been removed from the timeline
     * (beginning; oldest) of the timeline e.g. due to pagination.
     *
     * @param data - more data about the event
     *
     * @example
     * ```
     * matrixClient.on("Room.timeline",
     *                 function(event, room, toStartOfTimeline, removed, data) {
     *   if (!toStartOfTimeline && data.liveEvent) {
     *     var messageToAppend = room.timeline.[room.timeline.length - 1];
     *   }
     * });
     * ```
     */
    [StatsReport.BYTE_SENT_STATS]: (report: ByteSendStatsReport) => void;
    /**
     * Fires whenever the live timeline in a room is reset.
     *
     * When we get a 'limited' sync (for example, after a network outage), we reset
     * the live timeline to be empty before adding the recent events to the new
     * timeline. This event is fired after the timeline is reset, and before the
     * new events are added.
     *
     * @param room - The room whose live timeline was reset, if any
     * @param timelineSet - timelineSet room whose live timeline was reset
     * @param resetAllTimelines - True if all timelines were reset.
     */
    [StatsReport.CONNECTION_STATS]: (report: ConnectionStatsReport) => void;
};

export class StatsReportEmitter extends TypedEventEmitter<StatsReport, StatsReportHandlerMap> {
    public emitByteSendReport(byteSentStats: ByteSendStatsReport): void {
        this.emit(StatsReport.BYTE_SENT_STATS, byteSentStats);
    }

    public emitConnectionStatsReport(report: ConnectionStatsReport): void {
        this.emit(StatsReport.CONNECTION_STATS, report);
    }
}
