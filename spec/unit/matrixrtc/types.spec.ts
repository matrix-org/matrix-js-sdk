/*
Copyright 2025-2026 The Matrix.org Foundation C.I.C.

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

import { EventType, MatrixEvent, type IContent, type IEvent } from "../../../src";
import { type CallMembership } from "../../../src/matrixrtc";
import {
    getCallNotificationExpiry,
    isMyMembership,
    parseCallNotificationContent,
    type RTCNotificationValidationContext,
} from "../../../src/matrixrtc/types";
import { RoomStickyEventsStore } from "../../../src/models/room-sticky-events";
import { secureRandomString } from "../../../src/randomstring";

/** The cap on notification lifetimes as per MSC4075. */
const MAX_LIFETIME_MS = 2 * 60_000;

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

describe("parseCallNotificationContent", () => {
    const roomId = "!room:example.org";
    const sender = "@alice:example.org";
    const userId = "@bob:example.org";
    const slotId = "m.call#ROOM";
    const lifetime = 90_000;

    let now: number;
    let notificationTs: number;
    let store: RoomStickyEventsStore;
    let timelineEvents: MatrixEvent[];
    let relatedEvents: MatrixEvent[];
    let memberStateEvents: MatrixEvent[];
    let slotStatus: "open" | "closed" | undefined;
    let slotApplication: string;
    let senderMayNotifyRoom: boolean;
    let room: RTCNotificationValidationContext["room"];

    function makeStickyEvent(
        event: Partial<IEvent> & { type: string; sender: string | undefined; content: IContent },
    ): MatrixEvent {
        return new MatrixEvent({
            event_id: `$${secureRandomString(8)}`,
            room_id: roomId,
            origin_server_ts: now,
            msc4354_sticky: { duration_ms: 10 * 60_000 },
            unsigned: {},
            ...event,
        });
    }

    /**
     * Creates a valid notification event, with the given overrides applied to its content and event fields.
     * The content overrides are deliberately loosely typed, so that malformed values can be passed in.
     */
    function makeNotification(content: Record<string, unknown> = {}, event: Partial<IEvent> = {}): MatrixEvent {
        return makeStickyEvent({
            type: EventType.RTCNotification,
            sender,
            origin_server_ts: notificationTs,
            content: {
                "slot_id": slotId,
                "msc4354_sticky_key": slotId,
                "m.mentions": { user_ids: [], room: true },
                "notification_type": "notification",
                "sender_ts": notificationTs,
                lifetime,
                ...content,
            },
            ...event,
        });
    }

    /** Same as {@link makeNotification} but also adds the event to the sticky event map. */
    function addNotification(content: Record<string, unknown> = {}, event: Partial<IEvent> = {}): MatrixEvent {
        const notification = makeNotification(content, event);
        store.addStickyEvents([notification]);
        return notification;
    }

    function parse(event: MatrixEvent, overrides: Partial<RTCNotificationValidationContext> = {}) {
        return parseCallNotificationContent(event, { room, userId, now, ...overrides });
    }

    beforeEach(() => {
        now = Date.now();
        notificationTs = now - 1000;
        store = new RoomStickyEventsStore();
        timelineEvents = [];
        relatedEvents = [];
        memberStateEvents = [];
        slotStatus = "open";
        slotApplication = "m.call";
        senderMayNotifyRoom = true;

        const roomState = {
            getStateEvents: (type: string, stateKey?: string): MatrixEvent | MatrixEvent[] | null => {
                if (type === EventType.GroupCallMemberPrefix) return memberStateEvents;
                if (type !== EventType.RTCSlot || stateKey !== slotId || slotStatus === undefined) return null;
                return new MatrixEvent({
                    type,
                    state_key: stateKey,
                    sender,
                    room_id: roomId,
                    content: { status: slotStatus, application: { type: slotApplication } },
                });
            },
            mayTriggerNotifOfType: (notifLevelKey: string): boolean => notifLevelKey === "room" && senderMayNotifyRoom,
        };
        room = {
            getLiveTimeline: () => ({ getState: () => roomState }),
            findEventById: (eventId: string) => timelineEvents.find((event) => event.getId() === eventId),
            getUnfilteredTimelineSet: () => ({
                relations: {
                    getChildEventsForEvent: (eventId: string, relType: string, eventType: string) => {
                        const matches = relatedEvents.filter(
                            (event) =>
                                event.getType() === eventType &&
                                event.getRelation()?.rel_type === relType &&
                                event.getRelation()?.event_id === eventId,
                        );
                        return matches.length ? { getRelations: () => matches } : undefined;
                    },
                },
            }),
            _unstable_getStickyEvents: () => store.getStickyEvents(),
            _unstable_getKeyedStickyEvent: (sender: string, type: string, stickyKey: string) =>
                store.getKeyedStickyEvent(sender, type, stickyKey),
        } as unknown as RTCNotificationValidationContext["room"];
    });

    afterEach(() => {
        store.clear();
    });

    describe("schema", () => {
        it("parses valid content", async () => {
            const notification = addNotification();
            await expect(parse(notification)).resolves.toEqual(notification.getContent());
        });

        it("parses content without notification_type", async () => {
            const notification = addNotification({ notification_type: undefined });
            expect((await parse(notification)).notification_type).toBeUndefined();
        });

        it("caps lifetime to 2 minutes", async () => {
            const notification = addNotification({ lifetime: 10 * 60_000 });
            expect((await parse(notification)).lifetime).toBe(MAX_LIFETIME_MS);
        });

        it("rejects withdrawn notifications", async () => {
            for (const content of [{ msc4354_sticky_key: slotId }, {}]) {
                const withdrawal = makeStickyEvent({ type: EventType.RTCNotification, sender, content });
                store.addStickyEvents([withdrawal]);
                await expect(parse(withdrawal)).rejects.toThrow();
            }
        });

        it("throws on missing or invalid slot_id", async () => {
            await expect(parse(addNotification({ slot_id: undefined }))).rejects.toThrow();
            await expect(parse(addNotification({ slot_id: 42 }))).rejects.toThrow();
        });

        it("throws on a mismatching sticky key", async () => {
            await expect(parse(addNotification({ msc4354_sticky_key: "m.call#OTHER" }))).rejects.toThrow();
        });

        it("throws on missing or malformed m.mentions", async () => {
            await expect(parse(addNotification({ "m.mentions": "not an object" }))).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": undefined }))).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": { room: "yes" } }))).rejects.toThrow();
            await expect(
                parse(addNotification({ "m.mentions": { user_ids: "@alice:example.org" } })),
            ).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": { user_ids: [42] } }))).rejects.toThrow();
        });

        it("throws on m.mentions that neither target the room nor a user", async () => {
            await expect(parse(addNotification({ "m.mentions": {} }))).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": { room: false } }))).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": { user_ids: [] } }))).rejects.toThrow();
            await expect(parse(addNotification({ "m.mentions": { room: false, user_ids: [] } }))).rejects.toThrow();
        });

        it("throws on missing or invalid sender_ts", async () => {
            await expect(parse(addNotification({ sender_ts: undefined }))).rejects.toThrow();
            await expect(parse(addNotification({ sender_ts: "123" }))).rejects.toThrow();
            await expect(parse(addNotification({ sender_ts: -1 }))).rejects.toThrow();
            await expect(parse(addNotification({ sender_ts: 1.5 }))).rejects.toThrow();
        });

        it("throws on missing or invalid lifetime", async () => {
            await expect(parse(addNotification({ lifetime: undefined }))).rejects.toThrow();
            await expect(parse(addNotification({ lifetime: "1000" }))).rejects.toThrow();
            await expect(parse(addNotification({ lifetime: -1 }))).rejects.toThrow();
            await expect(parse(addNotification({ lifetime: 1.5 }))).rejects.toThrow();
        });

        it("accepts a valid m.relates_to (m.reference)", async () => {
            const relation = { rel_type: "m.reference", event_id: "$ev" };
            const notification = addNotification({ "m.relates_to": relation });
            expect((await parse(notification))["m.relates_to"]).toEqual(relation);
        });
    });

    it("rejects events that aren't notifications", async () => {
        const notification = addNotification({}, { type: EventType.RTCMembership });
        await expect(parse(notification)).rejects.toThrow();
    });

    describe("slot resolution", () => {
        // Notifications predating `slot_id` also predate the sticky key. These fixtures keep the sticky key so
        // that the event still lands in the sticky event map under the slot the parser is expected to resolve,
        // which lets the remaining receiving rules run.
        const legacyNotification = { slot_id: undefined, msc4354_sticky_key: slotId };
        const rtcMembershipContent = {
            slot_id: slotId,
            application: { type: "m.call" },
            member: { user_id: sender, device_id: "DEVICE", id: "MEMBER" },
            transports: { published: [], can_subscribe: [] },
            versions: [],
            msc4354_sticky_key: "MEMBER",
        };

        function addToTimeline(content: IContent, type = EventType.RTCMembership): MatrixEvent {
            const event = new MatrixEvent({
                event_id: `$membership${secureRandomString(8)}`,
                room_id: roomId,
                type,
                sender,
                origin_server_ts: notificationTs - 1000,
                content,
                ...(type === EventType.GroupCallMemberPrefix ? { state_key: `_${sender}_DEVICE` } : {}),
            });
            timelineEvents.push(event);
            return event;
        }

        function notificationReferencing(eventId: string | undefined, relType = "m.reference"): MatrixEvent {
            return addNotification({
                ...legacyNotification,
                "m.relates_to": { rel_type: relType, event_id: eventId },
            });
        }

        it("resolves the slot from a referenced m.rtc.member event", async () => {
            const membership = addToTimeline(rtcMembershipContent);
            expect((await parse(notificationReferencing(membership.getId()))).slot_id).toBe(slotId);
        });

        it("resolves the slot from a referenced legacy m.call.member event", async () => {
            // The legacy format uses an empty `call_id` for the room-wide call, which maps to the "ROOM" slot.
            const membership = addToTimeline(
                {
                    application: "m.call",
                    call_id: "",
                    device_id: "DEVICE",
                    scope: "m.room",
                    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
                    foci_preferred: [],
                },
                EventType.GroupCallMemberPrefix,
            );
            expect((await parse(notificationReferencing(membership.getId()))).slot_id).toBe("m.call#ROOM");
        });

        it("resolves the slot from a referenced sticky membership outside the timeline", async () => {
            const membership = makeStickyEvent({
                type: EventType.RTCMembership,
                sender,
                content: rtcMembershipContent,
            });
            store.addStickyEvents([membership]);
            expect((await parse(notificationReferencing(membership.getId()))).slot_id).toBe(slotId);
        });

        it("prefers an explicit slot_id over the referenced membership", async () => {
            const membership = addToTimeline({ ...rtcMembershipContent, slot_id: "m.call#OTHER" });
            const notification = addNotification({
                "m.relates_to": { rel_type: "m.reference", event_id: membership.getId() },
            });
            expect((await parse(notification)).slot_id).toBe(slotId);
        });

        it("throws on an invalid slot_id", async () => {
            await expect(parse(addNotification({ slot_id: 42 }))).rejects.toThrow();
        });

        it("throws on a malformed slot_id", async () => {
            await expect(parse(addNotification({ slot_id: "m.call#one#two" }))).rejects.toThrow();
        });

        it("throws when there is no relation to fall back to", async () => {
            await expect(parse(addNotification(legacyNotification))).rejects.toThrow();
        });

        it("throws when the relation is not an m.reference", async () => {
            const membership = addToTimeline(rtcMembershipContent);
            await expect(parse(notificationReferencing(membership.getId(), "m.annotation"))).rejects.toThrow();
        });

        it("throws when the referenced event is not available locally", async () => {
            await expect(parse(notificationReferencing("$nowhere"))).rejects.toThrow();
        });

        it("throws when the referenced event is not a membership", async () => {
            const message = addToTimeline({ body: "hi" }, EventType.RoomMessage);
            await expect(parse(notificationReferencing(message.getId()))).rejects.toThrow();
        });
    });

    it("rejects notifications sent by the receiving user", async () => {
        await expect(parse(addNotification({}, { sender: userId }))).rejects.toThrow();
    });

    it("rejects events that are missing their event ID or sender", async () => {
        await expect(parse(makeNotification({}, { event_id: undefined }))).rejects.toThrow();
        await expect(parse(makeNotification({}, { sender: undefined }))).rejects.toThrow();
    });

    describe("sticky event map", () => {
        it("rejects notifications that aren't in the sticky event map", async () => {
            const notification = makeNotification();
            await expect(parse(notification)).rejects.toThrow();
        });

        it("rejects notifications superseded by a newer notification for the same sender and slot", async () => {
            const notification = addNotification();
            const newer = addNotification({}, { origin_server_ts: notificationTs + 1 });
            await expect(parse(notification)).rejects.toThrow();
            await expect(parse(newer)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("rejects notifications that were withdrawn", async () => {
            const notification = addNotification();
            const withdrawal = makeStickyEvent({
                type: EventType.RTCNotification,
                sender,
                origin_server_ts: notificationTs + 1,
                content: { msc4354_sticky_key: slotId },
            });
            store.addStickyEvents([withdrawal]);
            await expect(parse(notification)).rejects.toThrow();
            await expect(parse(withdrawal)).rejects.toThrow();
        });

        it("skips the rule for notifications that didn't arrive as sticky events", async () => {
            // Such a notification can be neither superseded nor withdrawn, so there is nothing to check. It
            // is absent from the sticky event map, which is exactly why the rule can't be applied blindly.
            const notification = makeNotification();
            delete notification.event.msc4354_sticky;
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("accepts notifications for the same slot from different senders independently", async () => {
            const notification = addNotification();
            const fromOther = addNotification({}, { sender: "@carol:example.org" });
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
            await expect(parse(fromOther)).resolves.toMatchObject({ slot_id: slotId });
        });
    });

    describe("slot", () => {
        it("rejects notifications for slots that don't exist", async () => {
            slotStatus = undefined;
            const notification = addNotification();
            await expect(parse(notification)).rejects.toThrow();
        });

        it("rejects notifications for closed slots", async () => {
            slotStatus = "closed";
            const notification = addNotification();
            await expect(parse(notification)).rejects.toThrow();
        });

        it("rejects notifications for slots whose application doesn't match their ID", async () => {
            slotApplication = "m.other";
            const notification = addNotification();
            await expect(parse(notification)).rejects.toThrow();
        });

        it("rejects notifications for slots other than the open one", async () => {
            const notification = addNotification({ slot_id: "m.call#OTHER", msc4354_sticky_key: "m.call#OTHER" });
            await expect(parse(notification)).rejects.toThrow();
        });
    });

    describe("lifetime", () => {
        it("accepts notifications right before their lifetime elapses", async () => {
            const notification = addNotification();
            await expect(parse(notification, { now: notificationTs + lifetime - 1 })).resolves.toMatchObject({
                slot_id: slotId,
            });
        });

        it("rejects notifications whose lifetime has elapsed", async () => {
            const notification = addNotification();
            await expect(parse(notification, { now: notificationTs + lifetime })).rejects.toThrow();
        });

        it("measures the lifetime from sender_ts if it is at most 20s ahead of origin_server_ts", async () => {
            const notification = addNotification({ sender_ts: notificationTs + 20_000 });
            await expect(parse(notification, { now: notificationTs + lifetime + 19_999 })).resolves.toMatchObject({
                slot_id: slotId,
            });
        });

        it("measures the lifetime from origin_server_ts if sender_ts is more than 20s ahead", async () => {
            const notification = addNotification({ sender_ts: notificationTs + 20_001 });
            await expect(parse(notification, { now: notificationTs + lifetime })).rejects.toThrow();
        });

        it("caps the remaining lifetime at 2 minutes", async () => {
            const notification = addNotification({ lifetime: 10 * 60_000 });
            // The lifetime is capped when parsing, so the notification expires 2 minutes after it was sent.
            await expect(parse(notification, { now: notificationTs + MAX_LIFETIME_MS - 1 })).resolves.toMatchObject({
                slot_id: slotId,
            });
            await expect(parse(notification, { now: notificationTs + MAX_LIFETIME_MS })).rejects.toThrow();
        });
    });

    describe("mentions", () => {
        it("accepts notifications that mention the receiving user", async () => {
            senderMayNotifyRoom = false;
            const notification = addNotification({ "m.mentions": { user_ids: [userId] } });
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("rejects notifications that mention other users only", async () => {
            const notification = addNotification({ "m.mentions": { user_ids: ["@carol:example.org"] } });
            await expect(parse(notification)).rejects.toThrow();
        });

        it("accepts room mentions if the sender may trigger room notifications", async () => {
            const notification = addNotification({ "m.mentions": { room: true } });
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("rejects room mentions if the sender may not trigger room notifications", async () => {
            senderMayNotifyRoom = false;
            const notification = addNotification({ "m.mentions": { room: true } });
            await expect(parse(notification)).rejects.toThrow();
        });
    });

    describe("own memberships", () => {
        const joinedContent = {
            slot_id: slotId,
            application: { type: "m.call" },
            member: { user_id: userId, device_id: "DEVICE", id: "MEMBER" },
            transports: { published: [], can_subscribe: [] },
            versions: [],
            msc4354_sticky_key: "MEMBER",
        };
        // Left memberships only contain the slot ID and the sticky key.
        const leftContent = { slot_id: slotId, msc4354_sticky_key: "MEMBER" };

        function addMembership(content: IContent, originServerTs = now, from = userId): void {
            store.addStickyEvents([
                makeStickyEvent({
                    type: EventType.RTCMembership,
                    sender: from,
                    content,
                    origin_server_ts: originServerTs,
                }),
            ]);
        }

        it("rejects notifications if the receiving user is joined to the slot", async () => {
            const notification = addNotification();
            addMembership(joinedContent);
            await expect(parse(notification)).rejects.toThrow();
        });

        it("accepts notifications if the receiving user is joined to a different slot", async () => {
            const notification = addNotification();
            addMembership({ ...joinedContent, slot_id: "m.call#OTHER" });
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("accepts notifications if a different user is joined to the slot", async () => {
            const notification = addNotification();
            const otherUser = "@carol:example.org";
            addMembership(
                { ...joinedContent, member: { ...joinedContent.member, user_id: otherUser } },
                now,
                otherUser,
            );
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("rejects notifications if the receiving user left the slot after the notification was sent", async () => {
            const notification = addNotification();
            addMembership(leftContent, notificationTs + 1);
            await expect(parse(notification)).rejects.toThrow();
        });

        it("rejects notifications if the receiving user left the slot when the notification was sent", async () => {
            const notification = addNotification();
            addMembership(leftContent, notificationTs);
            await expect(parse(notification)).rejects.toThrow();
        });

        it("accepts notifications if the receiving user left the slot before the notification was sent", async () => {
            const notification = addNotification();
            addMembership(leftContent, notificationTs - 1);
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("accepts notifications if the receiving user left a different slot after the notification was sent", async () => {
            const notification = addNotification();
            addMembership({ ...leftContent, slot_id: "m.call#OTHER" }, notificationTs + 1);
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("treats left memberships without slot_id as belonging to the slot", async () => {
            const notification = addNotification();
            addMembership({ msc4354_sticky_key: "MEMBER" }, notificationTs + 1);
            await expect(parse(notification)).rejects.toThrow();
        });

        it("accepts notifications if a left membership without slot_id predates the notification", async () => {
            const notification = addNotification();
            addMembership({ msc4354_sticky_key: "MEMBER" }, notificationTs - 1);
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        describe("legacy member state events", () => {
            // Sessions without sticky events keep membership in `m.call.member` state instead, so those
            // events have to be consulted too. An empty `call_id` maps to the "ROOM" slot.
            const legacyJoinedContent = {
                application: "m.call",
                call_id: "",
                device_id: "DEVICE",
                scope: "m.room",
                focus_active: { type: "livekit", focus_selection: "oldest_membership" },
                foci_preferred: [],
            };

            function addMemberStateEvent(content: IContent, from = userId, originServerTs = now): void {
                memberStateEvents.push(
                    new MatrixEvent({
                        event_id: `$state${secureRandomString(8)}`,
                        room_id: roomId,
                        type: EventType.GroupCallMemberPrefix,
                        state_key: `_${from}_DEVICE`,
                        sender: from,
                        origin_server_ts: originServerTs,
                        content,
                    }),
                );
            }

            it("rejects notifications if the receiving user is joined to the slot", async () => {
                const notification = addNotification();
                addMemberStateEvent({ ...legacyJoinedContent, created_ts: now });
                await expect(parse(notification)).rejects.toThrow();
            });

            it("accepts notifications if the receiving user is joined to a different slot", async () => {
                const notification = addNotification();
                addMemberStateEvent({ ...legacyJoinedContent, call_id: "other", created_ts: now });
                await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
            });

            it("accepts notifications if a different user is joined to the slot", async () => {
                const notification = addNotification();
                addMemberStateEvent({ ...legacyJoinedContent, created_ts: now }, "@carol:example.org");
                await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
            });

            it("ignores an expired membership", async () => {
                // A client that disappears without leaving leaves its membership behind. Honouring it would
                // suppress notifications until it expires.
                const notification = addNotification();
                addMemberStateEvent({ ...legacyJoinedContent, created_ts: now - 60_000, expires: 30_000 });
                await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
            });

            it("rejects notifications if the receiving user left the slot after the notification was sent", async () => {
                const notification = addNotification();
                // Leaving clears the state event's content.
                addMemberStateEvent({}, userId, notificationTs + 1);
                await expect(parse(notification)).rejects.toThrow();
            });

            it("accepts notifications if the receiving user left before the notification was sent", async () => {
                const notification = addNotification();
                addMemberStateEvent({}, userId, notificationTs - 1);
                await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
            });
        });

        it("considers the current membership event only", async () => {
            const notification = addNotification();
            // Joined before the notification, left afterwards: the leave replaces the join in the sticky map.
            addMembership(joinedContent, notificationTs - 1);
            addMembership(leftContent, notificationTs + 1);
            await expect(parse(notification)).rejects.toThrow();
        });
    });

    describe("declines", () => {
        function addDecline(from: string, notificationEventId: string): void {
            relatedEvents.push(
                makeStickyEvent({
                    type: EventType.RTCDecline,
                    sender: from,
                    content: {
                        "m.relates_to": { rel_type: "m.reference", event_id: notificationEventId },
                        "msc4354_sticky_key": notificationEventId,
                    },
                }),
            );
        }

        it("rejects notifications that the receiving user declined", async () => {
            const notification = addNotification();
            addDecline(userId, notification.getId()!);
            await expect(parse(notification)).rejects.toThrow();
        });

        it("accepts notifications if the receiving user declined a different notification", async () => {
            const notification = addNotification();
            addDecline(userId, "$other");
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });

        it("accepts notifications that a different user declined", async () => {
            const notification = addNotification();
            addDecline("@carol:example.org", notification.getId()!);
            await expect(parse(notification)).resolves.toMatchObject({ slot_id: slotId });
        });
    });
});

describe("getCallNotificationExpiry", () => {
    const originServerTs = 1_000_000;
    const lifetime = 90_000;

    it("measures the lifetime from sender_ts", () => {
        expect(getCallNotificationExpiry({ sender_ts: originServerTs, lifetime }, originServerTs, originServerTs)).toBe(
            originServerTs + lifetime,
        );
    });

    it("keeps measuring from sender_ts if it is at most 20s ahead of origin_server_ts", () => {
        const senderTs = originServerTs + 20_000;
        expect(getCallNotificationExpiry({ sender_ts: senderTs, lifetime }, originServerTs, originServerTs)).toBe(
            senderTs + lifetime,
        );
    });

    it("measures the lifetime from origin_server_ts if sender_ts is more than 20s ahead", () => {
        const senderTs = originServerTs + 20_001;
        expect(getCallNotificationExpiry({ sender_ts: senderTs, lifetime }, originServerTs, originServerTs)).toBe(
            originServerTs + lifetime,
        );
    });

    it("keeps measuring from sender_ts if it lies behind origin_server_ts", () => {
        const senderTs = originServerTs - 60_000;
        expect(getCallNotificationExpiry({ sender_ts: senderTs, lifetime }, originServerTs, originServerTs)).toBe(
            senderTs + lifetime,
        );
    });

    it("caps the remaining lifetime at 2 minutes", () => {
        const now = originServerTs + 10_000;
        expect(
            getCallNotificationExpiry({ sender_ts: originServerTs, lifetime: 10 * 60_000 }, originServerTs, now),
        ).toBe(now + MAX_LIFETIME_MS);
    });

    it("defaults now to Date.now()", () => {
        const before = Date.now();
        // With a lifetime exceeding the cap, the expiry is determined by `now` plus the cap.
        const expiry = getCallNotificationExpiry({ sender_ts: before, lifetime: 10 * 60_000 }, before);
        expect(expiry).toBeGreaterThanOrEqual(before + MAX_LIFETIME_MS);
        expect(expiry).toBeLessThanOrEqual(Date.now() + MAX_LIFETIME_MS);
    });
});
