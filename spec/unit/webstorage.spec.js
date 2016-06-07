"use strict";
var sdk = require("../..");
var WebStorageStore = sdk.WebStorageStore;
var Room = sdk.Room;
var User = sdk.User;
var utils = require("../test-utils");

var MockStorageApi = require("../MockStorageApi");

describe("WebStorageStore", function() {
    var store, room;
    var roomId = "!foo:bar";
    var userId = "@alice:bar";
    var mockStorageApi;
    var batchNum = 3;
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
            var storedEvents = getItem(mockStorageApi,
                "room_" + roomId + "_state"
            ).events;
            expect(storedEvents["m.room.create"][""]).toEqual(stateEvents[0].event);
        });

        it("should persist timeline events correctly", function() {
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
            expect(getItem(mockStorageApi, prefix + "-1")).toBe(null);
            expect(getItem(mockStorageApi, prefix + "2")).toBe(null);
            expect(getItem(mockStorageApi, prefix + "live")).toBe(null);
            var timeline0 = getItem(mockStorageApi, prefix + "0");
            var timeline1 = getItem(mockStorageApi, prefix + "1");
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
            expect(getItem(mockStorageApi, prefix + "-1")).toBe(null);
            expect(getItem(mockStorageApi, prefix + "1")).toBe(null);
            expect(getItem(mockStorageApi, prefix + "live")).toBe(null);
            var timeline = getItem(mockStorageApi, prefix + "0");
            expect(timeline.length).toEqual(timelineEvents.length);
            for (i = 0; i < timeline.length; i++) {
                expect(timeline[i]).toEqual(
                    timelineEvents[i].event
                );
            }
        });
    });

    describe("getRoom", function() {
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
            setItem(mockStorageApi, stateKeyName, {
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
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", [inviteEvent]);

            var storedRoom = store.getRoom(roomId);
            expect(
                storedRoom.currentState.getStateEvents("m.room.member", userId).event
            ).toEqual(stateEventMap["m.room.member"][userId]);
            expect(
                storedRoom.oldState.getStateEvents("m.room.member", userId).event
            ).toEqual(inviteEvent);
        });

        it("should reconstruct the room timeline", function() {
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", timeline0);
            setItem(mockStorageApi, prefix + "1", timeline1);

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

            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", timeline0);
            setItem(mockStorageApi, prefix + "1", timeline1);
            setItem(mockStorageApi,
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
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", []);
            setItem(mockStorageApi,
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
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "-5", timeline0);
            setItem(mockStorageApi, prefix + "-4", timeline1);
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

        it("should assign a storageToken to the Room", function() {
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", timeline0);
            setItem(mockStorageApi, prefix + "1", timeline1);

            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.storageToken).toBeDefined();
        });
    });

    describe("scrollback", function() {
        // stored timeline events
        var timeline0, timeline1, timeline2;

        beforeEach(function() {
            // batch size is 3
            store = new WebStorageStore(mockStorageApi, 3);
            timeline0 = [
                // _
                utils.mkMessage({user: userId, room: roomId}), // 1  OLDEST
                utils.mkMessage({user: userId, room: roomId})  // 2
            ];
            timeline1 = [
                utils.mkMessage({user: userId, room: roomId}), // 3
                utils.mkMessage({user: userId, room: roomId}), // 4
                utils.mkMessage({user: userId, room: roomId})  // 5
            ];
            timeline2 = [
                utils.mkMessage({user: userId, room: roomId}), // 6
                utils.mkMessage({user: userId, room: roomId}), // 7
                utils.mkMessage({user: userId, room: roomId})  // 8  NEWEST
            ];
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", timeline0);
            setItem(mockStorageApi, prefix + "1", timeline1);
            setItem(mockStorageApi, prefix + "2", timeline2);
        });

        it("should scroll back locally giving 'limit' events", function() {
            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.timeline.length).toEqual(3);
            var events = store.scrollback(storedRoom, 3);
            expect(events.length).toEqual(3);
            expect(events.reverse()).toEqual(timeline1);
        });

        it("should give less than 'limit' events near the end of the stored timeline",
        function() {
            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.timeline.length).toEqual(3);
            var events = store.scrollback(storedRoom, 7);
            expect(events.length).toEqual(5);
            expect(events.reverse()).toEqual(timeline0.concat(timeline1));
        });

        it("should progressively give older messages the more times scrollback is called",
        function() {
            var events;
            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.timeline.length).toEqual(3);

            events = store.scrollback(storedRoom, 2);
            expect(events.reverse()).toEqual([timeline1[1], timeline1[2]]);
            expect(storedRoom.timeline.length).toEqual(5);

            events = store.scrollback(storedRoom, 2);
            expect(events.reverse()).toEqual([timeline0[1], timeline1[0]]);
            expect(storedRoom.timeline.length).toEqual(7);

            events = store.scrollback(storedRoom, 2);
            expect(events).toEqual([timeline0[0]]);
            expect(storedRoom.timeline.length).toEqual(8);

            events = store.scrollback(storedRoom, 2);
            expect(events).toEqual([]);
            expect(storedRoom.timeline.length).toEqual(8);
        });

        it("should give 0 events if there is no token on the room", function() {
            var r = new Room(roomId);
            expect(store.scrollback(r, 3)).toEqual([]);
        });

        it("should give 0 events for unknown rooms", function() {
            var r = new Room("!unknown:room");
            r.storageToken = "foo";
            expect(store.scrollback(r, 3)).toEqual([]);
        });

        it("should give 0 events if the boundary event is the last in the timeline",
        function() {
            var events;
            var storedRoom = store.getRoom(roomId);
            expect(storedRoom.timeline.length).toEqual(3);

            // go up to the boundary (8 messages total)
            events = store.scrollback(storedRoom, 5);
            expect(events.length).toEqual(5);

            events = store.scrollback(storedRoom, 5);
            expect(events.length).toEqual(0);
        });
    });

    describe("storeEvents", function() {
        var timeline0, i;

        beforeEach(function() {
            timeline0 = [];
            for (i = 0; i < batchNum; i++) {
                timeline0.push(utils.mkMessage({user: userId, room: roomId}));
            }
            setItem(mockStorageApi, stateKeyName, {
                events: stateEventMap,
                pagination_token: "tok"
            });
            setItem(mockStorageApi, prefix + "0", timeline0);
        });

        it("should add to the live batch", function() {
            var events = [
                utils.mkMessage({user: userId, room: roomId, event: true}),
                utils.mkMessage({user: userId, room: roomId, event: true})
            ];
            store.storeEvents(room, events, "atoken");
            var liveEvents = getItem(mockStorageApi, prefix + "live");
            expect(liveEvents.length).toEqual(2);
            expect(liveEvents[0]).toEqual(events[0].event);
            expect(liveEvents[1]).toEqual(events[1].event);
        });

        it("should preserve existing live events in the store", function() {
            var existingEvent = utils.mkMessage({user: userId, room: roomId});
            setItem(mockStorageApi, prefix + "live", [existingEvent]);
            var events = [
                utils.mkMessage({user: userId, room: roomId, event: true}),
                utils.mkMessage({user: userId, room: roomId, event: true})
            ];
            store.storeEvents(room, events, "atoken");
            var liveEvents = getItem(mockStorageApi, prefix + "live");
            expect(liveEvents.length).toEqual(3);
            expect(liveEvents[0]).toEqual(existingEvent);
            expect(liveEvents[1]).toEqual(events[0].event);
            expect(liveEvents[2]).toEqual(events[1].event);
        });

        it("should add to the lowest batch index if toStart=true", function() {
            var events = [
                utils.mkMessage({user: userId, room: roomId, event: true}),
                utils.mkMessage({user: userId, room: roomId, event: true})
            ];
            store.storeEvents(room, events, "atoken", true);
            var timelineNeg1 = getItem(mockStorageApi, prefix + "-1");
            expect(timelineNeg1.length).toEqual(2);
            expect(timelineNeg1[0]).toEqual(events[1].event);
            expect(timelineNeg1[1]).toEqual(events[0].event);
        });

        it("should add multiple batches to the lowest batch index if toStart=true",
        function() {
            var timelineNeg1 = [];
            var timelineNeg2 = [];
            for (i = 0; i < batchNum; i++) {
                timelineNeg1.push(
                    utils.mkMessage({user: userId, room: roomId, event: true})
                );
                timelineNeg2.push(
                    utils.mkMessage({user: userId, room: roomId, event: true})
                );
            }

            var events = timelineNeg2.concat(timelineNeg1).reverse();
            store.storeEvents(room, events, "atoken", true);

            var storedNeg1 = getItem(mockStorageApi, prefix + "-1");
            var storedNeg2 = getItem(mockStorageApi, prefix + "-2");
            expect(timelineNeg1.length).toEqual(storedNeg1.length);
            expect(timelineNeg2.length).toEqual(storedNeg2.length);
            for (i = 0; i < timelineNeg1.length; i++) {
                expect(timelineNeg1[i].event).toEqual(storedNeg1[i]);
                expect(timelineNeg2[i].event).toEqual(storedNeg2[i]);
            }
        });

        it("should update stored state if state events exist", function() {
            var events = [
                utils.mkEvent({
                    user: userId, room: roomId, type: "m.room.name", event: true,
                    content: {
                        name: "Room Name Here for updates"
                    }
                })
            ];
            room.currentState.setStateEvents(events);
            store.storeEvents(room, events, "atoken");

            var liveEvents = getItem(mockStorageApi, prefix + "live");
            expect(liveEvents.length).toEqual(1);
            expect(liveEvents[0]).toEqual(events[0].event);

            var stateEvents = getItem(mockStorageApi, stateKeyName);
            expect(stateEvents.events["m.room.name"][""]).toEqual(events[0].event);
        });
    });

    describe("getRooms", function() {
        var mkState = function(id) {
            return [
                utils.mkEvent({
                    event: true, type: "m.room.create", user: userId, room: id,
                    content: {
                        creator: userId
                    }
                }),
                utils.mkMembership({
                    event: true, user: userId, room: id, mship: "join"
                })
            ];
        };

        it("should get all rooms in the store", function() {
            var roomIds = [
                "!alpha:bet", "!beta:fet"
            ];
            // store 2 dynamically
            var roomA = new Room(roomIds[0]);
            roomA.currentState.setStateEvents(mkState(roomIds[0]));
            var roomB = new Room(roomIds[1]);
            roomB.currentState.setStateEvents(mkState(roomIds[1]));
            store.storeRoom(roomA);
            store.storeRoom(roomB);

            var rooms = store.getRooms();
            expect(rooms.length).toEqual(2);
            for (var i = 0; i < rooms.length; i++) {
                var index = roomIds.indexOf(rooms[i].roomId);
                expect(index).not.toEqual(
                    -1, "Unknown room"
                );
                roomIds.splice(index, 1);
            }
        });
    });

    describe("getUser", function() {
        it("should be able to retrieve a stored user", function() {
            var user = new User(userId);
            store.storeUser(user);
            var result = store.getUser(userId);
            expect(result).toBeDefined();
            expect(result.userId).toEqual(userId);
        });

        it("should be able to retrieve a stored user with name data", function() {
            var presence = utils.mkEvent({
                type: "m.presence", event: true, content: {
                    user_id: userId,
                    displayname: "Flibble"
                }
            });
            var user = new User(userId);
            user.setPresenceEvent(presence);
            store.storeUser(user);
            var result = store.getUser(userId);
            console.log(result);
            expect(result.events.presence).toEqual(presence);
        });
    });
});

function getItem(store, key) {
    return JSON.parse(store.getItem(key));
}

function setItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}
