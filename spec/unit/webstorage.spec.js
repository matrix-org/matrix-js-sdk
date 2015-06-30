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

        xit("should persist timeline events correctly", function() {

        });
    });
});
