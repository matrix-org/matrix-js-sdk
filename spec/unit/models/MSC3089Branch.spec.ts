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
import { UNSTABLE_MSC3089_BRANCH } from "../../../src/@types/event";
import { EventTimelineSet } from "../../../src/models/event-timeline-set";
import { EventTimeline } from "../../../src/models/event-timeline";
import { MSC3089Branch } from "../../../src/models/MSC3089Branch";

describe("MSC3089Branch", () => {
    let client: MatrixClient;
    // @ts-ignore - TS doesn't know that this is a type
    let indexEvent: MatrixEvent;
    let branch: MSC3089Branch;

    const branchRoomId = "!room:example.org";
    const fileEventId = "$file";

    const staticTimelineSets = {} as EventTimelineSet;
    const staticRoom = {
        getUnfilteredTimelineSet: () => staticTimelineSets,
    } as any as Room; // partial

    beforeEach(() => {
        // TODO: Use utility functions to create test rooms and clients
        client = <MatrixClient>{
            getRoom: (roomId: string) => {
                if (roomId === branchRoomId) {
                    return staticRoom;
                } else {
                    throw new Error("Unexpected fetch for unknown room");
                }
            },
        };
        indexEvent = {
            getRoomId: () => branchRoomId,
            getStateKey: () => fileEventId,
        };
        branch = new MSC3089Branch(client, indexEvent);
    });

    it('should know the file event ID', () => {
        expect(branch.id).toEqual(fileEventId);
    });

    it('should know if the file is active or not', () => {
        indexEvent.getContent = () => ({});
        expect(branch.isActive).toBe(false);
        indexEvent.getContent = () => ({ active: false });
        expect(branch.isActive).toBe(false);
        indexEvent.getContent = () => ({ active: true });
        expect(branch.isActive).toBe(true);
        indexEvent.getContent = () => ({ active: "true" }); // invalid boolean, inactive
        expect(branch.isActive).toBe(false);
    });

    it('should be able to delete the file', async () => {
        const stateFn = jest.fn()
            .mockImplementation((roomId: string, eventType: string, content: any, stateKey: string) => {
                expect(roomId).toEqual(branchRoomId);
                expect(eventType).toEqual(UNSTABLE_MSC3089_BRANCH.unstable); // test that we're definitely using the unstable value
                expect(content).toMatchObject({});
                expect(content['active']).toBeUndefined();
                expect(stateKey).toEqual(fileEventId);

                return Promise.resolve(); // return value not used
            });
        client.sendStateEvent = stateFn;

        const redactFn = jest.fn().mockImplementation((roomId: string, eventId: string) => {
            expect(roomId).toEqual(branchRoomId);
            expect(eventId).toEqual(fileEventId);

            return Promise.resolve(); // return value not used
        });
        client.redactEvent = redactFn;

        await branch.delete();

        expect(stateFn).toHaveBeenCalledTimes(1);
        expect(redactFn).toHaveBeenCalledTimes(1);
    });

    it('should know its name', async () => {
        const name = "My File.txt";
        indexEvent.getContent = () => ({ active: true, name: name });

        const res = branch.getName();

        expect(res).toEqual(name);
    });

    it('should be able to change its name', async () => {
        const name = "My File.txt";
        indexEvent.getContent = () => ({ active: true, retained: true });
        const stateFn = jest.fn()
            .mockImplementation((roomId: string, eventType: string, content: any, stateKey: string) => {
                expect(roomId).toEqual(branchRoomId);
                expect(eventType).toEqual(UNSTABLE_MSC3089_BRANCH.unstable); // test that we're definitely using the unstable value
                expect(content).toMatchObject({
                    retained: true, // canary for copying state
                    active: true,
                    name: name,
                });
                expect(stateKey).toEqual(fileEventId);

                return Promise.resolve(); // return value not used
            });
        client.sendStateEvent = stateFn;

        await branch.setName(name);

        expect(stateFn).toHaveBeenCalledTimes(1);
    });

    it('should be able to return event information', async () => {
        const mxcLatter = "example.org/file";
        const fileContent = { isFile: "not quite", url: "mxc://" + mxcLatter };
        const eventsArr = [
            { getId: () => "$not-file", getContent: () => ({}) },
            { getId: () => fileEventId, getContent: () => ({ file: fileContent }) },
        ];
        client.getEventTimeline = () => Promise.resolve({
            getEvents: () => eventsArr,
        }) as any as Promise<EventTimeline>; // partial
        client.mxcUrlToHttp = (mxc: string) => {
            expect(mxc).toEqual("mxc://" + mxcLatter);
            return `https://example.org/_matrix/media/v1/download/${mxcLatter}`;
        };
        client.decryptEventIfNeeded = () => Promise.resolve();

        const res = await branch.getFileInfo();
        expect(res).toBeDefined();
        expect(res).toMatchObject({
            info: fileContent,
            // Escape regex from MDN guides: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
            httpUrl: expect.stringMatching(`.+${mxcLatter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
        });
    });
});
