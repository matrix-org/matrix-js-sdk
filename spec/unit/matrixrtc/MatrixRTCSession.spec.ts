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

import { EventTimeline, MatrixClient } from "../../../src";
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { MatrixRTCSession } from "../../../src/matrixrtc/MatrixRTCSession";
import { makeMockRoom } from "./mocks";

const membershipTemplate: CallMembershipData = {
    call_id: "",
    scope: "m.room",
    application: "m.call",
    device_id: "AAAAAAA",
    expires: 60 * 60 * 1000,
};

describe("MatrixRTCSession", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = new MatrixClient({ baseUrl: "base_url" });
    });

    afterEach(() => {
        client.stopClient();
    });

    it("Creates a room-scoped session from room state", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);

        const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships.length).toEqual(1);
        expect(sess?.memberships[0].callId).toEqual("");
        expect(sess?.memberships[0].scope).toEqual("m.room");
        expect(sess?.memberships[0].application).toEqual("m.call");
        expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
        expect(sess?.memberships[0].isExpired()).toEqual(false);
    });

    it("ignores expired memberships events", () => {
        const expiredMembership = Object.assign({}, membershipTemplate);
        expiredMembership.expires = 1000;
        expiredMembership.device_id = "EXPIRED";
        const mockRoom = makeMockRoom([membershipTemplate, expiredMembership]);
        // make this event older by adjusting the age param
        mockRoom.getLiveTimeline().getState(EventTimeline.FORWARDS)!.getStateEvents("")[0].getLocalAge = jest
            .fn()
            .mockReturnValue(10000);

        const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships.length).toEqual(1);
        expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
    });

    it("honours created_ts", () => {
        const expiredMembership = Object.assign({}, membershipTemplate);
        expiredMembership.created_ts = 500;
        expiredMembership.expires = 1000;
        const mockRoom = makeMockRoom([expiredMembership]);
        const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships[0].getAbsoluteExpiry()).toEqual(1500);
    });

    it("returns empty session if no membership events are present", () => {
        const mockRoom = makeMockRoom([]);
        const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships).toHaveLength(0);
    });

    describe("activeRoomSessionForRoom", () => {
        it("ignores events with no expires_ts", () => {
            const expiredMembership = Object.assign({}, membershipTemplate);
            (expiredMembership.expires as number | undefined) = undefined;
            const mockRoom = makeMockRoom([expiredMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess).toBeUndefined();
        });

        it("ignores events with no device_id", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.device_id as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess).toBeUndefined();
        });

        it("ignores events with no call_id", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.call_id as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess).toBeUndefined();
        });

        it("ignores events with no scope", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.scope as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess).toBeUndefined();
        });

        it("ignores anything that's not a room-scoped call (for now)", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            testMembership.scope = "m.user";
            const mockRoom = makeMockRoom([testMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess).toBeUndefined();
        });
    });
});
