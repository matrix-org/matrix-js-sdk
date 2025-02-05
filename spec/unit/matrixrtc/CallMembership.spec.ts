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
} from "../../../src/matrixrtc/CallMembership";
import { membershipTemplate } from "./mocks";

function makeMockEvent(originTs = 0): MatrixEvent {
    return {
        getTs: jest.fn().mockReturnValue(originTs),
        getSender: jest.fn().mockReturnValue("@alice:example.org"),
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
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: "AAAAAAA",
            focus_active: { type: "livekit" },
            foci_preferred: [{ type: "livekit" }],
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
            const membership = new CallMembership(
                fakeEvent,
                Object.assign({}, membershipTemplate, { foci_preferred: [mockFocus] }),
            );
            expect(membership.getPreferredFoci()).toEqual([mockFocus]);
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
