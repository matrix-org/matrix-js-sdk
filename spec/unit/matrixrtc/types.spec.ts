/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { type CallMembership } from "../../../src/matrixrtc";
import { isMyMembership, parseCallNotificationContent } from "../../../src/matrixrtc/types";

describe("types", () => {
    describe("isMyMembership", () => {
        it("returns false if userId is different", () => {
            expect(
                isMyMembership(
                    { sender: "@alice:example.org", deviceId: "DEVICE" } as CallMembership,
                    "@bob:example.org",
                    "DEVICE",
                ),
            ).toBe(false);
        });
        it("returns true if userId and device is the same", () => {
            expect(
                isMyMembership(
                    { sender: "@alice:example.org", deviceId: "DEVICE" } as CallMembership,
                    "@alice:example.org",
                    "DEVICE",
                ),
            ).toBe(true);
        });
    });
});

describe("IRTCNotificationContent", () => {
    const validBase = Object.freeze({
        "m.mentions": { user_ids: [], room: true },
        "notification_type": "notification",
        "sender_ts": 123,
        "lifetime": 1000,
    });

    it("parses valid content", () => {
        const res = parseCallNotificationContent({ ...validBase });
        expect(res).toMatchObject(validBase);
    });

    it("caps lifetime to 90000ms", () => {
        const res = parseCallNotificationContent({ ...validBase, lifetime: 130000 });
        expect(res.lifetime).toBe(90000);
    });

    it("throws on malformed m.mentions", () => {
        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                "m.mentions": "not an object",
            } as any),
        ).toThrow("malformed m.mentions");
    });

    it("throws on missing or invalid notification_type", () => {
        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                notification_type: undefined,
            } as any),
        ).toThrow("Missing or invalid notification_type");

        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                notification_type: 123 as any,
            } as any),
        ).toThrow("Missing or invalid notification_type");
    });

    it("throws on missing or invalid sender_ts", () => {
        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                sender_ts: undefined,
            } as any),
        ).toThrow("Missing or invalid sender_ts");

        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                sender_ts: "123" as any,
            } as any),
        ).toThrow("Missing or invalid sender_ts");
    });

    it("throws on missing or invalid lifetime", () => {
        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                lifetime: undefined,
            } as any),
        ).toThrow("Missing or invalid lifetime");

        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                lifetime: "1000" as any,
            } as any),
        ).toThrow("Missing or invalid lifetime");
    });

    it("accepts valid relation (m.reference)", () => {
        // Note: parseCallNotificationContent currently checks `relation.rel_type` rather than `m.relates_to`.
        const res = parseCallNotificationContent({
            ...validBase,
            relation: { rel_type: "m.reference", event_id: "$ev" },
        } as any);
        expect(res).toBeTruthy();
    });

    it("throws on invalid relation rel_type", () => {
        expect(() =>
            parseCallNotificationContent({
                ...validBase,
                relation: { rel_type: "m.annotation", event_id: "$ev" },
            } as any),
        ).toThrow("Invalid relation");
    });
});
