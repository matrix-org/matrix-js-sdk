import { type IEvent, MatrixEvent } from "../../../src";
import { RoomStickyEventsStore, RoomStickyEventsEvent } from "../../../src/models/room-sticky-events";

describe("RoomStickyEvents", () => {
    let stickyEvents: RoomStickyEventsStore;
    const stickyEvent: IEvent = {
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
        stickyEvents = new RoomStickyEventsStore();
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
        it("should not replace newer events", () => {
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
    });

    describe("_unstable_addStickyEvents(", () => {
        it("should emit when a new sticky event is added", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents.addStickyEvents([ev]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], []);
        });
        it("should emit when a new unketed sticky event is added", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
            });
            stickyEvents.addStickyEvents([ev]);
            expect([...stickyEvents.getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], []);
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

    describe("cleanExpiredStickyEvents", () => {
        beforeAll(() => {
            jest.useFakeTimers();
        });
        afterAll(() => {
            jest.useRealTimers();
        });

        it("should emit when a sticky event expires", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            jest.setSystemTime(0);
            const ev = new MatrixEvent({
                ...stickyEvent,
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            jest.setSystemTime(15000);
            jest.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [ev]);
        });
        it("should emit two events when both expire at the same time", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            jest.setSystemTime(0);
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
            expect(emitSpy).toHaveBeenCalledWith([ev1, ev2], []);
            jest.setSystemTime(15000);
            jest.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [ev1, ev2]);
        });
        it("should emit when a unkeyed sticky event expires", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            jest.setSystemTime(0);
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
                origin_server_ts: Date.now(),
            });
            stickyEvents.addStickyEvents([ev]);
            jest.setSystemTime(15000);
            jest.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [ev]);
        });
    });
});
