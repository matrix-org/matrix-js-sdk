"use strict";
var q = require("q");
var sdk = require("../..");
var MatrixClient = sdk.MatrixClient;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var userId = "@alice:bar";
    var identityServerUrl = "https://identity.server";
    var identityServerDomain = "identity.server";
    var client, store, scheduler;

    var KEEP_ALIVE_PATH = "/_matrix/client/versions";

    var PUSH_RULES_RESPONSE = {
        method: "GET",
        path: "/pushrules/",
        data: {}
    };

    var FILTER_PATH = "/user/" + encodeURIComponent(userId) + "/filter";

    var FILTER_RESPONSE = {
        method: "POST",
        path: FILTER_PATH,
        data: { filter_id: "f1lt3r" }
    };

    var SYNC_DATA = {
        next_batch: "s_5_3",
        presence: { events: [] },
        rooms: {}
    };

    var SYNC_RESPONSE = {
        method: "GET",
        path: "/sync",
        data: SYNC_DATA
    };

    var httpLookups = [
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
    var accept_keepalives;
    var pendingLookup = null;
    function httpReq(cb, method, path, qp, data, prefix) {
        if (path === KEEP_ALIVE_PATH && accept_keepalives) {
            return q();
        }
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
            if (next.expectQueryParams) {
                Object.keys(next.expectQueryParams).forEach(function(k) {
                    expect(qp[k]).toEqual(next.expectQueryParams[k]);
                });
            }

            if (next.thenCall) {
                process.nextTick(next.thenCall, 0); // next tick so we return first.
            }

            if (next.error) {
                return q.reject({
                    errcode: next.error.errcode,
                    httpStatus: next.error.httpStatus,
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
            "setSyncToken", "storeEvents", "storeRoom", "storeUser",
            "getFilterIdByName", "setFilterIdByName", "getFilter", "storeFilter"
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
        client._http.requestWithPrefix.andCallFake(httpReq);
        client._http.request.andCallFake(httpReq);

        // set reasonable working defaults
        accept_keepalives = true;
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
        client._http.authedRequest.andCallFake(function() {
            return q.defer().promise;
        });
        client._http.authedRequestWithPrefix.andCallFake(function() {
            return q.defer().promise;
        });
    });

    it("should not POST /filter if a matching filter already exists", function(done) {
        httpLookups = [];
        httpLookups.push(PUSH_RULES_RESPONSE);
        httpLookups.push(SYNC_RESPONSE);
        var filterId = "ehfewf";
        store.getFilterIdByName.andReturn(filterId);
        var filter = new sdk.Filter(0, filterId);
        filter.setDefinition({"room": {"timeline": {"limit": 8}}});
        store.getFilter.andReturn(filter);
        client.startClient();

        client.on("sync", function syncListener(state) {
            if (state === "SYNCING") {
                expect(httpLookups.length).toEqual(0);
                client.removeListener("sync", syncListener);
                done();
            }
        });
    });

    describe("getSyncState", function() {

        it("should return null if the client isn't started", function() {
            expect(client.getSyncState()).toBeNull();
        });

        it("should return the same sync state as emitted sync events", function(done) {
            client.on("sync", function syncListener(state) {
                expect(state).toEqual(client.getSyncState());
                if (state === "SYNCING") {
                    client.removeListener("sync", syncListener);
                    done();
                }
            });
            client.startClient();
        });
    });

    describe("getOrCreateFilter", function() {
        it("should POST createFilter if no id is present in localStorage", function() {
        });
        it("should use an existing filter if id is present in localStorage", function() {
        });
        it("should handle localStorage filterId missing from the server", function(done) {
            function getFilterName(userId, suffix) {
                // scope this on the user ID because people may login on many accounts
                // and they all need to be stored!
                return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
            }
            var invalidFilterId = 'invalidF1lt3r';
            httpLookups = [];
            httpLookups.push({
                method: "GET",
                path: FILTER_PATH + '/' + invalidFilterId,
                error: {
                    errcode: "M_UNKNOWN",
                    name: "M_UNKNOWN",
                    message: "No row found",
                    data: { errcode: "M_UNKNOWN", error: "No row found" },
                    httpStatus: 404
                }
            });
            httpLookups.push(FILTER_RESPONSE);
            store.getFilterIdByName.andReturn(invalidFilterId);

            var filterName = getFilterName(client.credentials.userId);
            client.store.setFilterIdByName(filterName, invalidFilterId);
            var filter = new sdk.Filter(client.credentials.userId);

            client.getOrCreateFilter(filterName, filter).then(function(filterId) {
                expect(filterId).toEqual(FILTER_RESPONSE.data.filter_id);
                done();
            });
        });
    });

    describe("retryImmediately", function() {
        it("should return false if there is no request waiting", function() {
            client.startClient();
            expect(client.retryImmediately()).toBe(false);
        });

        it("should work on /filter", function(done) {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST", path: FILTER_PATH, error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(2);
                    expect(client.retryImmediately()).toBe(true);
                    jasmine.Clock.tick(1);
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
                method: "GET", path: "/sync", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: "/sync", data: SYNC_DATA
            });

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(1);
                    expect(client.retryImmediately()).toBe(
                        true, "retryImmediately returned false"
                    );
                    jasmine.Clock.tick(1);
                } else if (state === "RECONNECTING" && httpLookups.length > 0) {
                    jasmine.Clock.tick(10000);
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
                method: "GET", path: "/pushrules/", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            client.on("sync", function syncListener(state) {
                if (state === "ERROR" && httpLookups.length > 0) {
                    expect(httpLookups.length).toEqual(3);
                    expect(client.retryImmediately()).toBe(true);
                    jasmine.Clock.tick(1);
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
                    client.removeListener("sync", syncListener);
                    done();
                }
                // standard retry time is 5 to 10 seconds
                jasmine.Clock.tick(10000);
            };
        }

        it("should transition null -> PREPARED after the first /sync", function(done) {
            var expectedStates = [];
            expectedStates.push(["PREPARED", null]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition null -> ERROR after a failed /filter", function(done) {
            var expectedStates = [];
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST", path: FILTER_PATH, error: { errcode: "NOPE_NOPE_NOPE" }
            });
            expectedStates.push(["ERROR", null]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition ERROR -> PREPARED after /sync if prev failed",
        function(done) {
            var expectedStates = [];
            accept_keepalives = false;
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NOPE_NOPE_NOPE" }
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH, error: { errcode: "KEEPALIVE_FAIL" }
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH, data: {}
            });
            httpLookups.push({
                method: "GET", path: "/sync", data: SYNC_DATA
            });

            expectedStates.push(["RECONNECTING", null]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            expectedStates.push(["PREPARED", "ERROR"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition PREPARED -> SYNCING after /sync", function(done) {
            var expectedStates = [];
            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition SYNCING -> ERROR after a failed /sync", function(done) {
            accept_keepalives = false;
            var expectedStates = [];
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NONONONONO" }
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH, error: { errcode: "KEEPALIVE_FAIL" }
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
            var expectedStates = [];
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NONONONONO" }
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
            var expectedStates = [];
            httpLookups.push(SYNC_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["SYNCING", "SYNCING"]);
            client.on("sync", syncChecker(expectedStates, done));
            client.startClient();
        });

        it("should transition ERROR -> ERROR if keepalive keeps failing", function(done) {
            accept_keepalives = false;
            var expectedStates = [];
            httpLookups.push({
                method: "GET", path: "/sync", error: { errcode: "NONONONONO" }
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH, error: { errcode: "KEEPALIVE_FAIL" }
            });
            httpLookups.push({
                method: "GET", path: KEEP_ALIVE_PATH, error: { errcode: "KEEPALIVE_FAIL" }
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
        var roomId = "!foo:bar";

        it("should send an invite HTTP POST", function() {
            httpLookups = [{
                method: "POST",
                path: "/rooms/!foo%3Abar/invite",
                data: {},
                expectBody: {
                    id_server: identityServerDomain,
                    medium: "email",
                    address: "alice@gmail.com"
                }
            }];
            client.inviteByEmail(roomId, "alice@gmail.com");
            expect(httpLookups.length).toEqual(0);
        });

    });

    describe("guest rooms", function() {

        it("should only do /sync calls (without filter/pushrules)", function(done) {
            httpLookups = []; // no /pushrules or /filter
            httpLookups.push({
                method: "GET",
                path: "/sync",
                data: SYNC_DATA,
                thenCall: function() {
                    done();
                }
            });
            client.setGuest(true);
            client.startClient();
        });

        xit("should be able to peek into a room using peekInRoom", function(done) {
        });
    });
});
