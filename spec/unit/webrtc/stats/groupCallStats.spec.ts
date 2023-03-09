/*
Copyright 2020 - 2023 The Matrix.org Foundation C.I.C.

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
import { GroupCallStats } from "../../../../src/webrtc/stats/groupCallStats";

const GROUP_CALL_ID = "GROUP_ID";
const LOCAL_USER_ID = "LOCAL_USER_ID";
const TIME_INTERVAL = 10000;

describe("GroupCallStats", () => {
    let stats: GroupCallStats;
    beforeEach(() => {
        stats = new GroupCallStats(GROUP_CALL_ID, LOCAL_USER_ID, TIME_INTERVAL);
        // @ts-ignore
        // eslint-disable-next-line no-global-assign
        global["window"] = {};
    });

    describe("add stats collector", () => {
        it("new", async () => {
            expect(stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection)).toBeTruthy();
        });

        it("same multiple times", async () => {
            expect(stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection)).toBeTruthy();
            expect(stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection)).toBeFalsy();
            // The User ID is not relevant! Because for stats the call is needed and the user id is for monitoring
            expect(stats.addStatsCollector("CALL_ID", "SOME_OTHER_USER_ID", {} as RTCPeerConnection)).toBeFalsy();
        });
    });

    describe("remove stats collector", () => {
        it("existing one", async () => {
            expect(stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection)).toBeTruthy();
            expect(stats.removeStatsCollector("CALL_ID")).toBeTruthy();
        });
        it("not existing one", async () => {
            expect(stats.removeStatsCollector("CALL_ID_NOT_EXIST")).toBeFalsy();
        });
    });

    describe("get stats collector", () => {
        it("not existing", async () => {
            expect(stats.getStatsCollector("CALL_ID")).toBeUndefined();
        });

        it("existing", async () => {
            expect(stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection)).toBeTruthy();
            expect(stats.getStatsCollector("CALL_ID")).toBeDefined();
        });
    });

    describe("start", () => {
        beforeEach(() => {
            jest.useFakeTimers();
            window.setInterval = setInterval;
        });
        afterEach(() => {
            jest.useRealTimers();
            window.setInterval = setInterval;
        });

        it("without stats collectors", async () => {
            // @ts-ignore
            stats.processStats = jest.fn();
            stats.start();
            jest.advanceTimersByTime(TIME_INTERVAL);
            // @ts-ignore
            expect(stats.processStats).toHaveBeenCalled();
        });

        it("with stats collectors call collector", async () => {
            stats.addStatsCollector("CALL_ID", "USER_ID", {} as RTCPeerConnection);
            const collector = stats.getStatsCollector("CALL_ID");
            if (collector) {
                const processStatsSpy = jest.spyOn(collector, "processStats");
                stats.start();
                jest.advanceTimersByTime(TIME_INTERVAL);
                expect(processStatsSpy).toHaveBeenCalledWith(GROUP_CALL_ID, LOCAL_USER_ID);
            } else {
                throw new Error("Test failed, because no Collector found!");
            }
        });
    });
});
