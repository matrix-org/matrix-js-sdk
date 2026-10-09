/*
Copyright 2023-2026 The Matrix.org Foundation C.I.C.

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

import { type RtcMembershipData, type SessionMembershipData } from "../../../src/matrixrtc/membershipData/index.ts";
import { type IContent, type MatrixEvent } from "../../../src/models/event.ts";
import { EventType } from "../../../src/@types/event.ts";
import { CallMembership, DEFAULT_EXPIRE_DURATION } from "../../../src/matrixrtc/CallMembership.ts";

function createCallMembership(ev: MatrixEvent, content: IContent): CallMembership {
    vi.mocked(ev.getContent).mockReturnValue(content);
    const data = CallMembership.membershipDataFromMatrixEvent(ev);
    return new CallMembership(ev, data, ["xx"], "(deprecated)");
}

describe("CallMembership", () => {
    describe("SessionMembershipData", () => {
        function makeMockEvent(originTs = 0): MatrixEvent {
            return {
                getTs: vi.fn().mockReturnValue(originTs),
                getSender: vi.fn().mockReturnValue("@alice:example.org"),
                getId: vi.fn().mockReturnValue("$eventid"),
                getContent: vi.fn().mockReturnValue({}),
                getType: vi.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
            } as unknown as MatrixEvent;
        }
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const membershipTemplate: SessionMembershipData = {
            "call_id": "",
            "scope": "m.room",
            "application": "m.call",
            "device_id": "AAAAAAA",
            "focus_active": { type: "livekit", focus_selection: "multi_sfu" },
            "foci_preferred": [{ type: "livekit" }],
            "m.call.intent": "voice",
            "capabilities": ["m.render_audio", "m.render_video"],
        };

        it("rejects membership with no device_id", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { device_id: undefined }));
            }).toThrow();
        });

        it("rejects membership with no call_id", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { call_id: undefined }));
            }).toThrow();
        });

        it("allow membership with no scope", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { scope: undefined }));
            }).not.toThrow();
        });

        it("rejects membership with non-array capabilities", () => {
            expect(() => {
                createCallMembership(
                    makeMockEvent(),
                    Object.assign({}, membershipTemplate, { capabilities: "m.render_audio" }),
                );
            }).toThrow();
        });

        it("rejects membership with non-string entries in capabilities", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { capabilities: [42] }));
            }).toThrow();
        });

        it("uses event timestamp if no created_ts", () => {
            const membership = createCallMembership(makeMockEvent(12345), membershipTemplate);
            expect(membership.createdTs()).toEqual(12345);
        });

        it("uses created_ts if present", () => {
            const membership = createCallMembership(
                makeMockEvent(12345),
                Object.assign({}, membershipTemplate, { created_ts: 67890 }),
            );
            expect(membership.createdTs()).toEqual(67890);
        });

        it("considers memberships unexpired if local age low enough", () => {
            const fakeEvent = makeMockEvent(1000);
            fakeEvent.getTs = vi.fn().mockReturnValue(Date.now() - (DEFAULT_EXPIRE_DURATION - 1));
            expect(createCallMembership(fakeEvent, membershipTemplate).isExpired()).toEqual(false);
        });

        it("considers memberships expired if local age large enough", () => {
            const fakeEvent = makeMockEvent(1000);
            fakeEvent.getTs = vi.fn().mockReturnValue(Date.now() - (DEFAULT_EXPIRE_DURATION + 1));
            expect(createCallMembership(fakeEvent, membershipTemplate).isExpired()).toEqual(true);
        });

        it("returns preferred foci", () => {
            const fakeEvent = makeMockEvent();
            const mockFocus = { type: "this_is_a_mock_focus" };
            const membership = createCallMembership(fakeEvent, { ...membershipTemplate, foci_preferred: [mockFocus] });
            expect(membership.transports).toEqual([mockFocus]);
        });

        describe("getTransport", () => {
            const mockFocus = { type: "this_is_a_mock_focus" };
            it("gets the correct active transport from session membership", () => {
                const membership = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    foci_preferred: [mockFocus],
                    focus_active: { type: "livekit", focus_selection: "multi_sfu" },
                });
                expect(membership.getTransport()).toStrictEqual(mockFocus);
            });
        });

        describe("correct values from computed fields", () => {
            const membership = createCallMembership(makeMockEvent(), membershipTemplate);
            it("returns correct sender", () => {
                expect(membership.sender).toBe("@alice:example.org");
            });
            it("returns correct eventId", () => {
                expect(membership.eventId).toBe("$eventid");
            });
            it("returns correct slot_id", () => {
                // slot_id is application and call_id dependent. So we create
                // a membership for each possible combination

                // non call application (should not alter call_id even with empty string)
                const nonCallMembership = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: "m.not.a.call",
                    call_id: "",
                });
                // non "" call id should not be altered
                const callMembershipCustomId = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    call_id: "customCallId",
                });

                // for membership (application = m.call and call_id = "") we expect "" -> ROOM
                // for legacy events we expect the room to be added automagically
                // See INFO_SLOT_ID_LEGACY_CASE comments
                expect(membership.slotId).toBe("m.call#ROOM");
                expect(membership.slotDescription).toStrictEqual({ id: "ROOM", application: "m.call" });

                expect(nonCallMembership.slotId).toBe("m.not.a.call#");
                expect(nonCallMembership.slotDescription).toStrictEqual({ id: "", application: "m.not.a.call" });

                expect(callMembershipCustomId.slotId).toBe("m.call#customCallId");
                expect(callMembershipCustomId.slotDescription).toStrictEqual({
                    id: "customCallId",
                    application: "m.call",
                });
            });
            it("returns correct deviceId", () => {
                expect(membership.deviceId).toBe("AAAAAAA");
            });
            it("returns correct call intent", () => {
                expect(membership.callIntent).toBe("voice");
            });
            it("returns correct call capabilities", () => {
                expect(membership.callCapabilities).toStrictEqual(["m.render_audio", "m.render_video"]);
            });
            it("returns undefined call capabilities if not advertised", () => {
                const withoutCapabilities = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    capabilities: undefined,
                });
                expect(withoutCapabilities.callCapabilities).toBeUndefined();
            });
            it("returns correct applicationData", () => {
                expect(membership.applicationData).toStrictEqual({
                    "type": "m.call",
                    "m.call.intent": "voice",
                    "capabilities": ["m.render_audio", "m.render_video"],
                });
            });
            it("returns the application's own top-level data in applicationData", () => {
                const withData = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    "org.example.key": { nested: true },
                });
                expect(withData.applicationData).toStrictEqual({
                    "org.example.key": { nested: true },
                    "type": "m.call",
                    "m.call.intent": "voice",
                    "capabilities": ["m.render_audio", "m.render_video"],
                });
            });
            it("returns correct scope", () => {
                expect(membership.scope).toBe("m.room");
            });
            it("returns correct unused fields", () => {
                expect(membership.getAbsoluteExpiry()).toBe(DEFAULT_EXPIRE_DURATION);
                expect(membership.getMsUntilExpiry()).toBe(DEFAULT_EXPIRE_DURATION - Date.now());
                expect(membership.isExpired()).toBe(true);
            });
        });
        describe("expiry calculation", () => {
            let fakeEvent: MatrixEvent;
            let membership: CallMembership;

            beforeEach(() => {
                // server origin timestamp for this event is 1000
                fakeEvent = makeMockEvent(1000);
                membership = createCallMembership(fakeEvent!, membershipTemplate);

                vi.useFakeTimers();
            });

            afterEach(() => {
                vi.useFakeTimers();
            });

            it("calculates time until expiry", () => {
                vi.setSystemTime(2000);
                // should be using absolute expiry time
                expect(membership.getMsUntilExpiry()).toEqual(DEFAULT_EXPIRE_DURATION - 1000);
            });
        });
    });

    describe("RtcMembershipData", () => {
        function makeMockEvent(originTs = 0, content: IContent = {}): MatrixEvent {
            return {
                getTs: vi.fn().mockReturnValue(originTs),
                getSender: vi.fn().mockReturnValue("@alice:example.org"),
                getId: vi.fn().mockReturnValue("$eventid"),
                getContent: vi.fn().mockReturnValue(content),
                getType: vi.fn().mockReturnValue(EventType.RTCMembership),
            } as unknown as MatrixEvent;
        }
        const membershipTemplate: RtcMembershipData = {
            slot_id: "m.call#",
            application: {
                "type": "m.call",
                "m.call.id": "",
                "m.call.intent": "voice",
                "capabilities": ["m.render_audio", "m.render_video"],
            },
            member: { user_id: "@alice:example.org", device_id: "AAAAAAA", id: "xyzHASHxyz" },
            transports: { published: [{ type: "livekit" }], can_subscribe: ["livekit"] },
            versions: [],
            msc4354_sticky_key: "abc123",
        };

        it("rejects membership with no slot_id", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: undefined });
            }).toThrow();
        });
        it("rejects membership with invalid slot_id", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: "invalid_slot_id" });
            }).toThrow();
        });
        it("rejects membership with slot_id that contains extra #", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: "m.call#mycall#extra" });
            }).toThrow();
        });
        it("accepts membership with valid slot_id", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: "m.call#" });
            }).not.toThrow();
        });

        it("rejects membership with no application", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, application: undefined });
            }).toThrow();
        });

        it("rejects membership with incorrect application", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: { wrong_type_key: "unknown" },
                });
            }).toThrow();
        });

        it("rejects membership with no member", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, member: undefined });
            }).toThrow();
        });

        it("rejects membership with incorrect  member", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, member: { i: "test" } });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id_wrong: "test" },
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id_wrong: "test", user_id_wrong: "test" },
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id: "@@test" },
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id: "@test-wrong-user:user.id" },
                });
            }).toThrow();
        });

        it("accepts membership without member.membership for compatibility with older events", () => {
            const { membership: _membership, ...legacyMember } = membershipTemplate.member;
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, member: legacyMember });
            }).not.toThrow();
        });

        it("accepts membership with member.membership join", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { ...membershipTemplate.member, membership: "join" },
                });
            }).not.toThrow();
        });

        it("rejects membership with member.membership leave", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { ...membershipTemplate.member, membership: "leave" },
                });
            }).toThrow();
        });

        it("rejects membership with unknown member.membership", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { ...membershipTemplate.member, membership: "knock" },
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { ...membershipTemplate.member, membership: 1 },
                });
            }).toThrow();
        });

        it("rejects membership with incorrect transports", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, transports: { can_subscribe: [1] } });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, transports: { wrong_key: [] } });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, transports: "not an object" });
            }).toThrow();
        });

        it("rejects membership with incorrect sticky_key", () => {
            expect(() => {
                createCallMembership(makeMockEvent(), membershipTemplate);
            }).not.toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    sticky_key: 1,
                    msc4354_sticky_key: undefined,
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    sticky_key: "1",
                    msc4354_sticky_key: undefined,
                });
            }).not.toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), { ...membershipTemplate, msc4354_sticky_key: undefined });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: 1,
                    sticky_key: "valid",
                });
            }).toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: "valid",
                    sticky_key: "valid",
                });
            }).not.toThrow();
            expect(() => {
                createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: "valid_but_different",
                    sticky_key: "valid",
                });
            }).toThrow();
        });

        // TODO link prev event
        it.todo("considers memberships unexpired if local age low enough");
        it.todo("considers memberships expired if local age large enough");

        describe("correct values from computed fields", () => {
            const membership = createCallMembership(makeMockEvent(), membershipTemplate);
            it("returns correct sender", () => {
                expect(membership.sender).toBe("@alice:example.org");
            });
            it("returns correct eventId", () => {
                expect(membership.eventId).toBe("$eventid");
            });
            it("returns correct slot_id", () => {
                expect(membership.slotId).toBe("m.call#");
                expect(membership.slotDescription).toStrictEqual({ id: "", application: "m.call" });
            });
            it("returns correct deviceId", () => {
                expect(membership.deviceId).toBe("AAAAAAA");
            });
            it("returns correct call intent", () => {
                expect(membership.callIntent).toBe("voice");
            });
            it("returns correct call capabilities", () => {
                expect(membership.callCapabilities).toStrictEqual(["m.render_audio", "m.render_video"]);
            });
            it("returns undefined call capabilities if not advertised", () => {
                const withoutCapabilities = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: { "type": "m.call", "m.call.intent": "voice" },
                });
                expect(withoutCapabilities.callCapabilities).toBeUndefined();
            });
            it("returns undefined call capabilities if it is not an array", () => {
                const invalidCapabilities = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: { type: "m.call", capabilities: "m.render_audio" },
                });
                expect(invalidCapabilities.callCapabilities).toBeUndefined();
            });
            it("returns undefined call capabilities if an entry is not a string", () => {
                const invalidCapabilities = createCallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: { type: "m.call", capabilities: ["m.render_audio", 42] },
                });
                expect(invalidCapabilities.callCapabilities).toBeUndefined();
            });
            it("returns correct applicationData", () => {
                expect(membership.applicationData).toStrictEqual({
                    "type": "m.call",
                    "m.call.id": "",
                    "m.call.intent": "voice",
                    "capabilities": ["m.render_audio", "m.render_video"],
                });
            });
            it("returns correct scope", () => {
                expect(membership.scope).toBe(undefined);
            });
            it("returns correct unused fields", () => {
                expect(membership.getAbsoluteExpiry()).toBe(undefined);
                expect(membership.getMsUntilExpiry()).toBe(undefined);
                expect(membership.isExpired()).toBe(false);
            });
        });
        it("uses unpadded base64 for hashed backend identities", async () => {
            const membership = await CallMembership.parseFromEvent(
                makeMockEvent(0, {
                    ...membershipTemplate,
                    transports: {
                        published: [{ type: "livekit", url: "wss://example.org" }],
                        can_subscribe: ["livekit"],
                    },
                }),
            );
            expect(membership.backendIdentities).toEqual(["b26mhWogBA/nZZLXqXYD9AQLx3Wp5nbFPiZSiIFyGu0"]);
        });
        it("uses legacy backend identity in case of legacy transport", async () => {
            const membership = await CallMembership.parseFromEvent(
                makeMockEvent(0, {
                    ...membershipTemplate,
                    transports: {
                        published: [{ type: "livekit", livekit_service_url: "https://example.org" }],
                        can_subscribe: ["livekit"],
                    },
                }),
            );
            expect(membership.backendIdentities).toEqual(["@alice:example.org:AAAAAAA"]);
        });
        it("includes both possible backend identities in case of ambiguous transport", async () => {
            const membership = await CallMembership.parseFromEvent(
                makeMockEvent(0, {
                    ...membershipTemplate,
                    transports: {
                        published: [
                            // Includes both `url` and `livekit_service_url`
                            { type: "livekit", url: "wss://example.org", livekit_service_url: "https://example.org" },
                        ],
                        can_subscribe: ["livekit"],
                    },
                }),
            );
            expect(membership.backendIdentities).toEqual([
                "b26mhWogBA/nZZLXqXYD9AQLx3Wp5nbFPiZSiIFyGu0",
                "@alice:example.org:AAAAAAA",
            ]);
        });
    });
});
