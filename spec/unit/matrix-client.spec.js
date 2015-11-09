"use strict";
var q = require("q");
var sdk = require("../..");
var MatrixClient = sdk.MatrixClient;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var userId = "@alice:bar";
    var identityServerUrl = "https://identity.server";
    var client, store, scheduler;

    var initialSyncData = {
        end: "s_5_3",
        presence: [],
        rooms: []
    };

    var eventData = {
        start: "s_START",
        end: "s_END",
        chunk: []
    };

    var PUSH_RULES_RESPONSE = {
        method: "GET", path: "/pushrules/", data: {}
    };

    var httpLookups = [
        // items are objects which look like:
        // {
        //   method: "GET",
        //   path: "/initialSync",
        //   data: {},
        //   error: { errcode: M_FORBIDDEN } // if present will reject promise,
        //   expectBody: {} // additional expects on the body
        // }
        // items are popped off when processed and block if no items left.
    ];
    var pendingLookup = null;
    function httpReq(cb, method, path, qp, data, prefix) {
        var next = httpLookups.shift();
        var logLine = (
            "MatrixClient[UT] RECV " + method + " " + path + "  " +
            "EXPECT " + (next ? next.method : next) + " " + (next ? next.path : next)
        );
        console.log(logLine);

        if (!next) { // no more things to return
            if (pendingLookup) {
                if (pendingLookup.method === method && pendingLookup.path === path) {
                    return pendingLookup.promise;
                }
                // >1 pending thing, and they are different, whine.
                expect(false).toBe(
                    true, ">1 pending request. You should probably handle them. " +
                    "PENDING: " + JSON.stringify(pendingLookup) + " JUST GOT: " +
                    method + " " + path
                );
            }
            pendingLookup = {
                promise: q.defer().promise,
                method: method,
                path: path
            };
            return pendingLookup.promise;
        }
        if (next.path === path && next.method === method) {
            console.log(
                "MatrixClient[UT] Matched. Returning " +
                (next.error ? "BAD" : "GOOD") + " response"
            );
            if (next.expectBody) {
                expect(next.expectBody).toEqual(data);
            }
            if (next.error) {
                return q.reject({
                    errcode: next.error.errcode,
                    name: next.error.errcode,
                    message: "Expected testing error",
                    data: next.error
                });
            }
            return q(next.data);
        }
        expect(true).toBe(false, "Expected different request. " + logLine);
        return q.defer().promise;
    }

    beforeEach(function() {
        utils.beforeEach(this);
        jasmine.Clock.useMock();
        scheduler = jasmine.createSpyObj("scheduler", [
            "getQueueForEvent", "queueEvent", "removeEventFromQueue",
            "setProcessFunction"
        ]);
        store = jasmine.createSpyObj("store", [
            "getRoom", "getRooms", "getUser", "getSyncToken", "scrollback",
            "setSyncToken", "storeEvents", "storeRoom", "storeUser"
        ]);
        client = new MatrixClient({
            baseUrl: "https://my.home.server",
            idBaseUrl: identityServerUrl,
            accessToken: "my.access.token",
            request: function() {}, // NOP
            store: store,
            scheduler: scheduler,
            userId: userId
        });
        // FIXME: We shouldn't be yanking _http like this.
        client._http = jasmine.createSpyObj("httpApi", [
            "authedRequest", "authedRequestWithPrefix", "getContentUri",
            "request", "requestWithPrefix", "uploadContent"
        ]);
        client._http.authedRequest.andCallFake(httpReq);
        client._http.authedRequestWithPrefix.andCallFake(httpReq);

        // set reasonable working defaults
        pendingLookup = null;
        httpLookups = [];
        httpLookups.push(PUSH_RULES_RESPONSE);
        httpLookups.push({
            method: "GET", path: "/initialSync", data: initialSyncData
        });
    });

    afterEach(function() {
        // need to re-stub the requests with NOPs because there are no guarantees
        // clients from previous tests will be GC'd before the next test. This
        // means they may call /events and then fail an expect() which will fail
        // a DIFFERENT test (pollution between tests!) - we return unresolved
        // promises to stop the client from continuing to run.
        client._http.authedRequest.andCallFake(function() {
            return q.defer().promise;
        });
        client._http.authedRequestWithPrefix.andCallFake(function() {
            return q.defer().promise;
        });
    });

    describe("getSyncState", function() {

        it("should return null if the client isn't started", function() {
            expect(client.getSyncState()).toBeNull();
        });

        it("should return the same sync state as emitted sync events", function(done) {
            client.on("sync", function(state) {
                expect(state).toEqual(client.getSyncState());
                if (state === "SYNCING") {
                    done();
                }
            });
            client.startClient();
        });
    });

    describe("retryImmediately", function() {
        it("should return false if there is no request waiting", function() {
            client.startClient();
            expect(client.retryImmediately()).toBe(false);
        });

        it("should work on /initialSync", function(done) {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "GET", path: "/initialSync", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: "/initialSync", error: { errcode: "NOPE_NOPE_NOPE" }
            });

            client.on("sync", function(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(1);
                    expect(client.retryImmediately()).toBe(true);
                    expect(httpLookups.length).toEqual(0);
                    done();
                }
            });
            client.startClient();
        });

        it("should work on /events", function(done) {
            httpLookups.push({
                method: "GET", path: "/events", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: "/events", data: eventData
            });

            client.on("sync", function(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(1);
                    expect(client.retryImmediately()).toBe(true);
                    expect(httpLookups.length).toEqual(0);
                    done();
                }
            });
            client.startClient();
        });

        it("should work on /pushrules", function(done) {
            httpLookups = [];
            httpLookups.push({
                method: "GET", path: "/pushrules/", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: "/pushrules/", error: { errcode: "NOPE_NOPE_NOPE" }
            });

            client.on("sync", function(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(1);
                    expect(client.retryImmediately()).toBe(true);
                    expect(httpLookups.length).toEqual(0);
                    done();
                }
            });
            client.startClient();
        });
    });

    describe("emitted sync events", function() {
        var expectedStates;

        function syncChecker(done) {
            return function(state, old) {
                var expected = expectedStates.shift();
                console.log(
                    "'sync' curr=%s old=%s EXPECT=%s", state, old, expected
                );
                if (!expected) {
                    done();
                    return;
                }
                expect(state).toEqual(expected[0]);
                expect(old).toEqual(expected[1]);
                if (expectedStates.length === 0) {
                    done();
                }
                // standard retry time is 4s
                jasmine.Clock.tick(4001);
            };
        }

        beforeEach(function() {
            expectedStates = [
            //  [current, old]
            ];
        });

        it("should transition null -> PREPARED after /initialSync", function(done) {
            expectedStates.push(["PREPARED", null]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition null -> ERROR after a failed /initialSync", function(done) {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "GET", path: "/initialSync", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            expectedStates.push(["ERROR", null]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition ERROR -> PREPARED after /initialSync if prev failed",
        function(done) {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "GET", path: "/initialSync", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: "/initialSync", data: initialSyncData
            });

            expectedStates.push(["ERROR", null]);
            expectedStates.push(["PREPARED", "ERROR"]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition PREPARED -> SYNCING after /initialSync", function(done) {
            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition SYNCING -> ERROR after a failed /events", function(done) {
            httpLookups.push({
                method: "GET", path: "/events", error: { errcode: "NONONONONO" }
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["ERROR", "SYNCING"]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition ERROR -> SYNCING after /events if prev failed",
        function(done) {
            httpLookups.push({
                method: "GET", path: "/events", error: { errcode: "NONONONONO" }
            });
            httpLookups.push({
                method: "GET", path: "/events", data: eventData
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["ERROR", "SYNCING"]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });

        it("should transition ERROR -> ERROR if multiple /events fails", function(done) {
            httpLookups.push({
                method: "GET", path: "/events", error: { errcode: "NONONONONO" }
            });
            httpLookups.push({
                method: "GET", path: "/events", error: { errcode: "NONONONONO" }
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["ERROR", "SYNCING"]);
            expectedStates.push(["ERROR", "ERROR"]);
            client.on("sync", syncChecker(done));
            client.startClient();
        });
    });

    describe("inviteByEmail", function() {
        var roomId = "!foo:bar";

        it("should send an invite HTTP POST", function() {
            httpLookups = [{
                method: "POST",
                path: "/rooms/!foo%3Abar/invite",
                data: {},
                expectBody: {
                    id_server: identityServerUrl,
                    medium: "email",
                    address: "alice@gmail.com"
                }
            }];
            client.inviteByEmail(roomId, "alice@gmail.com");
            expect(httpLookups.length).toEqual(0);
        });

    });
});
