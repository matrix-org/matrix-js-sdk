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

    describe("constructor", function() {
        it("should throw if the WebStorage API functions are missing", function() {
            expect(function() {
                store = new WebStorageStore({}, 5);
            }).toThrow();
            expect(function() {
                mockStorageApi.length = undefined;
                store = new WebStorageStore(mockStorageApi, 5);
            }).toThrow();
        });
    });

    describe("syncToken", function() {
        it("get: should return the token from the store", function() {
            var token = "flibble";
            store.setSyncToken(token);
            expect(store.getSyncToken()).toEqual(token);
            expect(mockStorageApi.length).toEqual(1);
        });
        it("get: should return null if the token does not exist", function() {
            expect(store.getSyncToken()).toEqual(null);
            expect(mockStorageApi.length).toEqual(0);
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

        it("should persist timeline events in one bucket if batchNum=0", function() {
            store = new WebStorageStore(mockStorageApi, 0);
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
            expect(mockStorageApi.getItem(prefix + "1")).toBe(null);
            expect(mockStorageApi.getItem(prefix + "live")).toBe(null);
            var timeline = mockStorageApi.getItem(prefix + "0");
            expect(timeline.length).toEqual(timelineEvents.length);
            for (i = 0; i < timeline.length; i++) {
                expect(timeline[i]).toEqual(
                    timelineEvents[i].event
                );
            }
        });
    });

    describe("getRoom", function() {
        // web storage api keys
        var prefix = "room_" + roomId + "_timeline_";
        var stateKeyName = "room_" + roomId + "_state";

        // stored state events
        var stateEventMap = {
            "m.room.member": {},
            "m.room.name": {}
        };
        stateEventMap["m.room.member"][userId] = utils.mkMembership(
            {user: userId, room: roomId, mship: "join"}
        );
        stateEventMap["m.room.name"][""] = utils.mkEvent(
            {user: userId, room: roomId, type: "m.room.name",
            content: {
                name: "foo"
            }}
        );

        // stored timeline events
        var timeline0, timeline1, i;

        beforeEach(function() {
            timeline0 = [];
            timeline1 = [];
            for (i = 0; i < batchNum; i++) {
                timeline1[i] = utils.mkMessage({user: userId, room: roomId});
                if (i !== (batchNum - 1)) { // miss last one
                    timeline0[i] = utils.mkMessage({user: userId, room: roomId});
                }
            }
        });

        it("should reconstruct room state", function() {
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });

            var storedRoom = store.getRoom(roomId);
            expect(
                storedRoom.currentState.getStateEvents("m.room.name", "").event
            ).toEqual(stateEventMap["m.room.name"][""]);
            expect(
                storedRoom.currentState.getStateEvents("m.room.member", userId).event
            ).toEqual(stateEventMap["m.room.member"][userId]);
        });

        it("should reconstruct old room state", function() {
            var inviteEvent = utils.mkMembership({
                user: userId, room: roomId, mship: "invite"
            });
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "0", [inviteEvent]);

            var storedRoom = store.getRoom(roomId);
            expect(
                storedRoom.currentState.getStateEvents("m.room.member", userId).event
            ).toEqual(stateEventMap["m.room.member"][userId]);
            expect(
                storedRoom.oldState.getStateEvents("m.room.member", userId).event
            ).toEqual(inviteEvent);
        });

        it("should reconstruct the room timeline", function() {
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "0", timeline0);
            mockStorageApi.setItem(prefix + "1", timeline1);

            var storedRoom = store.getRoom(roomId);
            expect(storedRoom).not.toBeNull();
            // should only get up to the batch num timeline events
            expect(storedRoom.timeline.length).toEqual(batchNum);
            var timeline = timeline0.concat(timeline1);
            for (i = 0; i < batchNum; i++) {
                expect(storedRoom.timeline[batchNum - 1 - i].event).toEqual(
                    timeline[timeline.length - 1 - i]
                );
            }
        });

        it("should sync the timeline for 'live' events " +
        "(full hi batch; 1+bit live batches)", function() {
            // 1 and a bit events go into _live
            var timelineLive = [];
            timelineLive.push(utils.mkMessage({user: userId, room: roomId}));
            for (i = 0; i < batchNum; i++) {
                timelineLive.push(
                    utils.mkMessage({user: userId, room: roomId})
                );
            }

            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "0", timeline0);
            mockStorageApi.setItem(prefix + "1", timeline1);
            mockStorageApi.setItem(
                // deep copy the timeline via parse/stringify else items will
                // be shift()ed from timelineLive and we can't compare!
                prefix + "live", JSON.parse(JSON.stringify(timelineLive))
            );

            var storedRoom = store.getRoom(roomId);
            expect(storedRoom).not.toBeNull();
            // should only get up to the batch num timeline events (highest
            // index of timelineLive is the newest message)
            expect(storedRoom.timeline.length).toEqual(batchNum);
            for (i = 0; i < batchNum; i++) {
                expect(storedRoom.timeline[i].event).toEqual(
                    timelineLive[i + 1]
                );
            }
        });

        it("should sync the timeline for 'live' events " +
        "(no low batch; 1 live batches)", function() {
            var timelineLive = [];
            for (i = 0; i < batchNum; i++) {
                timelineLive.push(
                    utils.mkMessage({user: userId, room: roomId})
                );
            }
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "0", []);
            mockStorageApi.setItem(
                // deep copy the timeline via parse/stringify else items will
                // be shift()ed from timelineLive and we can't compare!
                prefix + "live", JSON.parse(JSON.stringify(timelineLive))
            );

            var storedRoom = store.getRoom(roomId);
            expect(storedRoom).not.toBeNull();
            // should only get up to the batch num timeline events (highest
            // index of timelineLive is the newest message)
            expect(storedRoom.timeline.length).toEqual(batchNum);
            for (i = 0; i < batchNum; i++) {
                expect(storedRoom.timeline[i].event).toEqual(
                    timelineLive[i]
                );
            }
        });

        it("should be able to reconstruct the timeline with negative indices",
        function() {
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "-5", timeline0);
            mockStorageApi.setItem(prefix + "-4", timeline1);
            var timeline = timeline0.concat(timeline1);
            var storedRoom = store.getRoom(roomId);
            expect(storedRoom).not.toBeNull();
            // should only get up to the batch num timeline events
            expect(storedRoom.timeline.length).toEqual(batchNum);
            for (i = 0; i < batchNum; i++) {
                expect(storedRoom.timeline[batchNum - 1 - i].event).toEqual(
                    timeline[timeline.length - 1 - i]
                );
            }
        });

        it("should return null if the room doesn't exist", function() {
            expect(store.getRoom("nothing")).toEqual(null);
        });

        xit("should assign a storageToken to the Room", function() {
            mockStorageApi.setItem(stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            mockStorageApi.setItem(prefix + "0", timeline0);
            mockStorageApi.setItem(prefix + "1", timeline1);

            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.storageToken).toBeDefined();
        });
    });
});
