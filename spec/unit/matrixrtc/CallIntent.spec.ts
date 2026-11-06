/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { toStableCallIntent, toUnstableCallIntent } from "../../../src/matrixrtc/CallIntent.ts";

describe("CallIntent", () => {
    describe("toStableCallIntent", () => {
        it.each([
            ["audio", "m.audio"],
            ["video", "m.video"],
            ["m.audio", "m.audio"],
            ["m.video", "m.video"],
            ["custom", "custom"],
            ["", ""],
            [undefined, undefined],
        ])("maps %s to %s", (input, output) => {
            expect(toStableCallIntent(input)).toBe(output);
        });
    });

    describe("toUnstableCallIntent", () => {
        it.each([
            ["m.audio", "audio"],
            ["m.video", "video"],
            ["audio", "audio"],
            ["video", "video"],
            ["custom", "custom"],
            ["", ""],
            [undefined, undefined],
        ])("maps %s to %s", (input, output) => {
            expect(toUnstableCallIntent(input)).toBe(output);
        });
    });
});
