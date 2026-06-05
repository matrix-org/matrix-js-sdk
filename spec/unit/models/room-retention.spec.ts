/*
Copyright 2026 Element Creations Ltd.

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

import { type MockedObject } from "vitest";

import { EventType, type MatrixClient, MatrixEvent, Room, RoomEvent, RoomStateEvent } from "../../../src";
import type { RoomRetentionPolicy } from "../../../src/models/room-retention";
import { flushPromises } from "../../test-utils/flushPromises";

const ROOM_ID = "!room:example.org";
const USER_ID = "@user:example.org";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

describe("RoomRetentionPolicy", () => {
    let room: Room;
    let getCachedMock: ReturnType<typeof vi.fn>;
    let removeEventsFromRoom: ReturnType<typeof vi.fn>;
    let retentionPolicyUpdateHandler: (() => void) | undefined;
    let eventCounter = 0;

    function getPolicy(): RoomRetentionPolicy {
        return (room as unknown as { retention: RoomRetentionPolicy }).retention;
    }

    async function applyPolicy(): Promise<void> {
        retentionPolicyUpdateHandler!();
        await flushPromises();
    }

    function makeMessageEvent(ts: number, eventId = `$msg_${eventCounter++}`): MatrixEvent {
        return new MatrixEvent({
            type: "m.room.message",
            content: { body: "test" },
            event_id: eventId,
            sender: USER_ID,
            origin_server_ts: ts,
            room_id: ROOM_ID,
        });
    }

    function makeRetentionStateEvent(content: object, type = "m.room.retention"): MatrixEvent {
        return new MatrixEvent({
            type,
            state_key: "",
            content,
            event_id: `$retention_${type}`,
            room_id: ROOM_ID,
            sender: USER_ID,
            origin_server_ts: Date.now(),
        });
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        eventCounter = 0;
        retentionPolicyUpdateHandler = undefined;
        getCachedMock = vi.fn().mockResolvedValue(undefined);
        removeEventsFromRoom = vi.fn().mockResolvedValue(undefined);

        const mockClient = {
            supportsThreads: vi.fn().mockReturnValue(true),
            decryptEventIfNeeded: vi.fn().mockReturnThis(),
            getUserId: vi.fn().mockReturnValue(USER_ID),
            retentionPolicyService: {
                on: vi.fn((event: string, handler: () => void) => {
                    if (event === "update") retentionPolicyUpdateHandler = handler;
                }),
                getCached: getCachedMock,
            },
            store: { removeEventsFromRoom },
            // Enable retention so Room creates a RoomRetentionPolicy and addLiveEvents works
            _unstable_shouldApplyMessageRetention: true,
        } as unknown as MockedObject<MatrixClient>;

        room = new Room(ROOM_ID, mockClient, USER_ID);
        // Allow the constructor's void handleRetentionUpdate() call to complete
        await flushPromises();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("shouldEventBeRetained", () => {
        it("retains all events when no policy is set", () => {
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(true);
        });

        it("retains recent events within max_lifetime", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_WEEK_MS } } });
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 1000))).toBe(true);
        });

        it("does not retain events older than max_lifetime", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_WEEK_MS } } });
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - ONE_WEEK_MS - 1000))).toBe(false);
        });
    });

    describe("policy resolution", () => {
        it("applies no policy when there is no server or room state policy", () => {
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(true);
        });

        it("uses stable room state event (m.room.retention)", async () => {
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS })]);
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - ONE_DAY_MS - 1000))).toBe(false);
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 1000))).toBe(true);
        });

        it("uses unstable room state event (org.matrix.msc1763.retention)", async () => {
            room.currentState.setStateEvents([
                makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS }, "org.matrix.msc1763.retention"),
            ]);
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - ONE_DAY_MS - 1000))).toBe(false);
        });

        it("prefers unstable room state over stable when both are present", async () => {
            // unstable: 1 day, stable: 1 week — the unstable (shorter) policy should apply
            room.currentState.setStateEvents([
                makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS }, "org.matrix.msc1763.retention"),
                makeRetentionStateEvent({ max_lifetime: ONE_WEEK_MS }, "m.room.retention"),
            ]);
            await applyPolicy();

            // A 2-day-old event should be expired under the 1-day unstable policy
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 2 * ONE_DAY_MS))).toBe(false);
        });

        it("server room-specific policy overrides room state policy", async () => {
            // Room state says 1 day, server says 1 week for this specific room
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS })]);
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_WEEK_MS } } });
            await applyPolicy();

            // A 2-day-old event should be retained (server says 1 week)
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 2 * ONE_DAY_MS))).toBe(true);
            // An 8-day-old event should not be retained
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 8 * ONE_DAY_MS))).toBe(false);
        });

        it("uses server wildcard policy when no room-specific policy exists", async () => {
            getCachedMock.mockResolvedValue({ policies: { "*": { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - ONE_DAY_MS - 1000))).toBe(false);
        });

        it("clamps room state max_lifetime to server maximum limit", async () => {
            // Room says 1 week, server caps max at 1 day — effective policy is 1 day
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_WEEK_MS })]);
            getCachedMock.mockResolvedValue({ limits: { max_lifetime: { max: ONE_DAY_MS } } });
            await applyPolicy();

            // 2-day-old event should be expired (clamped down to 1 day)
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 2 * ONE_DAY_MS))).toBe(false);
        });

        it("clamps room state max_lifetime to server minimum limit", async () => {
            // Room says 1 day, server requires minimum 1 week — effective policy is 1 week
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS })]);
            getCachedMock.mockResolvedValue({ limits: { max_lifetime: { min: ONE_WEEK_MS } } });
            await applyPolicy();

            // A 2-day-old event should still be retained (clamped up to 1 week)
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - 2 * ONE_DAY_MS))).toBe(true);
        });

        it("uses server min limit when room state has no max_lifetime", async () => {
            // Room state exists but omits max_lifetime; server limit provides the fallback min
            room.currentState.setStateEvents([makeRetentionStateEvent({})]);
            getCachedMock.mockResolvedValue({ limits: { max_lifetime: { min: ONE_DAY_MS } } });
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(Date.now() - ONE_DAY_MS - 1000))).toBe(false);
        });
    });

    describe("processTimeline", () => {
        it("redacts expired events when policy is applied", async () => {
            const expiredEvent = makeMessageEvent(Date.now() - 2 * ONE_DAY_MS);
            await room.addLiveEvents([expiredEvent], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(redactSpy).toHaveBeenCalledOnce();
            const redactionArg = redactSpy.mock.calls[0][0];
            expect(redactionArg.getType()).toBe(EventType.RoomRedaction);
            expect(redactionArg.event.redacts).toBe(expiredEvent.getId());
            expect(redactionArg.getContent().reason).toBe("Retention policy");
        });

        it("does not redact non-expired events", async () => {
            await room.addLiveEvents([makeMessageEvent(Date.now() - 1000)], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_WEEK_MS } } });
            await applyPolicy();

            expect(redactSpy).not.toHaveBeenCalled();
        });

        it("only redacts expired events among a mixed set", async () => {
            const expiredEvent = makeMessageEvent(Date.now() - 2 * ONE_DAY_MS);
            const recentEvent = makeMessageEvent(Date.now() - 1000);
            await room.addLiveEvents([expiredEvent, recentEvent], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(redactSpy).toHaveBeenCalledOnce();
            expect(redactSpy.mock.calls[0][0].event.redacts).toBe(expiredEvent.getId());
        });

        it("calls removeEventsFromRoom for expired events", async () => {
            const expiredEvent = makeMessageEvent(Date.now() - 2 * ONE_DAY_MS);
            await room.addLiveEvents([expiredEvent], { addToState: false });

            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();
            await flushPromises(); // removeEventsFromRoom is fire-and-forget

            expect(removeEventsFromRoom).toHaveBeenCalledWith(ROOM_ID, [expiredEvent.getId()]);
        });

        it("does not include state events in expiry processing", async () => {
            const oldStateEvent = new MatrixEvent({
                type: "m.room.topic",
                state_key: "",
                content: { topic: "Old topic" },
                event_id: "$old_state",
                sender: USER_ID,
                origin_server_ts: 0,
                room_id: ROOM_ID,
            });
            room.currentState.setStateEvents([oldStateEvent]);

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const stateEventRedacted = redactSpy.mock.calls.some(
                ([call]) => call.event.redacts === oldStateEvent.getId(),
            );
            expect(stateEventRedacted).toBe(false);
        });

        it("schedules a future check for events that are not yet expired", async () => {
            const expiresIn = 1000; // event expires in ~1 second from now
            const soonToExpire = makeMessageEvent(Date.now() - ONE_DAY_MS + expiresIn);
            await room.addLiveEvents([soonToExpire], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(redactSpy).not.toHaveBeenCalled(); // not expired yet

            vi.advanceTimersByTime(expiresIn + 100);

            expect(redactSpy).toHaveBeenCalledOnce();
        });

        it("schedules next check based on the earliest-expiring event", async () => {
            const soonExpiry = 1000; // expires in 1 second
            const laterExpiry = ONE_DAY_MS / 2; // expires in 12 hours

            const soonToExpire = makeMessageEvent(Date.now() - ONE_DAY_MS + soonExpiry, "$soon");
            const laterToExpire = makeMessageEvent(Date.now() - ONE_DAY_MS + laterExpiry, "$later");
            // Deliberately add in descending timestamp order to expose sort dependency
            await room.addLiveEvents([laterToExpire, soonToExpire], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(redactSpy).not.toHaveBeenCalled();

            // Advance just past the sooner expiry (1.1 seconds)
            vi.advanceTimersByTime(soonExpiry + 100);

            // The earliest-expiring event should be processed
            expect(redactSpy).toHaveBeenCalledOnce();
            expect(redactSpy.mock.calls[0][0].event.redacts).toBe(soonToExpire.getId());
        });

        it("does not process timeline when no policy is active", async () => {
            await room.addLiveEvents([makeMessageEvent(0)], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            // No applyPolicy call — policy stays null
            vi.advanceTimersByTime(ONE_WEEK_MS);

            expect(redactSpy).not.toHaveBeenCalled();
        });
    });

    describe("event listener binding", () => {
        it("binds timeline listener when retention policy becomes active", async () => {
            const onSpy = vi.spyOn(room, "on");
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const timelineBindings = onSpy.mock.calls.filter(([event]) => event === RoomEvent.Timeline);
            expect(timelineBindings.length).toBe(1);
        });

        it("does not bind timeline listener when no retention policy", async () => {
            const onSpy = vi.spyOn(room, "on");
            // applyPolicy with undefined (no-op, already the default state from beforeEach)
            await applyPolicy();

            const timelineBindings = onSpy.mock.calls.filter(([event]) => event === RoomEvent.Timeline);
            expect(timelineBindings.length).toBe(0);
        });

        it("unbinds timeline listener when retention policy is removed", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const offSpy = vi.spyOn(room, "off");

            // Remove the policy
            getCachedMock.mockResolvedValue(undefined);
            await applyPolicy();

            const timelineUnbindings = offSpy.mock.calls.filter(([event]) => event === RoomEvent.Timeline);
            expect(timelineUnbindings.length).toBe(1);
        });
    });

    describe("reactivity", () => {
        it("recalculates policy when stable retention room state event changes", async () => {
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(true);

            // setStateEvents emits RoomStateEvent.Events internally
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS })]);
            await flushPromises();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(false);
        });

        it("recalculates policy when unstable retention room state event changes", async () => {
            room.currentState.setStateEvents([
                makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS }, "org.matrix.msc1763.retention"),
            ]);
            await flushPromises();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(false);
        });

        it("ignores irrelevant room state events", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const callsBefore = getCachedMock.mock.calls.length;

            const nameEvent = new MatrixEvent({
                type: "m.room.name",
                state_key: "",
                content: { name: "New Name" },
                event_id: "$name",
                room_id: ROOM_ID,
                sender: USER_ID,
            });
            room.emit(RoomStateEvent.Events, nameEvent, room.currentState, null);
            await flushPromises();

            expect(getCachedMock.mock.calls.length).toBe(callsBefore);
        });

        it("ignores retention state events with a non-empty state key", async () => {
            const callsBefore = getCachedMock.mock.calls.length;

            const nonEmptyKeyEvent = new MatrixEvent({
                type: "m.room.retention",
                state_key: "non_empty",
                content: { max_lifetime: ONE_DAY_MS },
                event_id: "$retention_non_empty",
                room_id: ROOM_ID,
                sender: USER_ID,
            });
            room.emit(RoomStateEvent.Events, nonEmptyKeyEvent, room.currentState, null);
            await flushPromises();

            expect(getCachedMock.mock.calls.length).toBe(callsBefore);
        });

        it("recalculates policy on global retention service update", async () => {
            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(true);

            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            expect(getPolicy().shouldEventBeRetained(makeMessageEvent(0))).toBe(false);
        });

        it("re-processes timeline when policy becomes active via state event", async () => {
            const expiredEvent = makeMessageEvent(Date.now() - 2 * ONE_DAY_MS);
            await room.addLiveEvents([expiredEvent], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");

            // setStateEvents emits RoomStateEvent.Events internally, triggering recalculation
            room.currentState.setStateEvents([makeRetentionStateEvent({ max_lifetime: ONE_DAY_MS })]);
            await flushPromises();

            expect(redactSpy).toHaveBeenCalledOnce();
            expect(redactSpy.mock.calls[0][0].event.redacts).toBe(expiredEvent.getId());
        });
    });

    describe("timeline update debouncing", () => {
        it("processes timeline after the 200ms debounce following a timeline update", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const recentEvent = makeMessageEvent(Date.now() - 1000);
            // addLiveEvents will trigger the RoomEvent.Timeline listener (bound now that policy is active)
            await room.addLiveEvents([recentEvent], { addToState: false });

            const redactSpy = vi.spyOn(room, "tryApplyRedaction");

            // Nothing should fire before the 200ms debounce
            vi.advanceTimersByTime(199);
            expect(redactSpy).not.toHaveBeenCalled();

            // After 200ms the debounce fires and processTimeline runs
            vi.advanceTimersByTime(1);
            expect(redactSpy).not.toHaveBeenCalled(); // event is not expired
        });

        it("debounces multiple rapid timeline updates into a single processing pass", async () => {
            getCachedMock.mockResolvedValue({ policies: { [ROOM_ID]: { max_lifetime: ONE_DAY_MS } } });
            await applyPolicy();

            const recentEvent = makeMessageEvent(Date.now() - 1000);

            // Emit several rapid timeline update events (simulating a burst of live events)
            for (let i = 0; i < 5; i++) {
                room.emit(RoomEvent.Timeline, recentEvent, room, undefined, false, { liveEvent: true });
            }
            await flushPromises();

            // Only one timer should be pending; advance past the debounce
            const redactSpy = vi.spyOn(room, "tryApplyRedaction");
            vi.advanceTimersByTime(200);

            // processTimeline ran once; no expired events
            expect(redactSpy).not.toHaveBeenCalled();
        });
    });
});
ime(200);

            // processTimeline ran once; no expired events
            expect(redactSpy).not.toHaveBeenCalled();
        });
    });
});
