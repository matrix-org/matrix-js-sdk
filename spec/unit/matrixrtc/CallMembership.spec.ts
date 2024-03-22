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

import { MatrixEvent } from "../../../src";
import { CallMembership, CallMembershipData } from "../../../src/matrixrtc/CallMembership";

const membershipTemplate: CallMembershipData = {
    call_id: "",
    scope: "m.room",
    application: "m.call",
    device_id: "AAAAAAA",
    expires: 5000,
    membershipID: "bloop",
};

function makeMockEvent(originTs = 0): MatrixEvent {
    return {
        getTs: jest.fn().mockReturnValue(originTs),
        getSender: jest.fn().mockReturnValue("@alice:example.org"),
    } as unknown as MatrixEvent;
}

describe("CallMembership", () => {
    it("rejects membership with no expiry and no expires_ts", () => {
        expect(() => {
            new CallMembership(
                makeMockEvent(),
                Object.assign({}, membershipTemplate, { expires: undefined, expires_ts: undefined }),
            );
        }).toThrow();
    });

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

    it("rejects membership with no scope", () => {
        expect(() => {
            new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { scope: undefined }));
        }).toThrow();
    });
    it("rejects with malformatted expires_ts", () => {
        expect(() => {
            new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { expires_ts: "string" }));
        }).toThrow();
    });
    it("rejects with malformatted expires", () => {
        expect(() => {
            new CallMembership(makeMockEvent(), Object.assign({}, membershipTemplate, { expires: "string" }));
        }).toThrow();
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

    it("computes absolute expiry time based on expires", () => {
        const membership = new CallMembership(makeMockEvent(1000), membershipTemplate);
        expect(membership.getAbsoluteExpiry()).toEqual(5000 + 1000);
    });

    it("computes absolute expiry time based on expires_ts", () => {
        const membership = new CallMembership(
            makeMockEvent(1000),
            Object.assign({}, membershipTemplate, { expires: undefined, expires_ts: 6000 }),
        );
        expect(membership.getAbsoluteExpiry()).toEqual(5000 + 1000);
    });

    it("considers memberships unexpired if local age low enough", () => {
        const fakeEvent = makeMockEvent(1000);
        fakeEvent.getLocalAge = jest.fn().mockReturnValue(3000);
        const membership = new CallMembership(fakeEvent, membershipTemplate);
        expect(membership.isExpired()).toEqual(false);
    });

    it("considers memberships expired when local age large", () => {
        const fakeEvent = makeMockEvent(1000);
        fakeEvent.localTimestamp = Date.now() - 6000;
        const membership = new CallMembership(fakeEvent, membershipTemplate);
        expect(membership.isExpired()).toEqual(true);
    });

    it("returns active foci", () => {
        const fakeEvent = makeMockEvent();
        const mockFocus = { type: "this_is_a_mock_focus" };
        const membership = new CallMembership(
            fakeEvent,
            Object.assign({}, membershipTemplate, { foci_active: [mockFocus] }),
        );
        expect(membership.getActiveFoci()).toEqual([mockFocus]);
    });

    describe("expiry calculation", () => {
        let fakeEvent: MatrixEvent;
        let membership: CallMembership;

        beforeEach(() => {
            // server origin timestamp for this event is 1000
            fakeEvent = makeMockEvent(1000);
            // our clock would have been at 2000 at the creation time (our clock at event receive time - age)
            // (ie. the local clock is 1 second ahead of the servers' clocks)
            fakeEvent.localTimestamp = 2000;

            // for simplicity's sake, we say that the event's age is zero
            fakeEvent.getLocalAge = jest.fn().mockReturnValue(0);

            membership = new CallMembership(fakeEvent!, membershipTemplate);

            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("converts expiry time into local clock", () => {
            // for sanity's sake, make sure the server-relative expiry time is what we expect
            expect(membership.getAbsoluteExpiry()).toEqual(6000);
            // therefore the expiry time converted to our clock should be 1 second later
            expect(membership.getLocalExpiry()).toEqual(7000);
        });

        it("calculates time until expiry", () => {
            jest.setSystemTime(2000);
            expect(membership.getMsUntilExpiry()).toEqual(5000);
        });
    });
});
