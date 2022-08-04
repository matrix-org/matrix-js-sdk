/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

// eslint-disable-next-line no-restricted-imports
import EventEmitter from "events";
import MockHttpBackend from "matrix-mock-request";

import { SlidingSync, SlidingSyncState, ExtensionState, SlidingSyncEvent } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";
import { logger } from "../../src/logger";
import { MatrixClient } from "../../src";
import { sleep } from "../../src/utils";

/**
 * Tests for sliding sync. These tests are broken down into sub-tests which are reliant upon one another.
 * Each test suite (describe block) uses a single MatrixClient/HTTPBackend and a single SlidingSync class.
 * Each test will call different functions on SlidingSync which may depend on state from previous tests.
 */
describe("SlidingSync", () => {
    let client: MatrixClient = null;
    let httpBackend: MockHttpBackend = null;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const proxyBaseUrl = "http://localhost:8008";
    const syncUrl = proxyBaseUrl + "/_matrix/client/unstable/org.matrix.msc3575/sync";

    // assign client/httpBackend globals
    const setupClient = () => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
    };

    // tear down client/httpBackend globals
    const teardownClient = () => {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        return httpBackend.stop();
    };

    describe("start/stop", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        let slidingSync: SlidingSync;

        it("should start the sync loop upon calling start()", async () => {
            slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            const fakeResp = {
                pos: "a",
                lists: [],
                rooms: {},
                extensions: {},
            };
            httpBackend.when("POST", syncUrl).respond(200, fakeResp);
            const p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                expect(state).toEqual(SlidingSyncState.RequestFinished);
                expect(resp).toEqual(fakeResp);
                expect(err).toBeFalsy();
                return true;
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await p;
        });

        it("should stop the sync loop upon calling stop()", () => {
            slidingSync.stop();
            httpBackend.verifyNoOutstandingExpectation();
        });
    });

    describe("room subscriptions", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        const roomId = "!foo:bar";
        const anotherRoomID = "!another:room";
        let roomSubInfo = {
            timeline_limit: 1,
            required_state: [
                ["m.room.name", ""],
            ],
        };
        const wantRoomData = {
            name: "foo bar",
            required_state: [],
            timeline: [],
        };

        let slidingSync: SlidingSync;

        it("should be able to subscribe to a room", async () => {
            // add the subscription
            slidingSync = new SlidingSync(proxyBaseUrl, [], roomSubInfo, client, 1);
            slidingSync.modifyRoomSubscriptions(new Set([roomId]));
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("room sub", body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(roomSubInfo);
            }).respond(200, {
                pos: "a",
                lists: [],
                extensions: {},
                rooms: {
                    [roomId]: wantRoomData,
                },
            });

            const p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(roomId);
                expect(gotRoomData).toEqual(wantRoomData);
                return true;
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await p;
        });

        it("should be possible to adjust room subscription info whilst syncing", async () => {
            // listen for updated request
            const newSubInfo = {
                timeline_limit: 100,
                required_state: [
                    ["m.room.member", "*"],
                ],
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("adjusted sub", body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(newSubInfo);
            }).respond(200, {
                pos: "a",
                lists: [],
                extensions: {},
                rooms: {
                    [roomId]: wantRoomData,
                },
            });

            const p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(roomId);
                expect(gotRoomData).toEqual(wantRoomData);
                return true;
            });

            slidingSync.modifyRoomSubscriptionInfo(newSubInfo);
            await httpBackend.flushAllExpected();
            await p;
            // need to set what the new subscription info is for subsequent tests
            roomSubInfo = newSubInfo;
        });

        it("should be possible to add room subscriptions whilst syncing", async () => {
            // listen for updated request
            const anotherRoomData = {
                name: "foo bar 2",
                room_id: anotherRoomID,
                // we should not fall over if fields are missing.
                // required_state: [],
                // timeline: [],
            };
            const anotherRoomDataFixed = {
                name: anotherRoomData.name,
                room_id: anotherRoomID,
                required_state: [],
                timeline: [],
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("new subs", body);
                expect(body.room_subscriptions).toBeTruthy();
                // only the new room is sent, the other is sticky
                expect(body.room_subscriptions[anotherRoomID]).toEqual(roomSubInfo);
                expect(body.room_subscriptions[roomId]).toBeUndefined();
            }).respond(200, {
                pos: "b",
                lists: [],
                extensions: {},
                rooms: {
                    [anotherRoomID]: anotherRoomData,
                },
            });

            const p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(anotherRoomID);
                expect(gotRoomData).toEqual(anotherRoomDataFixed);
                return true;
            });

            const subs = slidingSync.getRoomSubscriptions();
            subs.add(anotherRoomID);
            slidingSync.modifyRoomSubscriptions(subs);
            await httpBackend.flushAllExpected();
            await p;
        });

        it("should be able to unsubscribe from a room", async () => {
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("unsub request", body);
                expect(body.room_subscriptions).toBeFalsy();
                expect(body.unsubscribe_rooms).toEqual([roomId]);
            }).respond(200, {
                pos: "b",
                lists: [],
            });

            const p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });

            // remove the subscription for the first room
            slidingSync.modifyRoomSubscriptions(new Set([anotherRoomID]));

            await httpBackend.flushAllExpected();
            await p;

            slidingSync.stop();
        });
    });

    describe("lists", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);

        const roomA = "!a:localhost";
        const roomB = "!b:localhost";
        const roomC = "!c:localhost";
        const rooms = {
            [roomA]: {
                name: "A",
                required_state: [],
                timeline: [],
            },
            [roomB]: {
                name: "B",
                required_state: [],
                timeline: [],
            },
            [roomC]: {
                name: "C",
                required_state: [],
                timeline: [],
            },
        };
        const newRanges = [[0, 2], [3, 5]];

        let slidingSync: SlidingSync;
        it("should be possible to subscribe to a list", async () => {
            // request first 3 rooms
            const listReq = {
                ranges: [[0, 2]],
                sort: ["by_name"],
                timeline_limit: 1,
                required_state: [
                    ["m.room.topic", ""],
                ],
                filters: {
                    is_dm: true,
                },
            };
            slidingSync = new SlidingSync(proxyBaseUrl, [listReq], {}, client, 1);
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("list", body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual(listReq);
            }).respond(200, {
                pos: "a",
                lists: [{
                    count: 500,
                    ops: [{
                        op: "SYNC",
                        range: [0, 2],
                        room_ids: Object.keys(rooms),
                    }],
                }],
                rooms: rooms,
            });
            const listenerData = {};
            const dataListener = (roomId, roomData) => {
                expect(listenerData[roomId]).toBeFalsy();
                listenerData[roomId] = roomData;
            };
            slidingSync.on(SlidingSyncEvent.RoomData, dataListener);
            const responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await responseProcessed;

            expect(listenerData[roomA]).toEqual(rooms[roomA]);
            expect(listenerData[roomB]).toEqual(rooms[roomB]);
            expect(listenerData[roomC]).toEqual(rooms[roomC]);

            expect(slidingSync.listLength()).toEqual(1);
            slidingSync.off(SlidingSyncEvent.RoomData, dataListener);
        });

        it("should be possible to retrieve list data", () => {
            expect(slidingSync.getList(0)).toBeDefined();
            expect(slidingSync.getList(5)).toBeNull();
            expect(slidingSync.getListData(5)).toBeNull();
            const syncData = slidingSync.getListData(0);
            expect(syncData.joinedCount).toEqual(500); // from previous test
            expect(syncData.roomIndexToRoomId).toEqual({
                0: roomA,
                1: roomB,
                2: roomC,
            });
        });

        it("should be possible to adjust list ranges", async () => {
            // modify the list ranges
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("next ranges", body.lists[0].ranges);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual({
                    // only the ranges should be sent as the rest are unchanged and sticky
                    ranges: newRanges,
                });
            }).respond(200, {
                pos: "b",
                lists: [{
                    count: 500,
                    ops: [{
                        op: "SYNC",
                        range: [0, 2],
                        room_ids: Object.keys(rooms),
                    }],
                }],
            });

            const responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.RequestFinished;
            });
            slidingSync.setListRanges(0, newRanges);
            await httpBackend.flushAllExpected();
            await responseProcessed;
        });

        it("should be possible to add an extra list", async () => {
            // add extra list
            const extraListReq = {
                ranges: [[0, 100]],
                sort: ["by_name"],
                filters: {
                    "is_dm": true,
                },
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("extra list", body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual({
                    // only the ranges should be sent as the rest are unchanged and sticky
                    ranges: newRanges,
                });
                expect(body.lists[1]).toEqual(extraListReq);
            }).respond(200, {
                pos: "c",
                lists: [
                    {
                        count: 500,
                    },
                    {
                        count: 50,
                        ops: [{
                            op: "SYNC",
                            range: [0, 2],
                            room_ids: Object.keys(rooms),
                        }],
                    },
                ],
            });
            listenUntil(slidingSync, "SlidingSync.List", (listIndex, joinedCount, roomIndexToRoomId) => {
                expect(listIndex).toEqual(1);
                expect(joinedCount).toEqual(50);
                expect(roomIndexToRoomId).toEqual({
                    0: roomA,
                    1: roomB,
                    2: roomC,
                });
                return true;
            });
            const responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            slidingSync.setList(1, extraListReq);
            await httpBackend.flushAllExpected();
            await responseProcessed;
        });

        it("should be possible to get list DELETE/INSERTs", async () => {
            // move C (2) to A (0)
            httpBackend.when("POST", syncUrl).respond(200, {
                pos: "e",
                lists: [{
                    count: 500,
                    ops: [{
                        op: "DELETE",
                        index: 2,
                    }, {
                        op: "INSERT",
                        index: 0,
                        room_id: roomC,
                    }],
                },
                {
                    count: 50,
                }],
            });
            let listPromise = listenUntil(slidingSync, "SlidingSync.List",
                (listIndex, joinedCount, roomIndexToRoomId) => {
                    expect(listIndex).toEqual(0);
                    expect(joinedCount).toEqual(500);
                    expect(roomIndexToRoomId).toEqual({
                        0: roomC,
                        1: roomA,
                        2: roomB,
                    });
                    return true;
                });
            let responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            await httpBackend.flushAllExpected();
            await responseProcessed;
            await listPromise;

            // move C (0) back to A (2)
            httpBackend.when("POST", syncUrl).respond(200, {
                pos: "f",
                lists: [{
                    count: 500,
                    ops: [{
                        op: "DELETE",
                        index: 0,
                    }, {
                        op: "INSERT",
                        index: 2,
                        room_id: roomC,
                    }],
                },
                {
                    count: 50,
                }],
            });
            listPromise = listenUntil(slidingSync, "SlidingSync.List",
                (listIndex, joinedCount, roomIndexToRoomId) => {
                    expect(listIndex).toEqual(0);
                    expect(joinedCount).toEqual(500);
                    expect(roomIndexToRoomId).toEqual({
                        0: roomA,
                        1: roomB,
                        2: roomC,
                    });
                    return true;
                });
            responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            await httpBackend.flushAllExpected();
            await responseProcessed;
            await listPromise;
        });

        it("should ignore invalid list indexes", async () => {
            httpBackend.when("POST", syncUrl).respond(200, {
                pos: "e",
                lists: [{
                    count: 500,
                    ops: [{
                        op: "DELETE",
                        index: 2324324,
                    }],
                },
                {
                    count: 50,
                }],
            });
            const listPromise = listenUntil(slidingSync, "SlidingSync.List",
                (listIndex, joinedCount, roomIndexToRoomId) => {
                    expect(listIndex).toEqual(0);
                    expect(joinedCount).toEqual(500);
                    expect(roomIndexToRoomId).toEqual({
                        0: roomA,
                        1: roomB,
                        2: roomC,
                    });
                    return true;
                });
            const responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            await httpBackend.flushAllExpected();
            await responseProcessed;
            await listPromise;
        });

        it("should be possible to update a list", async () => {
            httpBackend.when("POST", syncUrl).respond(200, {
                pos: "g",
                lists: [{
                    count: 42,
                    ops: [
                        {
                            op: "INVALIDATE",
                            range: [0, 2],
                        },
                        {
                            op: "SYNC",
                            range: [0, 1],
                            room_ids: [roomB, roomC],
                        },
                    ],
                },
                {
                    count: 50,
                }],
            });
            // update the list with a new filter
            slidingSync.setList(0, {
                filters: {
                    is_encrypted: true,
                },
                ranges: [[0, 100]],
            });
            const listPromise = listenUntil(slidingSync, "SlidingSync.List",
                (listIndex, joinedCount, roomIndexToRoomId) => {
                    expect(listIndex).toEqual(0);
                    expect(joinedCount).toEqual(42);
                    expect(roomIndexToRoomId).toEqual({
                        0: roomB,
                        1: roomC,
                    });
                    return true;
                });
            const responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
            await httpBackend.flushAllExpected();
            await responseProcessed;
            await listPromise;
            slidingSync.stop();
        });
    });

    describe("extensions", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        let slidingSync: SlidingSync;
        const extReq = {
            foo: "bar",
        };
        const extResp = {
            baz: "quuz",
        };

        // Pre-extensions get called BEFORE processing the sync response
        const preExtName = "foobar";
        let onPreExtensionRequest;
        let onPreExtensionResponse;

        // Post-extensions get called AFTER processing the sync response
        const postExtName = "foobar2";
        let onPostExtensionRequest;
        let onPostExtensionResponse;

        const extPre = {
            name: () => preExtName,
            onRequest: (initial) => { return onPreExtensionRequest(initial); },
            onResponse: (res) => { return onPreExtensionResponse(res); },
            when: () => ExtensionState.PreProcess,
        };
        const extPost = {
            name: () => postExtName,
            onRequest: (initial) => { return onPostExtensionRequest(initial); },
            onResponse: (res) => { return onPostExtensionResponse(res); },
            when: () => ExtensionState.PostProcess,
        };

        it("should be able to register an extension", async () => {
            slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            slidingSync.registerExtension(extPre);

            const callbackOrder = [];
            let extensionOnResponseCalled = false;
            onPreExtensionRequest = () => {
                return extReq;
            };
            onPreExtensionResponse = (resp) => {
                extensionOnResponseCalled = true;
                callbackOrder.push("onPreExtensionResponse");
                expect(resp).toEqual(extResp);
            };

            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("ext req", body);
                expect(body.extensions).toBeTruthy();
                expect(body.extensions[preExtName]).toEqual(extReq);
            }).respond(200, {
                pos: "a",
                ops: [],
                counts: [],
                extensions: {
                    [preExtName]: extResp,
                },
            });

            const p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                if (state === SlidingSyncState.Complete) {
                    callbackOrder.push("Lifecycle");
                    return true;
                }
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await p;
            expect(extensionOnResponseCalled).toBe(true);
            expect(callbackOrder).toEqual(["onPreExtensionResponse", "Lifecycle"]);
        });

        it("should be able to send nothing in an extension request/response", async () => {
            onPreExtensionRequest = () => {
                return undefined;
            };
            let responseCalled = false;
            onPreExtensionResponse = (resp) => {
                responseCalled = true;
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("ext req nothing", body);
                expect(body.extensions).toBeTruthy();
                expect(body.extensions[preExtName]).toBeUndefined();
            }).respond(200, {
                pos: "a",
                ops: [],
                counts: [],
                extensions: {},
            });
            // we need to resend as sliding sync will already have a buffered request with the old
            // extension values from the previous test.
            slidingSync.resend();

            const p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                return state === SlidingSyncState.Complete;
            });
            await httpBackend.flushAllExpected();
            await p;
            expect(responseCalled).toBe(false);
        });

        it("is possible to register extensions after start() has been called", async () => {
            slidingSync.registerExtension(extPost);
            onPostExtensionRequest = () => {
                return extReq;
            };
            let responseCalled = false;
            const callbackOrder = [];
            onPostExtensionResponse = (resp) => {
                expect(resp).toEqual(extResp);
                responseCalled = true;
                callbackOrder.push("onPostExtensionResponse");
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                const body = req.data;
                logger.log("ext req after start", body);
                expect(body.extensions).toBeTruthy();
                expect(body.extensions[preExtName]).toBeUndefined(); // from the earlier test
                expect(body.extensions[postExtName]).toEqual(extReq);
            }).respond(200, {
                pos: "c",
                ops: [],
                counts: [],
                extensions: {
                    [postExtName]: extResp,
                },
            });
            // we need to resend as sliding sync will already have a buffered request with the old
            // extension values from the previous test.
            slidingSync.resend();

            const p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                if (state === SlidingSyncState.Complete) {
                    callbackOrder.push("Lifecycle");
                    return true;
                }
            });
            await httpBackend.flushAllExpected();
            await p;
            expect(responseCalled).toBe(true);
            expect(callbackOrder).toEqual(["Lifecycle", "onPostExtensionResponse"]);
            slidingSync.stop();
        });

        it("is not possible to register the same extension name twice", async () => {
            slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            slidingSync.registerExtension(extPre);
            expect(() => { slidingSync.registerExtension(extPre); }).toThrow();
        });
    });
});

async function timeout(delayMs: number, reason: string): Promise<never> {
    await sleep(delayMs);
    throw new Error(`timeout: ${delayMs}ms - ${reason}`);
}

/**
 * Listen until a callback returns data.
 * @param {EventEmitter} emitter The event emitter
 * @param {string} eventName The event to listen for
 * @param {function} callback The callback which will be invoked when events fire. Return something truthy from this to resolve the promise.
 * @param {number} timeoutMs The number of milliseconds to wait for the callback to return data. Default: 500ms.
 * @returns {Promise} A promise which will be resolved when the callback returns data. If the callback throws or the timeout is reached,
 * the promise is rejected.
 */
function listenUntil<T>(
    emitter: EventEmitter,
    eventName: string,
    callback: (...args: any[]) => T,
    timeoutMs = 500,
): Promise<T> {
    const trace = new Error().stack.split(`\n`)[2];
    return Promise.race([new Promise<T>((resolve, reject) => {
        const wrapper = (...args) => {
            try {
                const data = callback(...args);
                if (data) {
                    emitter.off(eventName, wrapper);
                    resolve(data);
                }
            } catch (err) {
                reject(err);
            }
        };
        emitter.on(eventName, wrapper);
    }), timeout(timeoutMs, "timed out waiting for event " + eventName + " " + trace)]);
}
