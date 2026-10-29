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

import { MemberInfoMap } from "../../../src/models/member-info";

const ALICE_KEY = "@euEdVN1DimRHWErEnH3KVVNXduH3SiqMW7yMfO7qVOg";
const BOB_KEY = "@oG9tWFba7ul1sREui6GTYvJDW8qkoTAxMNWsIexIu-g";
const ALICE = "@alice:localhost";
const BOB = "@bob:localhost";

describe("MemberInfoMap", () => {
    it("is empty to start with, and resolves nothing", () => {
        const map = new MemberInfoMap();

        expect(map.isEmpty).toBe(true);
        // undefined, not null: no entry means the stable ID *is* the user ID.
        expect(map.getUserId(ALICE)).toBeUndefined();
        expect(map.getStableId(ALICE)).toBeUndefined();
    });

    describe("applyFull", () => {
        it("resolves stable IDs in both directions", () => {
            const map = new MemberInfoMap();

            const changed = map.applyFull({
                [ALICE_KEY]: { user_id: ALICE },
                [BOB_KEY]: { user_id: BOB },
            });

            expect(changed.sort()).toEqual([ALICE_KEY, BOB_KEY].sort());
            expect(map.isEmpty).toBe(false);
            expect(map.getUserId(ALICE_KEY)).toEqual(ALICE);
            expect(map.getUserId(BOB_KEY)).toEqual(BOB);
            expect(map.getStableId(ALICE)).toEqual(ALICE_KEY);
            expect(map.getStableId(BOB)).toEqual(BOB_KEY);
        });

        it("replaces rather than merges, and reports what it dropped", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE }, [BOB_KEY]: { user_id: BOB } });

            const changed = map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(changed).toEqual([BOB_KEY]);
            expect(map.getUserId(BOB_KEY)).toBeUndefined();
            expect(map.getStableId(BOB)).toBeUndefined();
            // Alice was in both maps with the same value, so she did not change.
            expect(map.getUserId(ALICE_KEY)).toEqual(ALICE);
        });

        it("clears the map when given nothing", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyFull()).toEqual([ALICE_KEY]);

            expect(map.isEmpty).toBe(true);
            expect(map.getStableId(ALICE)).toBeUndefined();
        });

        it("reports no change when the map is unchanged", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyFull({ [ALICE_KEY]: { user_id: ALICE } })).toEqual([]);
        });
    });

    describe("applyDelta", () => {
        it("adds entries without disturbing the rest", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyDelta({ [BOB_KEY]: { user_id: BOB } })).toEqual([BOB_KEY]);

            expect(map.getUserId(ALICE_KEY)).toEqual(ALICE);
            expect(map.getUserId(BOB_KEY)).toEqual(BOB);
        });

        it("reports no change when an entry repeats", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyDelta({ [ALICE_KEY]: { user_id: ALICE } })).toEqual([]);
        });

        it("does nothing when given nothing", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyDelta()).toEqual([]);
            expect(map.getUserId(ALICE_KEY)).toEqual(ALICE);
        });
    });

    describe("unresolvable members", () => {
        it("distinguishes an erased user from an absent entry", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: null } });

            expect(map.getUserId(ALICE_KEY)).toBeNull();
            expect(map.getUserId(BOB_KEY)).toBeUndefined();
        });

        it("drops the inverse entry when a user becomes unresolvable", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            expect(map.applyDelta({ [ALICE_KEY]: { user_id: null } })).toEqual([ALICE_KEY]);

            expect(map.getUserId(ALICE_KEY)).toBeNull();
            expect(map.getStableId(ALICE)).toBeUndefined();
        });

        it("does not leave a stale inverse entry when a key is reassigned", () => {
            const map = new MemberInfoMap();
            map.applyFull({ [ALICE_KEY]: { user_id: ALICE } });

            map.applyDelta({ [ALICE_KEY]: { user_id: BOB } });

            expect(map.getStableId(ALICE)).toBeUndefined();
            expect(map.getStableId(BOB)).toEqual(ALICE_KEY);
        });
    });

    describe("malformed input", () => {
        it.each([
            ["a missing entry", undefined],
            ["a null entry", null],
            ["a string entry", "@alice:localhost"],
        ])("ignores %s", (_name, entry) => {
            const map = new MemberInfoMap();

            expect(map.applyDelta({ [ALICE_KEY]: entry } as any)).toEqual([]);
            expect(map.getUserId(ALICE_KEY)).toBeUndefined();
        });

        it("treats a non-string user_id as unresolvable rather than trusting it", () => {
            const map = new MemberInfoMap();

            expect(map.applyDelta({ [ALICE_KEY]: { user_id: 42 } } as any)).toEqual([ALICE_KEY]);

            expect(map.getUserId(ALICE_KEY)).toBeNull();
        });
    });

    it("serialises to its wire form", () => {
        const map = new MemberInfoMap();
        map.applyFull({ [ALICE_KEY]: { user_id: ALICE }, [BOB_KEY]: { user_id: null } });

        expect(map.serialise()).toEqual({
            [ALICE_KEY]: { user_id: ALICE },
            [BOB_KEY]: { user_id: null },
        });
    });
});
