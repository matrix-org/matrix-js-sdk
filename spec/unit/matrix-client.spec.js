"use strict";
var q = require("q");
var sdk = require("../..");
var MatrixClient = sdk.MatrixClient;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var userId = "@alice:bar";
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

    var httpLookups = [
        // items are objects which look like:
        // {
        //   method: "GET",
        //   path: "/initialSync",
        //   data: {},
        //   error: { errcode: M_FORBIDDEN } // if present will reject promise
        // }
        // items are popped off when processed and block if no items left.
    ];
    var pendingLookup = {};
    function httpReq(cb, method, path, qp, data, prefix) {
        var next = httpLookups.shift();
        var logLine = (
            "MatrixClient[UT] RECV " + method + " " + path + "  " +
            "EXPECT " + (next ? next.method : next) + " " + (next ? next.path : next)
        );
        console.log(logLine);

        if (!next) { // no more things to return
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
            accessToken: "my.access.token",
            request: function() {}, // NOP
            store: store,
            scheduler: scheduler
        });
        // FIXME: We shouldn't be yanking _http like this.
        client._http = jasmine.createSpyObj("httpApi", [
            "authedRequest", "authedRequestWithPrefix", "getContentUri",
            "request", "requestWithPrefix", "uploadContent"
        ]);
        client._http.authedRequest.andCallFake(httpReq);
        client._http.authedRequestWithPrefix.andCallFake(httpReq);

        // set reasonable working defaults
        pendingLookup = {};
        httpLookups = [];
        httpLookups.push({
            method: "GET", path: "/pushrules/", data: {}
        });
        httpLookups.push({
            method: "GET", path: "/initialSync", data: initialSyncData
        });
        httpLookups.push({
            method: "GET", path: "/events", data: eventData
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

        });

        it("should return true if there is a request waiting", function() {

        });

        it("should work on /initialSync", function() {

        });

        it("should work on /events", function() {

        });

        it("should work on /pushrules", function() {

        });
    });

    describe("emitted sync events", function() {

        it("should transition null -> PREPARED after /initialSync", function() {

        });

        it("should transition null -> ERROR after a failed /initialSync", function() {

        });

        it("should transition ERROR -> PREPARED after /initialSync if prev failed",
        function() {

        });

        it("should transition PREPARED -> SYNCING after /initialSync", function() {

        });

        it("should transition SYNCING -> ERROR after a failed /events", function() {

        });

        it("should transition ERROR -> SYNCING after /events if prev failed", function() {

        });

        it("should transition ERROR -> ERROR if multiple /events fails", function() {

        });
    });
});
