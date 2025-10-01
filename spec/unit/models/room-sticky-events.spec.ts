import { type IEvent, MatrixEvent } from "../../../src";
import { RoomStickyEvents, RoomStickyEventsEvent } from "../../../src/models/room-sticky-events";

describe("RoomStickyEvents", () => {
    let stickyEvents: RoomStickyEvents;
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
        stickyEvents = new RoomStickyEvents();
    });

    afterEach(() => {
        stickyEvents?.clear();
    });

    describe("addStickyEvents", () => {
        it("should allow adding an event without a msc4354_sticky_key", () => {
            stickyEvents._unstable_addStickyEvent(new MatrixEvent({ ...stickyEvent, content: {} }));
        });
        it("should not allow adding an event without a msc4354_sticky property", () => {
            expect(() =>
                stickyEvents._unstable_addStickyEvent(new MatrixEvent({ ...stickyEvent, msc4354_sticky: undefined })),
            ).toThrow(`${stickyEvent.event_id} is missing msc4354_sticky.duration_ms`);
            expect(() =>
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({ ...stickyEvent, msc4354_sticky: { duration_ms: undefined } as any }),
                ),
            ).toThrow(`${stickyEvent.event_id} is missing msc4354_sticky.duration_ms`);
        });
        it("should not allow adding an event without a sender", () => {
            expect(() =>
                stickyEvents._unstable_addStickyEvent(new MatrixEvent({ ...stickyEvent, sender: undefined })),
            ).toThrow(`${stickyEvent.event_id} is missing a sender`);
        });
        it("should ignore old events", () => {
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                        origin_server_ts: 0,
                        msc4354_sticky: {
                            duration_ms: 1,
                        },
                    }),
                ),
            ).toEqual({ added: false });
        });
        it("should not replace newer events", () => {
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                    }),
                ),
            ).toEqual({ added: true });
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                        origin_server_ts: 1,
                    }),
                ),
            ).toEqual({ added: false });
        });
        it("should not replace events on ID tie break", () => {
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                    }),
                ),
            ).toEqual({ added: true });
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                        event_id: "$abc:bar",
                    }),
                ),
            ).toEqual({ added: false });
        });
        it("should be able to just add an event", () => {
            expect(
                stickyEvents._unstable_addStickyEvent(
                    new MatrixEvent({
                        ...stickyEvent,
                    }),
                ),
            ).toEqual({ added: true });
        });
    });

    describe("_unstable_addStickyEvents(", () => {
        it("should emit when a new sticky event is added", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents._unstable_addStickyEvents(([ev]));
            expect([...stickyEvents._unstable_getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], []);
        });
        it("should emit when a new unketed sticky event is added", () => {
            const emitSpy = jest.fn();
            stickyEvents.on(RoomStickyEventsEvent.Update, emitSpy);
            const ev = new MatrixEvent({
                ...stickyEvent,
                content: {},
            });
            stickyEvents._unstable_addStickyEvents(([ev]));
            expect([...stickyEvents._unstable_getStickyEvents()]).toEqual([ev]);
            expect(emitSpy).toHaveBeenCalledWith([ev], []);
        });
    });

    describe("getStickyEvents", () => {
        it("should have zero sticky events", () => {
            expect([...stickyEvents._unstable_getStickyEvents()]).toHaveLength(0);
        });
        it("should contain a sticky event", () => {
            const ev = new MatrixEvent({
                ...stickyEvent,
            });
            stickyEvents._unstable_addStickyEvent(
                new MatrixEvent({
                    ...stickyEvent,
                }),
            );
            expect([...stickyEvents._unstable_getStickyEvents()]).toEqual([ev]);
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
            stickyEvents._unstable_addStickyEvent(ev);
            stickyEvents._unstable_addStickyEvent(ev2);
            expect([...stickyEvents._unstable_getStickyEvents()]).toEqual([ev, ev2]);
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
            stickyEvents._unstable_addStickyEvent(ev);
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
            stickyEvents._unstable_addStickyEvents(([ev1, ev2]));
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
            stickyEvents._unstable_addStickyEvent(ev);
            jest.setSystemTime(15000);
            jest.advanceTimersByTime(15000);
            expect(emitSpy).toHaveBeenCalledWith([], [ev]);
        });
    });
});
