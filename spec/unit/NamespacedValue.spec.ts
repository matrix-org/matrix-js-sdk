/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { NamespacedValue, UnstableValue } from "../../src/NamespacedValue";

describe("NamespacedValue", () => {
    it("should prefer stable over unstable", () => {
        const ns = new NamespacedValue("stable", "unstable");
        expect(ns.name).toBe(ns.stable);
        expect(ns.altName).toBe(ns.unstable);
    });

    it("should return unstable if there is no stable", () => {
        const ns = new NamespacedValue(null, "unstable");
        expect(ns.name).toBe(ns.unstable);
        expect(ns.altName).toBeFalsy();
    });

    it("should have a falsey unstable if needed", () => {
        const ns = new NamespacedValue("stable", null);
        expect(ns.name).toBe(ns.stable);
        expect(ns.altName).toBeFalsy();
    });

    it("should match against either stable or unstable", () => {
        const ns = new NamespacedValue("stable", "unstable");
        expect(ns.matches("no")).toBe(false);
        expect(ns.matches(ns.stable)).toBe(true);
        expect(ns.matches(ns.unstable)).toBe(true);
    });

    it("should not permit falsey values for both parts", () => {
        try {
            new UnstableValue(null, null);
            // noinspection ExceptionCaughtLocallyJS
            throw new Error("Failed to fail");
        } catch (e) {
            expect(e.message).toBe("One of stable or unstable values must be supplied");
        }
    });
});

describe("UnstableValue", () => {
    it("should prefer unstable over stable", () => {
        const ns = new UnstableValue("stable", "unstable");
        expect(ns.name).toBe(ns.unstable);
        expect(ns.altName).toBe(ns.stable);
    });

    it("should return unstable if there is no stable", () => {
        const ns = new UnstableValue(null, "unstable");
        expect(ns.name).toBe(ns.unstable);
        expect(ns.altName).toBeFalsy();
    });

    it("should not permit falsey unstable values", () => {
        try {
            new UnstableValue("stable", null);
            // noinspection ExceptionCaughtLocallyJS
            throw new Error("Failed to fail");
        } catch (e) {
            expect(e.message).toBe("Unstable value must be supplied");
        }
    });
});
