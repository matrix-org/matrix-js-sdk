/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { MatrixClient } from "../../../src";
import { Room } from "../../../src/models/room";
import { MatrixEvent } from "../../../src/models/event";
import { EventType } from "../../../src/@types/event";
import {
    DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
    MSC3089TreeSpace,
    TreePermissions
} from "../../../src/models/MSC3089TreeSpace";

describe("MSC3089TreeSpace", () => {
    let client: MatrixClient;
    let room: Room;
    let tree: MSC3089TreeSpace;
    const roomId = "!tree:localhost";
    const targetUser = "@target:example.org";

    let powerLevels;

    beforeEach(() => {
        // TODO: Use utility functions to create test rooms and clients
        client = <MatrixClient>{
            getRoom: (roomId: string) => {
                if (roomId === roomId) {
                    return room;
                } else {
                    throw new Error("Unexpected fetch for unknown room");
                }
            },
        };
        room = <Room>{
            currentState: {
                getStateEvents: (evType: EventType, stateKey: string) => {
                    if (evType === EventType.RoomPowerLevels && stateKey === "") {
                        return powerLevels;
                    } else {
                        throw new Error("Accessed unexpected state event type or key");
                    }
                },
            },
        };
        tree = new MSC3089TreeSpace(client, roomId);
        makePowerLevels(DEFAULT_TREE_POWER_LEVELS_TEMPLATE);
    });

    function makePowerLevels(content: any) {
        powerLevels = new MatrixEvent({
            type: EventType.RoomPowerLevels,
            state_key: "",
            sender: "@creator:localhost",
            event_id: "$powerlevels",
            room_id: roomId,
            content: content,
        });
    }

    it('should populate the room reference', () => {
        expect(tree.room).toBe(room);
    });

    it('should proxy the ID member to room ID', () => {
        expect(tree.id).toEqual(tree.roomId);
        expect(tree.id).toEqual(roomId);
    });

    it('should support setting the name of the space', async () => {
        const newName = "NEW NAME";
        const fn = jest.fn().mockImplementation((stateRoomId: string, eventType: EventType, content: any, stateKey: string) => {
            expect(stateRoomId).toEqual(roomId);
            expect(eventType).toEqual(EventType.RoomName);
            expect(stateKey).toEqual("");
            expect(content).toMatchObject({name: newName});
            return Promise.resolve();
        });
        client.sendStateEvent = fn;
        await tree.setName(newName);
        expect(fn.mock.calls.length).toBe(1);
    });

    it('should support inviting users to the space', async () => {
        const target = targetUser;
        const fn = jest.fn().mockImplementation((inviteRoomId: string, userId: string) => {
            expect(inviteRoomId).toEqual(roomId);
            expect(userId).toEqual(target);
            return Promise.resolve();
        });
        client.invite = fn;
        await tree.invite(target);
        expect(fn.mock.calls.length).toBe(1);
    });

    async function evaluatePowerLevels(pls: any, role: TreePermissions, expectedPl: number) {
        makePowerLevels(pls);
        const fn = jest.fn().mockImplementation((stateRoomId: string, eventType: EventType, content: any, stateKey: string) => {
            expect(stateRoomId).toEqual(roomId);
            expect(eventType).toEqual(EventType.RoomPowerLevels);
            expect(stateKey).toEqual("");
            expect(content).toMatchObject({
                ...pls,
                users: {
                    [targetUser]: expectedPl,
                },
            });
            return Promise.resolve();
        });
        client.sendStateEvent = fn;
        await tree.setPermissions(targetUser, role);
        expect(fn.mock.calls.length).toBe(1);
    }

    it('should support setting Viewer permissions', () => {
        return evaluatePowerLevels({
            ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
            users_default: 1024,
        }, TreePermissions.Viewer, 1024);
    });

    it('should support setting Editor permissions', () => {
        return evaluatePowerLevels({
            ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
            events_default: 1024,
        }, TreePermissions.Editor, 1024);
    });

    it('should support setting Owner permissions', () => {
        return evaluatePowerLevels({
            ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
            events: {
                [EventType.RoomPowerLevels]: 1024,
            },
        }, TreePermissions.Owner, 1024);
    });

    it('should support demoting permissions', () => {
        return evaluatePowerLevels({
            ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
            users_default: 1024,
            users: {
                [targetUser]: 2222,
            }
        }, TreePermissions.Viewer, 1024);
    });

    it('should support promoting permissions', () => {
        return evaluatePowerLevels({
            ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
            events_default: 1024,
            users: {
                [targetUser]: 5,
            }
        }, TreePermissions.Editor, 1024);
    });

    it('should support defaults: Viewer', () => {
        return evaluatePowerLevels({}, TreePermissions.Viewer, 0);
    });

    it('should support defaults: Editor', () => {
        return evaluatePowerLevels({}, TreePermissions.Editor, 50);
    });

    it('should support defaults: Owner', () => {
        return evaluatePowerLevels({}, TreePermissions.Owner, 100);
    });
});
