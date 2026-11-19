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

import {
    isLivekitFocusSelection,
    isLivekitTransport,
    isUnstableLivekitTransport,
    isUnstableLivekitTransportWithUrl,
    selectLivekitTransport,
} from "../../../src/matrixrtc/LivekitTransport";

describe("LivekitTransport", () => {
    it("isLivekitFocusActive", () => {
        expect(
            isLivekitFocusSelection({
                type: "livekit",
                focus_selection: "multi_sfu",
            }),
        ).toBeTruthy();
        expect(isLivekitFocusSelection({ type: "livekit" })).toBeFalsy();
        expect(isLivekitFocusSelection({ type: "not-livekit", focus_selection: "multi_sfu" })).toBeFalsy();
    });
    it("isLivekitTransport", () => {
        expect(isLivekitTransport(0)).toBeFalsy();
        expect(isLivekitTransport(null)).toBeFalsy();
        expect(
            isLivekitTransport({
                type: "livekit",
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(isLivekitTransport({ type: "livekit" })).toBeFalsy();
        expect(isLivekitTransport({ type: "not-livekit", livekit_service_url: "http://test.com" })).toBeFalsy();
        expect(isLivekitTransport({ type: "livekit", other_service_url: "multi_sfu" })).toBeFalsy();
        expect(isLivekitTransport({ type: "livekit", livekit_service_url: 3 })).toBeFalsy();
    });
    it.each(["livekit", "m.livekit"])("isUnstableLivekitTransport with %s type", (type) => {
        expect(isUnstableLivekitTransport(0)).toBeFalsy();
        expect(isUnstableLivekitTransport(null)).toBeFalsy();
        expect(
            isUnstableLivekitTransport({
                type,
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(
            isUnstableLivekitTransport({
                type,
                url: "ws://test.com",
            }),
        ).toBeTruthy();
        expect(
            isUnstableLivekitTransport({
                type,
                url: "ws://test.com",
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(isUnstableLivekitTransport({ type })).toBeFalsy();
        expect(isUnstableLivekitTransport({ type: "not-livekit", livekit_service_url: "http://test.com" })).toBeFalsy();
        expect(isUnstableLivekitTransport({ type, other_service_url: "multi_sfu" })).toBeFalsy();
        expect(isUnstableLivekitTransport({ type, livekit_service_url: 3 })).toBeFalsy();
        expect(isUnstableLivekitTransport({ type, url: 4 })).toBeFalsy();
    });
    it("isUnstableLivekitTransport with server_name", () => {
        expect(
            isUnstableLivekitTransport({
                type: "livekit",
                url: "ws://test.com",
                server_name: "test.com",
            }),
        ).toBeTruthy();
        expect(
            isUnstableLivekitTransport({
                type: "livekit",
                url: "ws://test.com",
                livekit_service_url: "http://test.com",
                server_name: "test.com",
            }),
        ).toBeTruthy();
        // server_name must be a string
        expect(isUnstableLivekitTransport({ type: "livekit", url: "ws://test.com", server_name: 5 })).toBeFalsy();
        // server_name is meaningless without a url
        expect(
            isUnstableLivekitTransport({
                type: "livekit",
                livekit_service_url: "http://test.com",
                server_name: "test.com",
            }),
        ).toBeFalsy();
    });
    it("isUnstableLivekitTransportWithUrl", () => {
        expect(isUnstableLivekitTransportWithUrl(null)).toBeFalsy();
        expect(isUnstableLivekitTransportWithUrl({ type: "livekit", url: "ws://test.com" })).toBeTruthy();
        expect(
            isUnstableLivekitTransportWithUrl({
                type: "livekit",
                url: "ws://test.com",
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(
            isUnstableLivekitTransportWithUrl({ type: "livekit", livekit_service_url: "http://test.com" }),
        ).toBeFalsy();
        expect(isUnstableLivekitTransportWithUrl({ type: "livekit", url: 4 })).toBeFalsy();
    });
    describe("selectLivekitTransport", () => {
        const livekit = { type: "livekit", url: "ws://legacy.test.com" };
        const mLivekit = { type: "m.livekit", url: "ws://test.com" };
        const other = { type: "not-livekit" };

        it("prefers the m.livekit transport", () => {
            expect(selectLivekitTransport([other, livekit, mLivekit])).toBe(mLivekit);
        });
        it("falls back to the livekit transport", () => {
            expect(selectLivekitTransport([other, livekit])).toBe(livekit);
        });
        it("skips invalid LiveKit transports", () => {
            expect(selectLivekitTransport([{ type: "m.livekit" }, livekit])).toBe(livekit);
        });
        it("returns undefined without a LiveKit transport", () => {
            expect(selectLivekitTransport([other])).toBeUndefined();
            expect(selectLivekitTransport([])).toBeUndefined();
        });
    });
});
