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

import { isLivekitFocusSelection, isLivekitTransport } from "../../../src/matrixrtc/LivekitTransport";

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
        expect(
            isLivekitTransport({
                type: "livekit",
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(
            isLivekitTransport({
                type: "livekit",
                url: "ws://test.com",
            }),
        ).toBeTruthy();
        expect(isLivekitTransport({ type: "livekit" })).toBeFalsy();
        expect(isLivekitTransport({ type: "not-livekit", livekit_service_url: "http://test.com" })).toBeFalsy();
        expect(isLivekitTransport({ type: "livekit", other_service_url: "multi_sfu" })).toBeFalsy();
        expect(isLivekitTransport({ type: "livekit", livekit_service_url: 3 })).toBeFalsy();
        expect(isLivekitTransport({ type: "livekit", url: 4 })).toBeFalsy();
    });
});
