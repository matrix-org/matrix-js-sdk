"use strict";
var sdk = require("../..");
var WebStorageStore = sdk.WebStorageStore;
var Room = sdk.Room;
var utils = require("../test-utils");

function MockStorageApi() {
    this.data = {};
    this.keys = [];
    this.length = 0;
}
MockStorageApi.prototype = {
    setItem: function(k, v) {
        this.data[k] = v;
        this._recalc();
    },
    getItem: function(k) {
        return this.data[k] || null;
    },
    removeItem: function(k) {
        delete this.data[k];
        this._recalc();
    },
    key: function(index) {
        return this.keys[index];
    },
    _recalc: function() {
        var keys = [];
        for (var k in this.data) {
            if (!this.data.hasOwnProperty(k)) { continue; }
            keys.push(k);
        }
        this.keys = keys;
        this.length = keys.length;
    }
};

describe("WebStorageStore", function() {
    var store, room;
    var roomId = "!foo:bar";
    var userId = "@alice:bar";
    var mockStorageApi;
    var batchNum = 3;

    beforeEach(function() {
        utils.beforeEach(this);
        mockStorageApi = new MockStorageApi();
        store = new WebStorageStore(mockStorageApi, batchNum);
        room = new Room(roomId);
    });

    describe("getSyncToken", function() {
        it("should return the token from the store", function() {

        });
        it("should return null if the token does not exist", function() {

        });
    });

    describe("setSyncToken", function() {
        it("should store the token in the store, which is retrievable from " +
        "getSyncToken", function() {

        });
    });

    describe("storeRoom", function() {
        it("should persist the room state correctly", function() {
            var stateEvents = [
                utils.mkEvent({
                    event: true, type: "m.room.create", user: userId, room: roomId,
                    content: {
                        creator: userId
                    }
                }),
                utils.mkMembership({
                    event: true, user: userId, room: roomId, mship: "join"
                })
            ];
            room.currentState.setStateEvents(stateEvents);
            store.storeRoom(room);
            var storedEvents = mockStorageApi.getItem(
                "room_" + roomId + "_state"
            ).events;
            expect(storedEvents["m.room.create"][""]).toEqual(stateEvents[0].event);
        });

        it("should persist timeline events correctly", function() {
            var prefix = "room_" + roomId + "_timeline_";
            var timelineEvents = [];
            var entries = batchNum + batchNum - 1;
            var i = 0;
            for (i = 0; i < entries; i++) {
                timelineEvents.push(
                    utils.mkMessage({room: roomId, user: userId, event: true})
                );
            }
            room.timeline = timelineEvents;
            store.storeRoom(room);
            expect(mockStorageApi.getItem(prefix + "-1")).toBe(null);
            expect(mockStorageApi.getItem(prefix + "2")).toBe(null);
            expect(mockStorageApi.getItem(prefix + "live")).toBe(null);
            var timeline0 = mockStorageApi.getItem(prefix + "0");
            var timeline1 = mockStorageApi.getItem(prefix + "1");
            expect(timeline0.length).toEqual(batchNum);
            expect(timeline1.length).toEqual(batchNum - 1);
            for (i = 0; i < batchNum; i++) {
                expect(timeline0[i]).toEqual(timelineEvents[i].event);
                if ((i + batchNum) < timelineEvents.length) {
                    expect(timeline1[i]).toEqual(timelineEvents[i + batchNum].event);
                }
            }
        });
    });

    describe("getRoom", function() {
        it("should reconstruct room state", function() {

        });
        it("should reconstruct the room timeline", function() {

        });
        it("should sync the timeline for any 'live' events", function() {

        });
        it("should be able to reconstruct the timeline with negative indices",
        function() {

        });
        it("should return null if the room doesn't exist", function() {

        });
        it("should assign a storageToken to the Room", function() {

        });
    });
});
