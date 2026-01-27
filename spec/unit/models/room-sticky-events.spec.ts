import { type Mock } from "vitest";

import { type IStickyEvent, MatrixEvent } from "../../../src";
import { RoomStickyEventsStore, RoomStickyEventsEvent } from "../../../src/models/room-sticky-events";

describe("RoomStickyEvents", () => {
    let stickyEvents: RoomStickyEventsStore;
    const emitSpy: Mock = vi.fn();
    const stickyEvent: IStickyEvent = {
        event_id: "$foo:bar",
        room_id: "!roomId",
        type: "org.example.any_type",
        msc4354_sticky: {
            duration_ms: 15000,
        },
        content: {
            msc4354_sticky_key: "foobar",
        },
        sender: "@alice:example.org",
        origin_server_ts: Date.now(),
        unsigned: {},
    };

    beforeEach(() => {
        emitSpy.mockReset();
        stickyEvents = new RoomStickyEventsStore();
        stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
    });

    afterEach(() => {
        stickyEvents?.clear();
    });

    describe("addStickyEvents", () => {
        it("should allow adding an event without a msc4354_sticky_key", () => {
            stickyEvents.addStickyEvents([new MatrixEvent({ ...stickyEvent, content: {} })]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(1);
        });
        it("should not allow adding an event without a msc4354_sticky property", () => {
            stickyEvents.addStickyEvents([new MatrixEvent({ ...stickyEvent, msc4354_sticky: undefined })]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
            stickyEvents.addStickyEvents([
                new MatrixEvent({ ...stickyEvent, msc4354_sticky: { duration_ms: undefined } as any }),
            ]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
        });
        it("should not allow adding an event without a sender", () => {
            stickyEvents.addStickyEvents([new MatrixEvent({ ...stickyEvent, sender: undefined })]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
        });
        it("should not allow adding an event with an invalid sender", () => {
            stickyEvents.addStickyEvents([new MatrixEvent({ ...stickyEvent, sender: "not_a_real_sender" })]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
        });
        it("should ignore old events", () => {
            stickyEvents.addStickyEvents([
                new MatrixEvent({ ...stickyEvent, origin_server_ts: 0, msc4354_sticky: { duration_ms: 1 } }),
            ]);
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
        });
        it("should be able to just add an event", () => {
            const originalEv = new MatrixEvent({ ...stickyEvent });
            stickyEvents.addStickyEvents([originalEv]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([originalEv]);
        });
        it("should not replace events on ID tie break", () => {
            const originalEv = new MatrixEvent({ ...stickyEvent });
            stickyEvents.addStickyEvents([originalEv]);
            stickyEvents.addStickyEvents([
                new MatrixEvent({
                    ...stickyEvent,
                    event_id: "$abc:bar",
                }),
            ]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([originalEv]);
        });
        it("should not replace a newer event with an older event", () => {
            const originalEv = new MatrixEvent({ ...stickyEvent });
            stickyEvents.addStickyEvents([originalEv]);
            stickyEvents.addStickyEvents([
                new MatrixEvent({
                    ...stickyEvent,
                    origin_server_ts: 1,
                }),
            ]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([originalEv]);
        });
        it("should replace an older event with a newer event", () => {
            const originalEv = new MatrixEvent({ ...stickyEvent, event_id: "$old" });
            const newerEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$new",
                origin_server_ts: Date.now() + 2000,
            });
            stickyEvents.addStickyEvents([originalEv]);
            stickyEvents.addStickyEvents([newerEv]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([newerEv]);
            expect(emitSpy).toHaveBeenCalledWith([], [{ current: newerEv, previous: originalEv }], []);
        });
        it("should allow multiple events with the same sticky key for different event types", () => {
            const originalEv = new MatrixEvent({ ...stickyEvent });
            const anotherEv = new MatrixEvent({
                ...stickyEvent,
                type: "org.example.another_type",
            });
            stickyEvents.addStickyEvents([originalEv, anotherEv]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([originalEv, anotherEv]);
        });

        it("should emit when a new sticky event is added", () => {
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents.addStickyEvents([ev]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], [], []);
        });
        it("should emit when a new unkeyed sticky event is added", () => {
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
            });
            stickyEvents.addStickyEvents([ev]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], [], []);
        });
    });

    describe("getStickyEvents", () => {
        it("should have zero sticky events", () => {
            expect([...stickyEvents.getStickyEvents()]).toHaveLength(0);
        });
        it("should contain a sticky event", () => {
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents.addStickyEvents([ev]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev]);
        });
        it("should contain two sticky events", () => {
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            const ev2 = new MatrixEvent({
                ...stickyEvent,
                sender: "@fibble:bobble",
                content: {
                    msc4354_sticky_key: "bibble",
                },
            });
            stickyEvents.addStickyEvents([ev, ev2]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev, ev2]);
        });
    });

    describe("getKeyedStickyEvent", () => {
        it("should have zero sticky events", () => {
            expect(
                stickyEvents.getKeyedStickyEvent(
                    stickyEvent.sender,
                    stickyEvent.type,
                    stickyEvent.content.msc4354_sticky_key!,
                ),
            ).toBeUndefined();
        });
        it("should return a sticky event", () => {
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents.addStickyEvents([ev]);
            expect(
                stickyEvents.getKeyedStickyEvent(
                    stickyEvent.sender,
                    stickyEvent.type,
                    stickyEvent.content.msc4354_sticky_key!,
                ),
            ).toEqual(ev);
        });
    });

    describe("getUnkeyedStickyEvent", () => {
        it("should have zero sticky events", () => {
            expect(stickyEvents.getUnkeyedStickyEvent(stickyEvent.sender, stickyEvent.type)).toEqual([]);
        });
        it("should return a sticky event", () => {
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {
                    msc4354_sticky_key: undefined,
                },
            });
            stickyEvents.addStickyEvents([ev]);
            expect(stickyEvents.getUnkeyedStickyEvent(stickyEvent.sender, stickyEvent.type)).toEqual([ev]);
        });
    });

    describe("cleanExpiredStickyEvents", () => {
        beforeAll(() => {
            vi.useFakeTimers();
        });
        afterAll(() => {
            vi.useRealTimers();
        });

        it("should emit when a sticky event expires", () => {
            vi.setSystemTime(1000);
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: 0,
            });
            const evLater = new MatrixEvent({
                ...stickyEvent,
                event_id: "$baz:bar",
                sender: "@bob:example.org",
                origin_server_ts: 1000,
            });
            stickyEvents.addStickyEvents([ev, evLater]);
            const emitSpy = vi.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            vi.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [], [ev]);
            // Then expire the next event
            vi.advanceTimersByTime(1000);
            expect(emitSpy).toHaveBeenCalledWith([], [], [evLater]);
        });
        it("should emit two events when both expire at the same time", () => {
            const emitSpy = vi.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            vi.setSystemTime(0);
            const ev1 = new MatrixEvent({
                ...stickyEvent,
                event_id: "$eventA",
                origin_server_ts: 0,
            });
            const ev2 = new MatrixEvent({
                ...stickyEvent,
                event_id: "$eventB",
                content: {
                    msc4354_sticky_key: "key_2",
                },
                origin_server_ts: 0,
            });
            stickyEvents.addStickyEvents([ev1, ev2]);
            expect(emitSpy).toHaveBeenCalledWith([ev1, ev2], [], []);
            vi.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [], [ev1, ev2]);
        });
        it("should emit when a unkeyed sticky event expires", () => {
            const emitSpy = vi.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            vi.setSystemTime(0);
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            vi.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [], [ev]);
        });
    });

    describe("handleRedaction", () => {
        beforeAll(() => {
            vi.useFakeTimers();
        });
        afterAll(() => {
            vi.useRealTimers();
        });
        it("should not emit if the event does not exist in the map", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            stickyEvents.handleRedaction("$123456");
            expect(emitSpy).not.toHaveBeenCalled();
        });
        it("should emit a remove when the event exists in the map without a predecessor", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            stickyEvents.handleRedaction(stickyEvent.event_id);
            expect(emitSpy).toHaveBeenCalledWith([], [], [ev]);
        });
        it("should emit a remove when the event has no sticky key", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            stickyEvents.handleRedaction(stickyEvent.event_id);
            expect(emitSpy).toHaveBeenCalledWith([], [], [ev]);
        });
        it("should emit an update when the event exists in the map with a predecessor", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            vi.advanceTimersByTime(1000); // Advance time so we can insert a newer event.
            const newerEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newer-ev",
                origin_server_ts: Date.now() + 1000,
            });
            stickyEvents.addStickyEvents([ev, newerEv]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            stickyEvents.handleRedaction(newerEv.getId()!);
            expect(emitSpy).toHaveBeenCalledWith([], [{ current: ev, previous: newerEv }], []);
        });
        it("should emit a remove if the previous event has expired", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            vi.advanceTimersByTime(1000); // Advance time so we can insert a newer event.
            const newerEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newer-ev",
                origin_server_ts: Date.now() + 1000,
            });
            stickyEvents.addStickyEvents([ev, newerEv]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            // Expire the older event.
            vi.advanceTimersByTime(stickyEvent.msc4354_sticky.duration_ms);
            // Redact the newer event
            stickyEvents.handleRedaction(newerEv.getId()!);
            expect(emitSpy).toHaveBeenCalledWith([], [], [newerEv]);
        });
        it("should recurse the chain of events if the previous event has been redacted", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            vi.advanceTimersByTime(1000); // Advance time so we can insert a newer event.
            const middleEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newer-ev",
                origin_server_ts: Date.now() + 1000,
            });
            vi.advanceTimersByTime(1000);
            const newestEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newest-ev",
                origin_server_ts: Date.now() + 2000,
            });
            stickyEvents.addStickyEvents([ev, middleEv, newestEv]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            // Mark the middle event as redacted.
            middleEv.setUnsigned({
                redacted_because: {
                    event_id: "$foo",
                } as any,
            });
            // Redact the newer event
            stickyEvents.handleRedaction(newestEv.getId()!);
            // expect immediate transition from newestEv -> ev and skipping middleEv
            expect(emitSpy).toHaveBeenCalledWith([], [{ current: ev, previous: newestEv }], []);
        });
        it("should revert to the most recent valid event regardless of insertion order", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            vi.advanceTimersByTime(1000); // Advance time so we can insert a newer event.
            const middleEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newer-ev",
                origin_server_ts: Date.now() + 1000,
            });
            vi.advanceTimersByTime(1000);
            const newestEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newest-ev",
                origin_server_ts: Date.now() + 2000,
            });
            // Invert in reverse order, to make sure we retain the older events.
            stickyEvents.addStickyEvents([newestEv, middleEv, ev]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            // Mark the middle event as redacted.
            middleEv.setUnsigned({
                redacted_because: {
                    event_id: "$foo",
                } as any,
            });
            // Redact the newer event
            stickyEvents.handleRedaction(newestEv.getId()!);
            expect(emitSpy).toHaveBeenCalledWith([], [{ current: ev, previous: newestEv }], []);
        });
        it("should handle redaction when using `handleRedaction` with a `MatrixEvent` parameter", () => {
            const emitSpy = vi.fn();
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            vi.advanceTimersByTime(1000); // Advance time so we can insert a newer event.
            const newerEv = new MatrixEvent({
                ...stickyEvent,
                event_id: "$newer-ev",
                origin_server_ts: Date.now() + 1000,
            });
            stickyEvents.addStickyEvents([ev, newerEv]);
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            stickyEvents.handleRedaction(newerEv);
            expect(emitSpy).toHaveBeenCalledWith([], [{ current: ev, previous: newerEv }], []);
        });
    });
});
