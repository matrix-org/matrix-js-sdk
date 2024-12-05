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

import { isLivekitFocus, isLivekitFocusActive, isLivekitFocusConfig } from "../../../src/matrixrtc/LivekitFocus";

describe("LivekitFocus", () => {
    it("isLivekitFocus", () => {
        expect(
            isLivekitFocus({
                type: "livekit",
                livekit_service_url: "http://test.com",
                livekit_alias: "test",
            }),
        ).toBeTruthy();
        expect(isLivekitFocus({ type: "livekit" })).toBeFalsy();
        expect(
            isLivekitFocus({ type: "not-livekit", livekit_service_url: "http://test.com", livekit_alias: "test" }),
        ).toBeFalsy();
        expect(
            isLivekitFocus({ type: "livekit", other_service_url: "http://test.com", livekit_alias: "test" }),
        ).toBeFalsy();
        expect(
            isLivekitFocus({ type: "livekit", livekit_service_url: "http://test.com", other_alias: "test" }),
        ).toBeFalsy();
    });
    it("isLivekitFocusActive", () => {
        expect(
            isLivekitFocusActive({
                type: "livekit",
                focus_selection: "oldest_membership",
            }),
        ).toBeTruthy();
        expect(isLivekitFocusActive({ type: "livekit" })).toBeFalsy();
        expect(isLivekitFocusActive({ type: "not-livekit", focus_selection: "oldest_membership" })).toBeFalsy();
    });
    it("isLivekitFocusConfig", () => {
        expect(
            isLivekitFocusConfig({
                type: "livekit",
                livekit_service_url: "http://test.com",
            }),
        ).toBeTruthy();
        expect(isLivekitFocusConfig({ type: "livekit" })).toBeFalsy();
        expect(isLivekitFocusConfig({ type: "not-livekit", livekit_service_url: "http://test.com" })).toBeFalsy();
        expect(isLivekitFocusConfig({ type: "livekit", other_service_url: "oldest_membership" })).toBeFalsy();
    });
});
