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

import { logger } from "../../src/logger";
import { MatrixClient } from "../../src/client";
import { Filter } from "../../src/filter";
import { DEFAULT_TREE_POWER_LEVELS_TEMPLATE } from "../../src/models/MSC3089TreeSpace";
import {
    EventType,
    RoomCreateTypeField,
    RoomType,
    UNSTABLE_MSC3088_ENABLED,
    UNSTABLE_MSC3088_PURPOSE,
    UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "../../src/@types/event";
import { MEGOLM_ALGORITHM } from "../../src/crypto/olmlib";
import { EventStatus, MatrixEvent } from "../../src/models/event";
import { Preset } from "../../src/@types/partials";
import { ReceiptType } from "../../src/@types/read_receipts";
import * as testUtils from "../test-utils/test-utils";
import { makeBeaconInfoContent } from "../../src/content-helpers";
import { M_BEACON_INFO } from "../../src/@types/beacon";
import { ContentHelpers, Room } from "../../src";
import { makeBeaconEvent } from "../test-utils/beacon";

jest.useFakeTimers();

describe("MatrixClient", function() {
    const userId = "@alice:bar";
    const identityServerUrl = "https://identity.server";
    const identityServerDomain = "identity.server";
    let client;
    let store;
    let scheduler;

    const KEEP_ALIVE_PATH = "/_matrix/client/versions";

    const PUSH_RULES_RESPONSE = {
        method: "GET",
        path: "/pushrules/",
        data: {},
    };

    const FILTER_PATH = "/user/" + encodeURIComponent(userId) + "/filter";

    const FILTER_RESPONSE = {
        method: "POST",
        path: FILTER_PATH,
        data: { filter_id: "f1lt3r" },
    };

    const SYNC_DATA = {
        next_batch: "s_5_3",
        presence: { events: [] },
        rooms: {},
    };

    const SYNC_RESPONSE = {
        method: "GET",
        path: "/sync",
        data: SYNC_DATA,
    };

    let httpLookups = [
        // items are objects which look like:
        // {
        //   method: "GET",
        //   path: "/initialSync",
        //   data: {},
        //   error: { errcode: M_FORBIDDEN } // if present will reject promise,
        //   expectBody: {} // additional expects on the body
        //   expectQueryParams: {} // additional expects on query params
        //   thenCall: function(){} // function to call *AFTER* returning response.
        // }
        // items are popped off when processed and block if no items left.
    ];
    let acceptKeepalives: boolean;
    let pendingLookup = null;
    function httpReq(cb, method, path, qp, data, prefix) {
        if (path === KEEP_ALIVE_PATH && acceptKeepalives) {
            return Promise.resolve({
                unstable_features: {
                    "org.matrix.msc3440.stable": true,
                },
                versions: ["r0.6.0", "r0.6.1"],
            });
        }
        const next = httpLookups.shift();
        const logLine = (
            "MatrixClient[UT] RECV " + method + " " + path + "  " +
            "EXPECT " + (next ? next.method : next) + " " + (next ? next.path : next)
        );
        logger.log(logLine);

        if (!next) { // no more things to return
            if (pendingLookup) {
                if (pendingLookup.method === method && pendingLookup.path === path) {
                    return pendingLookup.promise;
                }
                // >1 pending thing, and they are different, whine.
                expect(false).toBe(true);
            }
            pendingLookup = {
                promise: new Promise(() => {}),
                method: method,
                path: path,
            };
            pendingLookup.promise.abort = () => {}; // to make it a valid IAbortablePromise
            return pendingLookup.promise;
        }
        if (next.path === path && next.method === method) {
            logger.log(
                "MatrixClient[UT] Matched. Returning " +
                (next.error ? "BAD" : "GOOD") + " response",
            );
            if (next.expectBody) {
                expect(data).toEqual(next.expectBody);
            }
            if (next.expectQueryParams) {
                Object.keys(next.expectQueryParams).forEach(function(k) {
                    expect(qp[k]).toEqual(next.expectQueryParams[k]);
                });
            }

            if (next.thenCall) {
                process.nextTick(next.thenCall, 0); // next tick so we return first.
            }

            if (next.error) {
                // eslint-disable-next-line
                return Promise.reject({
                    errcode: next.error.errcode,
                    httpStatus: next.error.httpStatus,
                    name: next.error.errcode,
                    message: "Expected testing error",
                    data: next.error,
                });
            }
            return Promise.resolve(next.data);
        }
        // Jest doesn't let us have custom expectation errors, so if you're seeing this then
        // you forgot to handle at least 1 pending request. Check your tests to ensure your
        // number of expectations lines up with your number of requests made, and that those
        // requests match your expectations.
        expect(true).toBe(false);
        return new Promise(() => {});
    }

    beforeEach(function() {
        scheduler = [
            "getQueueForEvent", "queueEvent", "removeEventFromQueue",
            "setProcessFunction",
        ].reduce((r, k) => { r[k] = jest.fn(); return r; }, {});
        store = [
            "getRoom", "getRooms", "getUser", "getSyncToken", "scrollback",
            "save", "wantsSave", "setSyncToken", "storeEvents", "storeRoom", "storeUser",
            "getFilterIdByName", "setFilterIdByName", "getFilter", "storeFilter",
            "getSyncAccumulator", "startup", "deleteAllData",
        ].reduce((r, k) => { r[k] = jest.fn(); return r; }, {});
        store.getSavedSync = jest.fn().mockReturnValue(Promise.resolve(null));
        store.getSavedSyncToken = jest.fn().mockReturnValue(Promise.resolve(null));
        store.setSyncData = jest.fn().mockReturnValue(Promise.resolve(null));
        store.getClientOptions = jest.fn().mockReturnValue(Promise.resolve(null));
        store.storeClientOptions = jest.fn().mockReturnValue(Promise.resolve(null));
        store.isNewlyCreated = jest.fn().mockReturnValue(Promise.resolve(true));
        client = new MatrixClient({
            baseUrl: "https://my.home.server",
            idBaseUrl: identityServerUrl,
            accessToken: "my.access.token",
            request: function() {} as any, // NOP
            store: store,
            scheduler: scheduler,
            userId: userId,
        });
        // FIXME: We shouldn't be yanking http like this.
        client.http = [
            "authedRequest", "getContentUri", "request", "uploadContent",
        ].reduce((r, k) => { r[k] = jest.fn(); return r; }, {});
        client.http.authedRequest.mockImplementation(httpReq);
        client.http.request.mockImplementation(httpReq);

        // set reasonable working defaults
        acceptKeepalives = true;
        pendingLookup = null;
        httpLookups = [];
        httpLookups.push(PUSH_RULES_RESPONSE);
        httpLookups.push(FILTER_RESPONSE);
        httpLookups.push(SYNC_RESPONSE);
    });

    afterEach(function() {
        // need to re-stub the requests with NOPs because there are no guarantees
        // clients from previous tests will be GC'd before the next test. This
        // means they may call /events and then fail an expect() which will fail
        // a DIFFERENT test (pollution between tests!) - we return unresolved
        // promises to stop the client from continuing to run.
        client.http.authedRequest.mockImplementation(function() {
            return new Promise(() => {});
        });
        client.stopClient();
    });

    it("should create (unstable) file trees", async () => {
        const userId = "@test:example.org";
        const roomId = "!room:example.org";
        const roomName = "Test Tree";
        const mockRoom = {};
        const fn = jest.fn().mockImplementation((opts) => {
            expect(opts).toMatchObject({
                name: roomName,
                preset: Preset.PrivateChat,
                power_level_content_override: {
                    ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
                    users: {
                        [userId]: 100,
                    },
                },
                creation_content: {
                    [RoomCreateTypeField]: RoomType.Space,
                },
                initial_state: [
                    {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        type: UNSTABLE_MSC3088_PURPOSE.unstable,
                        state_key: UNSTABLE_MSC3089_TREE_SUBTYPE.unstable,
                        content: {
                            [UNSTABLE_MSC3088_ENABLED.unstable]: true,
                        },
                    },
                    {
                        type: EventType.RoomEncryption,
                        state_key: "",
                        content: {
                            algorithm: MEGOLM_ALGORITHM,
                        },
                    },
                ],
            });
            return { room_id: roomId };
        });
        client.getUserId = () => userId;
        client.createRoom = fn;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = await client.unstableCreateFileTree(roomName);
        expect(tree).toBeDefined();
        expect(tree.roomId).toEqual(roomId);
        expect(tree.room).toBe(mockRoom);
        expect(fn.mock.calls.length).toBe(1);
    });

    it("should get (unstable) file trees with valid state", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => "join",
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: RoomType.Space,
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable]: true,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            },
        };
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeDefined();
        expect(tree.roomId).toEqual(roomId);
        expect(tree.room).toBe(mockRoom);
    });

    it("should not get (unstable) file trees if not joined", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => "leave", // "not join"
        };
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees for unknown rooms", async () => {
        const roomId = "!room:example.org";
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return null; // imply unknown
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees with invalid create contents", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => "join",
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: "org.example.not_space",
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable]: true,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            },
        };
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees with invalid purpose/subtype contents", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => "join",
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: RoomType.Space,
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable]: false,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            },
        };
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not POST /filter if a matching filter already exists", async function() {
        httpLookups = [
            PUSH_RULES_RESPONSE,
            SYNC_RESPONSE,
        ];
        const filterId = "ehfewf";
        store.getFilterIdByName.mockReturnValue(filterId);
        const filter = new Filter("0", filterId);
        filter.setDefinition({ "room": { "timeline": { "limit": 8 } } });
        store.getFilter.mockReturnValue(filter);
        const syncPromise = new Promise<void>((resolve, reject) => {
            client.on("sync", function syncListener(state) {
                if (state === "SYNCING") {
                    expect(httpLookups.length).toEqual(0);
                    client.removeListener("sync", syncListener);
                    resolve();
                } else if (state === "ERROR") {
                    reject(new Error("sync error"));
                }
            });
        });
        await client.startClient();
        await syncPromise;
    });

    describe("getSyncState", function() {
        it("should return null if the client isn't started", function() {
            expect(client.getSyncState()).toBe(null);
        });

        it("should return the same sync state as emitted sync events", async function() {
            const syncingPromise = new Promise<void>((resolve) => {
                client.on("sync", function syncListener(state) {
                    expect(state).toEqual(client.getSyncState());
                    if (state === "SYNCING") {
                        client.removeListener("sync", syncListener);
                        resolve();
                    }
                });
            });
            await client.startClient();
            await syncingPromise;
        });
    });

    describe("getOrCreateFilter", function() {
        it("should POST createFilter if no id is present in localStorage", function() {
        });
        it("should use an existing filter if id is present in localStorage", function() {
        });
        it("should handle localStorage filterId missing from the server", function(done) {
            function getFilterName(userId, suffix?: string) {
                // scope this on the user ID because people may login on many accounts
                // and they all need to be stored!
                return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
            }
            const invalidFilterId = 'invalidF1lt3r';
            httpLookups = [];
            httpLookups.push({
                method: "GET",
                path: FILTER_PATH + '/' + invalidFilterId,
                error: {
                    errcode: "M_UNKNOWN",
                    name: "M_UNKNOWN",
                    message: "No row found",
                    data: { errcode: "M_UNKNOWN", error: "No row found" },
                    httpStatus: 404,
                },
            });
            httpLookups.push(FILTER_RESPONSE);
            store.getFilterIdByName.mockReturnValue(invalidFilterId);

            const filterName = getFilterName(client.credentials.userId);
            client.store.setFilterIdByName(filterName, invalidFilterId);
            const filter = new Filter(client.credentials.userId);

            client.getOrCreateFilter(filterName, filter).then(function(filterId) {
                expect(filterId).toEqual(FILTER_RESPONSE.data.filter_id);
                done();
            });
        });
    });

    describe("retryImmediately", function() {
        it("should return false if there is no request waiting", async function() {
            httpLookups = [];
            await client.startClient();
            expect(client.retryImmediately()).toBe(false);
        });

        it("should work on /filter", function(done) {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST", path: FILTER_PATH, error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(2);
                    expect(client.retryImmediately()).toBe(true);
                    jest.advanceTimersByTime(1);
                } else if (state === "PREPARED" && httpLookups.length === 0) {
                    client.removeListener("sync", syncListener);
                    done();
                } else {
                    // unexpected state transition!
                    expect(state).toEqual(null);
                }
            });
            client.startClient();
        });

        it("should work on /sync", function(done) {
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push({
                method: "GET", path: "/sync", data: SYNC_DATA,
            });

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(1);
                    expect(client.retryImmediately()).toBe(
                        true,
                    );
                    jest.advanceTimersByTime(1);
                } else if (state === "RECONNECTING" && httpLookups.length > 0) {
                    jest.advanceTimersByTime(10000);
                } else if (state === "SYNCING" && httpLookups.length === 0) {
                    client.removeListener("sync", syncListener);
                    done();
                }
            });
            client.startClient();
        });

        it("should work on /pushrules", function(done) {
            httpLookups = [];
            httpLookups.push({
                method: "GET", path: "/pushrules/", error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(3);
                    expect(client.retryImmediately()).toBe(true);
                    jest.advanceTimersByTime(1);
                } else if (state === "PREPARED" && httpLookups.length === 0) {
                    client.removeListener("sync", syncListener);
                    done();
                } else {
                    // unexpected state transition!
                    expect(state).toEqual(null);
                }
            });
            client.startClient();
        });
    });

    describe("emitted sync events", function() {
        function syncChecker(expectedStates, done) {
            return function syncListener(state, old) {
                const expected = expectedStates.shift();
                logger.log(
                    "'sync' curr=%s old=%s EXPECT=%s", state, old, expected,
                );
                if (!expected) {
                    done();
                    return;
                }
                expect(state).toEqual(expected[0]);
                expect(old).toEqual(expected[1]);
                if (expectedStates.length === 0) {
                    client.removeListener("sync", syncListener);
                    done();
                }
                // standard retry time is 5 to 10 seconds
                jest.advanceTimersByTime(10000);
            };
        }

        it("should transition null -> PREPARED after the first /sync", function(done) {
            const expectedStates = [];
            expectedStates.push(["PREPARED", null]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition null -> ERROR after a failed /filter", function(done) {
            const expectedStates = [];
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST", path: FILTER_PATH, error: { errcode: "NOPE_NOPE_NOPE" },
            });
            expectedStates.push(["ERROR", null]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        // Disabled because now `startClient` makes a legit call to `/versions`
        // And those tests are really unhappy about it... Not possible to figure
        // out what a good resolution would look like
        xit("should transition ERROR -> CATCHUP after /sync if prev failed",
            function(done) {
                const expectedStates = [];
                acceptKeepalives = false;
                httpLookups = [];
                httpLookups.push(PUSH_RULES_RESPONSE);
                httpLookups.push(FILTER_RESPONSE);
                httpLookups.push({
                    method: "GET", path: "/sync", error: { errcode: "NOPE_NOPE_NOPE" },
                });
                httpLookups.push({
                    method: "GET", path: KEEP_ALIVE_PATH,
                    error: { errcode: "KEEPALIVE_FAIL" },
                });
                httpLookups.push({
                    method: "GET", path: KEEP_ALIVE_PATH, data: {},
                });
                httpLookups.push({
                    method: "GET", path: "/sync", data: SYNC_DATA,
                });

                expectedStates.push(["RECONNECTING", null]);
                expectedStates.push(["ERROR", "RECONNECTING"]);
                expectedStates.push(["CATCHUP", "ERROR"]);
                client.on("sync", syncChecker(expectedStates, done));
                client.startClient();
            });

        it("should transition PREPARED -> SYNCING after /sync", function(done) {
            const expectedStates = [];
            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        xit("should transition SYNCING -> ERROR after a failed /sync", function(done) {
            acceptKeepalives = false;
            const expectedStates = [];
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NONONONONO" },
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["RECONNECTING", "SYNCING"]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        xit("should transition ERROR -> SYNCING after /sync if prev failed",
            function(done) {
                const expectedStates = [];
                httpLookups.push({
                    method: "GET", path: "/sync", error: { errcode: "NONONONONO" },
                });
                httpLookups.push(SYNC_RESPONSE);

                expectedStates.push(["PREPARED", null]);
                expectedStates.push(["SYNCING", "PREPARED"]);
                expectedStates.push(["ERROR", "SYNCING"]);
                client.on("sync", syncChecker(expectedStates, done));
                client.startClient();
            });

        it("should transition SYNCING -> SYNCING on subsequent /sync successes",
            function(done) {
                const expectedStates = [];
                httpLookups.push(SYNC_RESPONSE);
                httpLookups.push(SYNC_RESPONSE);

                expectedStates.push(["PREPARED", null]);
                expectedStates.push(["SYNCING", "PREPARED"]);
                expectedStates.push(["SYNCING", "SYNCING"]);
                client.on("sync", syncChecker(expectedStates, done));
                client.startClient();
            });

        xit("should transition ERROR -> ERROR if keepalive keeps failing", function(done) {
            acceptKeepalives = false;
            const expectedStates = [];
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NONONONONO" },
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["RECONNECTING", "SYNCING"]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            expectedStates.push(["ERROR", "ERROR"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });
    });

    describe("inviteByEmail", function() {
        const roomId = "!foo:bar";

        it("should send an invite HTTP POST", function() {
            httpLookups = [{
                method: "POST",
                path: "/rooms/!foo%3Abar/invite",
                data: {},
                expectBody: {
                    id_server: identityServerDomain,
                    medium: "email",
                    address: "alice@gmail.com",
                },
            }];
            client.inviteByEmail(roomId, "alice@gmail.com");
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("guest rooms", function() {
        it("should only do /sync calls (without filter/pushrules)", async function() {
            httpLookups = []; // no /pushrules or /filter
            httpLookups.push({
                method: "GET",
                path: "/sync",
                data: SYNC_DATA,
            });
            client.setGuest(true);
            await client.startClient();
            expect(httpLookups.length).toBe(0);
        });

        xit("should be able to peek into a room using peekInRoom", function(done) {
        });
    });

    describe("getPresence", function() {
        it("should send a presence HTTP GET", function() {
            httpLookups = [{
                method: "GET",
                path: `/presence/${encodeURIComponent(userId)}/status`,
                data: {
                    "presence": "unavailable",
                    "last_active_ago": 420845,
                },
            }];
            client.getPresence(userId);
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("sendEvent", () => {
        const roomId = "!room:example.org";
        const body = "This is the body";
        const content = { body };

        it("overload without threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                data: { event_id: eventId },
                expectBody: content,
            }];

            await client.sendEvent(roomId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("overload with null threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                data: { event_id: eventId },
                expectBody: content,
            }];

            await client.sendEvent(roomId, null, EventType.RoomMessage, { ...content }, txnId);
        });

        it("overload with threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            const threadId = "$threadId:server";
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                data: { event_id: eventId },
                expectBody: {
                    ...content,
                    "m.relates_to": {
                        "event_id": threadId,
                        "is_falling_back": true,
                        "rel_type": "m.thread",
                    },
                },
            }];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("should add thread relation if threadId is passed and the relation is missing", async () => {
            const eventId = "$eventId:example.org";
            const threadId = "$threadId:server";
            const txnId = client.makeTxnId();

            const room = new Room(roomId, client, userId);
            store.getRoom.mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                data: { event_id: eventId },
                expectBody: {
                    ...content,
                    "m.relates_to": {
                        "m.in_reply_to": {
                            event_id: threadId,
                        },
                        "event_id": threadId,
                        "is_falling_back": true,
                        "rel_type": "m.thread",
                    },
                },
            }];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("should add thread relation if threadId is passed and the relation is missing with reply", async () => {
            const eventId = "$eventId:example.org";
            const threadId = "$threadId:server";
            const txnId = client.makeTxnId();

            const content = {
                body,
                "m.relates_to": {
                    "m.in_reply_to": {
                        event_id: "$other:event",
                    },
                },
            };

            const room = new Room(roomId, client, userId);
            store.getRoom.mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                data: { event_id: eventId },
                expectBody: {
                    ...content,
                    "m.relates_to": {
                        "m.in_reply_to": {
                            event_id: "$other:event",
                        },
                        "event_id": threadId,
                        "is_falling_back": false,
                        "rel_type": "m.thread",
                    },
                },
            }];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });
    });

    describe("redactEvent", () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => "join",
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomEncryption) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({ content: {} });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            },
            getThread: jest.fn(),
            addPendingEvent: jest.fn(),
            updatePendingEvent: jest.fn(),
            reEmitter: {
                reEmit: jest.fn(),
            },
        };

        beforeEach(() => {
            client.getRoom = (getRoomId) => {
                expect(getRoomId).toEqual(roomId);
                return mockRoom;
            };
        });

        it("overload without threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                data: { event_id: eventId },
            }];

            await client.redactEvent(roomId, eventId, txnId);
        });

        it("overload with null threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                data: { event_id: eventId },
            }];

            await client.redactEvent(roomId, null, eventId, txnId);
        });

        it("overload with threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                data: { event_id: eventId },
            }];

            await client.redactEvent(roomId, "$threadId:server", eventId, txnId);
        });

        it("does not get wrongly encrypted", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            const reason = "This is the redaction reason";
            httpLookups = [{
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                expectBody: { reason }, // NOT ENCRYPTED
                data: { event_id: eventId },
            }];

            await client.redactEvent(roomId, eventId, txnId, { reason });
        });
    });

    describe("cancelPendingEvent", () => {
        const roomId = "!room:server";
        const txnId = "m12345";

        const mockRoom = {
            getMyMembership: () => "join",
            updatePendingEvent: (event, status) => event.setStatus(status),
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: RoomType.Space,
                            },
                        });
                    } else if (eventType === EventType.RoomEncryption) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({ content: {} });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            },
        };

        let event;
        beforeEach(async () => {
            event = new MatrixEvent({
                event_id: "~" + roomId + ":" + txnId,
                user_id: client.credentials.userId,
                sender: client.credentials.userId,
                room_id: roomId,
                origin_server_ts: new Date().getTime(),
            });
            event.setTxnId(txnId);

            client.getRoom = (getRoomId) => {
                expect(getRoomId).toEqual(roomId);
                return mockRoom;
            };
            client.crypto = { // mock crypto
                encryptEvent: (event, room) => new Promise(() => {}),
                stop: jest.fn(),
            };
        });

        function assertCancelled() {
            expect(event.status).toBe(EventStatus.CANCELLED);
            expect(client.scheduler.removeEventFromQueue(event)).toBeFalsy();
            expect(httpLookups.filter(h => h.path.includes("/send/")).length).toBe(0);
        }

        it("should cancel an event which is queued", () => {
            event.setStatus(EventStatus.QUEUED);
            client.scheduler.queueEvent(event);
            client.cancelPendingEvent(event);
            assertCancelled();
        });

        it("should cancel an event which is encrypting", async () => {
            client.encryptAndSendEvent(null, event);
            await testUtils.emitPromise(event, "Event.status");
            client.cancelPendingEvent(event);
            assertCancelled();
        });

        it("should cancel an event which is not sent", () => {
            event.setStatus(EventStatus.NOT_SENT);
            client.cancelPendingEvent(event);
            assertCancelled();
        });

        it("should error when given any other event status", () => {
            event.setStatus(EventStatus.SENDING);
            expect(() => client.cancelPendingEvent(event)).toThrow("cannot cancel an event with status sending");
            expect(event.status).toBe(EventStatus.SENDING);
        });
    });

    describe("threads", () => {
        it("partitions root events to room timeline and thread timeline", () => {
            const supportsExperimentalThreads = client.supportsExperimentalThreads;
            client.supportsExperimentalThreads = () => true;
            const room = new Room("!room1:matrix.org", client, userId);

            const rootEvent = new MatrixEvent({
                "content": {},
                "origin_server_ts": 1,
                "room_id": "!room1:matrix.org",
                "sender": "@alice:matrix.org",
                "type": "m.room.message",
                "unsigned": {
                    "m.relations": {
                        "m.thread": {
                            "latest_event": {},
                            "count": 33,
                            "current_user_participated": false,
                        },
                    },
                },
                "event_id": "$ev1",
                "user_id": "@alice:matrix.org",
            });

            expect(rootEvent.isThreadRoot).toBe(true);

            const [roomEvents, threadEvents] = room.partitionThreadedEvents([rootEvent]);
            expect(roomEvents).toHaveLength(1);
            expect(threadEvents).toHaveLength(1);

            // Restore method
            client.supportsExperimentalThreads = supportsExperimentalThreads;
        });
    });

    describe("read-markers and read-receipts", () => {
        it("setRoomReadMarkers", () => {
            client.setRoomReadMarkersHttpRequest = jest.fn();
            const room = {
                hasPendingEvent: jest.fn().mockReturnValue(false),
                addLocalEchoReceipt: jest.fn(),
            };
            const rrEvent = new MatrixEvent({ event_id: "read_event_id" });
            const rpEvent = new MatrixEvent({ event_id: "read_private_event_id" });
            client.getRoom = () => room;

            client.setRoomReadMarkers(
                "room_id",
                "read_marker_event_id",
                rrEvent,
                rpEvent,
            );

            expect(client.setRoomReadMarkersHttpRequest).toHaveBeenCalledWith(
                "room_id",
                "read_marker_event_id",
                "read_event_id",
                "read_private_event_id",
            );
            expect(room.addLocalEchoReceipt).toHaveBeenCalledTimes(2);
            expect(room.addLocalEchoReceipt).toHaveBeenNthCalledWith(
                1,
                client.credentials.userId,
                rrEvent,
                ReceiptType.Read,
            );
            expect(room.addLocalEchoReceipt).toHaveBeenNthCalledWith(
                2,
                client.credentials.userId,
                rpEvent,
                ReceiptType.ReadPrivate,
            );
        });
    });

    describe("beacons", () => {
        const roomId = '!room:server.org';
        const content = makeBeaconInfoContent(100, true);

        beforeEach(() => {
            client.http.authedRequest.mockClear().mockResolvedValue({});
        });

        it("creates new beacon info", async () => {
            await client.unstable_createLiveBeacon(roomId, content);

            // event type combined
            const expectedEventType = M_BEACON_INFO.name;
            const [callback, method, path, queryParams, requestContent] = client.http.authedRequest.mock.calls[0];
            expect(callback).toBeFalsy();
            expect(method).toBe('PUT');
            expect(path).toEqual(
                `/rooms/${encodeURIComponent(roomId)}/state/` +
                `${encodeURIComponent(expectedEventType)}/${encodeURIComponent(userId)}`,
            );
            expect(queryParams).toBeFalsy();
            expect(requestContent).toEqual(content);
        });

        it("updates beacon info with specific event type", async () => {
            await client.unstable_setLiveBeacon(roomId, content);

            // event type combined
            const [, , path, , requestContent] = client.http.authedRequest.mock.calls[0];
            expect(path).toEqual(
                `/rooms/${encodeURIComponent(roomId)}/state/` +
                `${encodeURIComponent(M_BEACON_INFO.name)}/${encodeURIComponent(userId)}`,
            );
            expect(requestContent).toEqual(content);
        });

        describe('processBeaconEvents()', () => {
            it('does nothing when events is falsy', () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, 'processBeaconEvents');

                client.processBeaconEvents(room, undefined);
                expect(roomStateProcessSpy).not.toHaveBeenCalled();
            });

            it('does nothing when events is of length 0', () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, 'processBeaconEvents');

                client.processBeaconEvents(room, []);
                expect(roomStateProcessSpy).not.toHaveBeenCalled();
            });

            it('calls room states processBeaconEvents with events', () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, 'processBeaconEvents');

                const messageEvent = testUtils.mkMessage({ room: roomId, user: userId, event: true });
                const beaconEvent = makeBeaconEvent(userId);

                client.processBeaconEvents(room, [messageEvent, beaconEvent]);
                expect(roomStateProcessSpy).toHaveBeenCalledWith([messageEvent, beaconEvent], client);
            });
        });
    });

    describe("setRoomTopic", () => {
        const roomId = "!foofoofoofoofoofoo:matrix.org";
        const createSendStateEventMock = (topic: string, htmlTopic?: string) => {
            return jest.fn()
                .mockImplementation((roomId: string, eventType: string, content: any, stateKey: string) => {
                    expect(roomId).toEqual(roomId);
                    expect(eventType).toEqual(EventType.RoomTopic);
                    expect(content).toMatchObject(ContentHelpers.makeTopicContent(topic, htmlTopic));
                    expect(stateKey).toBeUndefined();
                    return Promise.resolve();
                });
        };

        it("is called with plain text topic and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza");
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });

        it("is called with plain text topic and callback and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza", () => {});
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });

        it("is called with plain text and HTML topic and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza", "<b>pizza</b>");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza", "<b>pizza</b>");
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });
    });

    describe("setPassword", () => {
        const auth = { session: 'abcdef', type: 'foo' };
        const newPassword = 'newpassword';
        const callback = () => {};

        const passwordTest = (expectedRequestContent: any, expectedCallback?: Function) => {
            const [callback, method, path, queryParams, requestContent] = client.http.authedRequest.mock.calls[0];
            if (expectedCallback) {
                expect(callback).toBe(expectedCallback);
            } else {
                expect(callback).toBeFalsy();
            }
            expect(method).toBe('POST');
            expect(path).toEqual('/account/password');
            expect(queryParams).toBeFalsy();
            expect(requestContent).toEqual(expectedRequestContent);
        };

        beforeEach(() => {
            client.http.authedRequest.mockClear().mockResolvedValue({});
        });

        it("no logout_devices specified", async () => {
            await client.setPassword(auth, newPassword);
            passwordTest({ auth, new_password: newPassword });
        });

        it("no logout_devices specified + callback", async () => {
            await client.setPassword(auth, newPassword, callback);
            passwordTest({ auth, new_password: newPassword }, callback);
        });

        it("overload logoutDevices=true", async () => {
            await client.setPassword(auth, newPassword, true);
            passwordTest({ auth, new_password: newPassword, logout_devices: true });
        });

        it("overload logoutDevices=true + callback", async () => {
            await client.setPassword(auth, newPassword, true, callback);
            passwordTest({ auth, new_password: newPassword, logout_devices: true }, callback);
        });

        it("overload logoutDevices=false", async () => {
            await client.setPassword(auth, newPassword, false);
            passwordTest({ auth, new_password: newPassword, logout_devices: false });
        });

        it("overload logoutDevices=false + callback", async () => {
            await client.setPassword(auth, newPassword, false, callback);
            passwordTest({ auth, new_password: newPassword, logout_devices: false }, callback);
        });
    });

    describe("getLocalAliases", () => {
        it("should call the right endpoint", async () => {
            const response = {
                aliases: ["#woop:example.org", "#another:example.org"],
            };
            client.http.authedRequest.mockClear().mockResolvedValue(response);

            const roomId = "!whatever:example.org";
            const result = await client.getLocalAliases(roomId);

            // Current version of the endpoint we support is v3
            const [callback, method, path, queryParams, data, opts] = client.http.authedRequest.mock.calls[0];
            expect(callback).toBeFalsy();
            expect(data).toBeFalsy();
            expect(method).toBe('GET');
            expect(path).toEqual(`/rooms/${encodeURIComponent(roomId)}/aliases`);
            expect(opts).toMatchObject({ prefix: "/_matrix/client/v3" });
            expect(queryParams).toBeFalsy();
            expect(result!.aliases).toEqual(response.aliases);
        });
    });
});
