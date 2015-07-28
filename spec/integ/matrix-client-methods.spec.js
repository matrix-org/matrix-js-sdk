"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var publicGlobals = require("../../lib/matrix");
var Room = publicGlobals.Room;
var MatrixInMemoryStore = publicGlobals.MatrixInMemoryStore;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend, store;
    var userId = "@alice:localhost";
    var accessToken = "aseukfgwef";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        store = new MatrixInMemoryStore();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken,
            store: store
        });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("joinRoom", function() {
        it("should no-op if you've already joined a room", function() {
            var roomId = "!foo:bar";
            var room = new Room(roomId);
            room.addEvents([
                utils.mkMembership({
                    user: userId, room: roomId, mship: "join", event: true
                })
            ]);
            store.storeRoom(room);
            client.joinRoom(roomId);
            httpBackend.verifyNoOutstandingRequests();
        });
    });
});
