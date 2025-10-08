/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { type MatrixEvent } from "../../../src";
import {
    CallMembership,
    type SessionMembershipData,
    DEFAULT_EXPIRE_DURATION,
    type RtcMembershipData,
} from "../../../src/matrixrtc/CallMembership";
import { membershipTemplate } from "./mocks";

function makeMockEvent(originTs = 0): MatrixEvent {
    return {
        getTs: jest.fn().mockReturnValue(originTs),
        getSender: jest.fn().mockReturnValue("@alice:example.org"),
        getId: jest.fn().mockReturnValue("$eventid"),
    } as unknown as MatrixEvent;
}

describe("CallMembership", () => {
    describe("SessionMembershipData", () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        const membershipTemplate: SessionMembershipData = {
            "call_id": "",
            "scope": "m.room",
            "application": "m.call",
            "device_id": "AAAAAAA",
            "focus_active": { type: "livekit", focus_selection: "oldest_membership" },
            "foci_preferred": [{ type: "livekit" }],
            "m.call.intent": "voice",
        };

        it("rejects membership with no device_id", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { device_id: undefined }));
            }).toThrow();
        });

        it("rejects membership with no call_id", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { call_id: undefined }));
            }).toThrow();
        });

        it("allow membership with no scope", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { scope: undefined }));
            }).not.toThrow();
        });

        it("uses event timestamp if no created_ts", () => {
            const membership = new CallMembership(makeMockEvent(12345), membershipTemplate);
            expect(membership.createdTs()).toEqual(12345);
        });

        it("uses created_ts if present", () => {
            const membership = new CallMembership(
                makeMockEvent(12345),
                Object.assign({}, membershipTemplate, { created_ts: 67890 }),
            );
            expect(membership.createdTs()).toEqual(67890);
        });

        it("considers memberships unexpired if local age low enough", () => {
            const fakeEvent = makeMockEvent(1000);
            fakeEvent.getTs = jest.fn().mockReturnValue(Date.now() - (DEFAULT_EXPIRE_DURATION - 1));
            expect(new CallMembership(fakeEvent, membershipTemplate).isExpired()).toEqual(false);
        });

        it("considers memberships expired if local age large enough", () => {
            const fakeEvent = makeMockEvent(1000);
            fakeEvent.getTs = jest.fn().mockReturnValue(Date.now() - (DEFAULT_EXPIRE_DURATION + 1));
            expect(new CallMembership(fakeEvent, membershipTemplate).isExpired()).toEqual(true);
        });

        it("returns preferred foci", () => {
            const fakeEvent = makeMockEvent();
            const mockFocus = { type: "this_is_a_mock_focus" };
            const membership = new CallMembership(fakeEvent, { ...membershipTemplate, foci_preferred: [mockFocus] });
            expect(membership.transports).toEqual([mockFocus]);
        });

        describe("getTransport", () => {
            const mockFocus = { type: "this_is_a_mock_focus" };
            const oldestMembership = new CallMembership(makeMockEvent(), membershipTemplate);
            it("gets the correct active transport with oldest_membership", () => {
                const membership = new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    foci_preferred: [mockFocus],
                    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
                });

                // if we are the oldest member we use our focus.
                expect(membership.getTransport(membership)).toStrictEqual(mockFocus);

                // If there is an older member we use its focus.
                expect(membership.getTransport(oldestMembership)).toBe(membershipTemplate.foci_preferred[0]);
            });

            it("gets the correct active transport with multi_sfu", () => {
                const membership = new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    foci_preferred: [mockFocus],
                    focus_active: { type: "livekit", focus_selection: "multi_sfu" },
                });

                // if we are the oldest member we use our focus.
                expect(membership.getTransport(membership)).toStrictEqual(mockFocus);

                // If there is an older member we still use our own focus in multi sfu.
                expect(membership.getTransport(oldestMembership)).toBe(mockFocus);
            });
            it("does not provide focus if the selection method is unknown", () => {
                const membership = new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    foci_preferred: [mockFocus],
                    focus_active: { type: "livekit", focus_selection: "unknown" },
                });

                // if we are the oldest member we use our focus.
                expect(membership.getTransport(membership)).toBeUndefined();
            });
        });
        describe("correct values from computed fields", () => {
            const membership = new CallMembership(makeMockEvent(), membershipTemplate);
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
            it("returns correct application", () => {
                expect(membership.application).toStrictEqual("m.call");
            });
            it("returns correct applicationData", () => {
                expect(membership.applicationData).toStrictEqual({ "type": "m.call", "m.call.intent": "voice" });
            });
            it("returns correct scope", () => {
                expect(membership.scope).toBe("m.room");
            });
            it("returns correct membershipID", () => {
                expect(membership.membershipID).toBe("0");
            });
            it("returns correct unused fields", () => {
                expect(membership.getAbsoluteExpiry()).toBe(DEFAULT_EXPIRE_DURATION);
                expect(membership.getMsUntilExpiry()).toBe(DEFAULT_EXPIRE_DURATION - Date.now());
                expect(membership.isExpired()).toBe(true);
            });
        });
    });

    describe("RtcMembershipData", () => {
        const membershipTemplate: RtcMembershipData = {
            slot_id: "m.call#",
            application: { "type": "m.call", "m.call.id": "", "m.call.intent": "voice" },
            member: { user_id: "@alice:example.org", device_id: "AAAAAAA", id: "xyzHASHxyz" },
            rtc_transports: [{ type: "livekit" }],
            versions: [],
            msc4354_sticky_key: "abc123",
        };

        it("rejects membership with no slot_id", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: undefined });
            }).toThrow();
        });
        it("rejects membership with invalid slot_id", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: "invalid_slot_id" });
            }).toThrow();
        });
        it("accepts membership with valid slot_id", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, slot_id: "m.call#" });
            }).not.toThrow();
        });

        it("rejects membership with no application", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, application: undefined });
            }).toThrow();
        });

        it("rejects membership with incorrect application", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    application: { wrong_type_key: "unknown" },
                });
            }).toThrow();
        });

        it("rejects membership with no member", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, member: undefined });
            }).toThrow();
        });

        it("rejects membership with incorrect  member", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, member: { i: "test" } });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id_wrong: "test" },
                });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id_wrong: "test", user_id_wrong: "test" },
                });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id: "@@test" },
                });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    member: { id: "test", device_id: "test", user_id: "@test-wrong-user:user.id" },
                });
            }).toThrow();
        });
        it("rejects membership with incorrect sticky_key", () => {
            expect(() => {
                new CallMembership(makeMockEvent(), membershipTemplate);
            }).not.toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    sticky_key: 1,
                    msc4354_sticky_key: undefined,
                });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    sticky_key: "1",
                    msc4354_sticky_key: undefined,
                });
            }).not.toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), { ...membershipTemplate, msc4354_sticky_key: undefined });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: 1,
                    sticky_key: "valid",
                });
            }).toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: "valid",
                    sticky_key: "valid",
                });
            }).not.toThrow();
            expect(() => {
                new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    msc4354_sticky_key: "valid_but_different",
                    sticky_key: "valid",
                });
            }).toThrow();
        });

        it("considers memberships unexpired if local age low enough", () => {
            // TODO link prev event
        });

        it("considers memberships expired if local age large enough", () => {
            // TODO link prev event
        });

        describe("getTransport", () => {
            it("gets the correct active transport with oldest_membership", () => {
                const oldestMembership = new CallMembership(makeMockEvent(), {
                    ...membershipTemplate,
                    rtc_transports: [{ type: "oldest_transport" }],
                });
                const membership = new CallMembership(makeMockEvent(), membershipTemplate);

                // if we are the oldest member we use our focus.
                expect(membership.getTransport(membership)).toStrictEqual({ type: "livekit" });

                // If there is an older member we use our own focus focus. (RtcMembershipData always uses multi sfu)
                expect(membership.getTransport(oldestMembership)).toStrictEqual({ type: "livekit" });
            });
        });
        describe("correct values from computed fields", () => {
            const membership = new CallMembership(makeMockEvent(), membershipTemplate);
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
            it("returns correct application", () => {
                expect(membership.application).toStrictEqual("m.call");
            });
            it("returns correct applicationData", () => {
                expect(membership.applicationData).toStrictEqual({
                    "type": "m.call",
                    "m.call.id": "",
                    "m.call.intent": "voice",
                });
            });
            it("returns correct scope", () => {
                expect(membership.scope).toBe(undefined);
            });
            it("returns correct membershipID", () => {
                expect(membership.membershipID).toBe("xyzHASHxyz");
            });
            it("returns correct unused fields", () => {
                expect(membership.getAbsoluteExpiry()).toBe(undefined);
                expect(membership.getMsUntilExpiry()).toBe(undefined);
                expect(membership.isExpired()).toBe(false);
            });
        });
    });

    describe("expiry calculation", () => {
        let fakeEvent: MatrixEvent;
        let membership: CallMembership;

        beforeEach(() => {
            // server origin timestamp for this event is 1000
            fakeEvent = makeMockEvent(1000);
            membership = new CallMembership(fakeEvent!, membershipTemplate);

            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("calculates time until expiry", () => {
            jest.setSystemTime(2000);
            // should be using absolute expiry time
            expect(membership.getMsUntilExpiry()).toEqual(DEFAULT_EXPIRE_DURATION - 1000);
        });
    });
});
