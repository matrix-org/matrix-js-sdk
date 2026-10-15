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

/**
 * The key under which a room's stable ID -> user ID mapping is served.
 *
 * @see https://github.com/matrix-org/matrix-spec-proposals/pull/4428
 */
export const MEMBER_INFO_FIELD = "org.matrix.msc4428.member_info";

/**
 * The grammar of a member key (MSC4430): `@` followed by 43 url-safe base64 characters.
 * A user ID can never match it, as it always contains a `:`.
 */
const MEMBER_KEY_PATTERN = /^@[A-Za-z0-9_-]{43}$/;

/**
 * Is this stable ID a member key rather than a user ID?
 *
 * Deliberately strict: anything which is not recognisably a member key is treated as a
 * user ID, which is what every room without member keys contains.
 */
export function isMemberKey(id: string): boolean {
    return MEMBER_KEY_PATTERN.test(id);
}

/**
 * The wire form of a single entry in a `member_info` map: the server's current
 * claim about which user is behind a stable ID.
 */
export interface MemberInfoEntry {
    /**
     * The user ID of the room member, or `null` if the server cannot name one
     * (the user has been erased, or the claim comes from a server we cannot verify).
     */
    user_id: string | null;
}

/**
 * The wire form of a `member_info` map, keyed by stable ID.
 *
 * @see https://github.com/matrix-org/matrix-spec-proposals/pull/4428
 */
export type MemberInfoMapContent = Record<string, MemberInfoEntry>;

/**
 * Per-room mapping between the stable IDs that identify room members on the wire
 * (MSC4428) and the user IDs behind them.
 *
 * A stable ID is an opaque identifier for a *room member*. Today it is usually the
 * member's user ID, in which case the server omits the mapping entirely; in a room
 * with member keys (MSC4430) it is the member's key and the mapping is always sent.
 *
 * Three outcomes are distinguished when resolving a stable ID:
 *
 *  * a string — the server named a user;
 *  * `null` — the server has an entry but cannot name a user (erased, or unverified);
 *  * `undefined` — there is no entry at all, which per MSC4428 means the stable ID
 *    *is* the user ID. This is the ordinary case in rooms without member keys.
 *
 * Instances are shared by reference between a {@link Room} and every {@link RoomState}
 * belonging to it (including clones made on timeline resets), so that there is a single
 * source of truth for the mapping.
 */
export class MemberInfoMap {
    /** stable ID -> user ID, or null where the server cannot name a user. */
    private forward = new Map<string, string | null>();
    /** user ID -> stable ID, the inverse of the resolvable entries of {@link forward}. */
    private inverse = new Map<string, string>();

    /**
     * Replace the entire mapping, as sent on an initial sync or by `/members`.
     *
     * @param content - The `member_info` map from the server. Omitted or empty clears the map.
     * @returns The stable IDs whose resolved user ID changed as a result.
     */
    public applyFull(content?: MemberInfoMapContent): string[] {
        const previous = this.forward;

        this.forward = new Map();
        this.inverse = new Map();
        for (const stableId of Object.keys(content ?? {})) {
            this.setEntry(stableId, content![stableId]);
        }

        // Diff against what we held before: an entry which survived unchanged is not a
        // change, and one which is gone from the new map is. Values are `string | null`,
        // so a missing key reads back as `undefined` and compares unequal to both.
        const changed = new Set<string>();
        for (const [stableId, userId] of previous) {
            if (this.forward.get(stableId) !== userId) changed.add(stableId);
        }
        for (const [stableId, userId] of this.forward) {
            if (previous.get(stableId) !== userId) changed.add(stableId);
        }

        return [...changed];
    }

    /**
     * Merge a set of changed entries into the mapping, as sent on an incremental sync.
     *
     * @param content - The `member_info` delta from the server.
     * @returns The stable IDs whose resolved user ID changed as a result.
     */
    public applyDelta(content?: MemberInfoMapContent): string[] {
        const changed: string[] = [];
        for (const stableId of Object.keys(content ?? {})) {
            if (this.setEntry(stableId, content![stableId])) changed.push(stableId);
        }
        return changed;
    }

    /**
     * Record the server's signed `localpart`/`domain` claim from a member event as a
     * mapping, but only where the authoritative `member_info` says nothing.
     *
     * An invited room is served as stripped state with no `member_info` at all, so the
     * claim is the only thing naming its members. A real mapping always wins: this never
     * overwrites an existing entry, including an explicit `null`.
     *
     * @returns true if an entry was added.
     */
    public applyClaim(stableId: string, userId: string): boolean {
        if (this.forward.has(stableId)) return false;
        return this.setEntry(stableId, { user_id: userId });
    }

    /**
     * Write a single entry, keeping the inverse index consistent.
     *
     * @returns true if the resolved user ID for this stable ID changed.
     */
    private setEntry(stableId: string, entry: MemberInfoEntry | undefined): boolean {
        // Be defensive: this is server-supplied data and the map is used for identity.
        if (typeof entry !== "object" || entry === null) return false;
        const userId = typeof entry.user_id === "string" ? entry.user_id : null;

        const previous = this.forward.get(stableId);
        if (this.forward.has(stableId) && previous === userId) return false;

        if (typeof previous === "string" && this.inverse.get(previous) === stableId) {
            this.inverse.delete(previous);
        }
        this.forward.set(stableId, userId);
        if (userId !== null) this.inverse.set(userId, stableId);

        return previous !== userId;
    }

    /**
     * Resolve a stable ID to the user ID behind it.
     *
     * @param stableId - The stable ID of a room member.
     * @returns The user ID; `null` if the server has an entry but cannot name a user;
     *     `undefined` if there is no entry, meaning the stable ID is itself the user ID.
     */
    public getUserId(stableId: string): string | null | undefined {
        return this.forward.get(stableId);
    }

    /**
     * Find the stable ID of the member who is the given user.
     *
     * @param userId - The user ID to look up.
     * @returns The stable ID, or `undefined` if no member of the room resolves to this user.
     *     Note that in a room without member keys there is no mapping at all, so this returns
     *     `undefined` even for members of the room: callers should fall back to the user ID.
     */
    public getStableId(userId: string): string | undefined {
        return this.inverse.get(userId);
    }

    /**
     * @returns true if the map holds no entries, i.e. every stable ID resolves to itself.
     */
    public get isEmpty(): boolean {
        return this.forward.size === 0;
    }

    /**
     * @returns the map in its wire form, for persistence.
     */
    public serialise(): MemberInfoMapContent {
        const content: MemberInfoMapContent = {};
        for (const [stableId, userId] of this.forward) {
            content[stableId] = { user_id: userId };
        }
        return content;
    }
}
