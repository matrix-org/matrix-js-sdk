"use strict";
var sdk = require("../..");
var EventStatus = sdk.EventStatus;
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient room timelines", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var userId = "@alice:localhost";
    var userName = "Alice";
    var accessToken = "aseukfgwef";
    var roomId = "!foo:bar";
    var otherUserId = "@bob:localhost";
    var USER_MEMBERSHIP_EVENT = utils.mkMembership({
        room: roomId, mship: "join", user: userId, name: userName
    });
    var ROOM_NAME_EVENT = utils.mkEvent({
        type: "m.room.name", room: roomId, user: otherUserId,
        content: {
            name: "Old room name"
        }
    });
    var NEXT_SYNC_DATA;
    var SYNC_DATA = {
        next_batch: "s_5_3",
        rooms: {
            join: {
                "!foo:bar": { // roomId
                    timeline: {
                        events: [
                            utils.mkMessage({
                                room: roomId, user: otherUserId, msg: "hello"
                            })
                        ],
                        prev_batch: "f_1_1"
                    },
                    state: {
                        events: [
                            ROOM_NAME_EVENT,
                            utils.mkMembership({
                                room: roomId, mship: "join",
                                user: otherUserId, name: "Bob"
                            }),
                            USER_MEMBERSHIP_EVENT,
                            utils.mkEvent({
                                type: "m.room.create", room: roomId, user: userId,
                                content: {
                                    creator: userId
                                }
                            })
                        ]
                    }
                }
            }
        }
    };

    function setNextSyncData(events) {
        events = events || [];
        NEXT_SYNC_DATA = {
            next_batch: "n",
            presence: { events: [] },
            rooms: {
                invite: {},
                join: {
                    "!foo:bar": {
                        timeline: { events: [] },
                        state: { events: [] },
                        ephemeral: { events: [] }
                    }
                },
                leave: {}
            }
        };
        events.forEach(function(e) {
            if (e.room_id !== roomId) {
                throw new Error("setNextSyncData only works with one room id");
            }
            if (e.state_key) {
                if (e.__prev_event === undefined) {
                    throw new Error(
                        "setNextSyncData needs the prev state set to '__prev_event' " +
                        "for " + e.type
                    );
                }
                if (e.__prev_event !== null) {
                    // push the previous state for this event type
                    NEXT_SYNC_DATA.rooms.join[roomId].state.events.push(e.__prev_event);
                }
                // push the current
                NEXT_SYNC_DATA.rooms.join[roomId].timeline.events.push(e);
            }
            else if (["m.typing", "m.receipt"].indexOf(e.type) !== -1) {
                NEXT_SYNC_DATA.rooms.join[roomId].ephemeral.events.push(e);
            }
            else {
                NEXT_SYNC_DATA.rooms.join[roomId].timeline.events.push(e);
            }
        });
    }

    beforeEach(function(done) {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken,
            // these tests should work with or without timelineSupport
            timelineSupport: true,
        });
        setNextSyncData();
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
        httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
        httpBackend.when("GET", "/sync").respond(200, function() {
            return NEXT_SYNC_DATA;
        });
        client.startClient();
        httpBackend.flush("/pushrules").then(function() {
            return httpBackend.flush("/filter");
        }).done(done);
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
    });

    describe("local echo events", function() {

        it("should be added immediately after calling MatrixClient.sendEvent " +
        "with EventStatus.SENDING and the right event.sender", function(done) {
            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.sendTextMessage(roomId, "I am a fish", "txn1");
                // check it was added
                expect(room.timeline.length).toEqual(2);
                // check status
                expect(room.timeline[1].status).toEqual(EventStatus.SENDING);
                // check member
                var member = room.timeline[1].sender;
                expect(member.userId).toEqual(userId);
                expect(member.name).toEqual(userName);

                httpBackend.flush("/sync", 1).done(function() {
                    done();
                });
            });
            httpBackend.flush("/sync", 1);
        });

        it("should be updated correctly when the send request finishes " +
        "BEFORE the event comes down the event stream", function(done) {
            var eventId = "$foo:bar";
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: eventId
            });

            var ev = utils.mkMessage({
                body: "I am a fish", user: userId, room: roomId
            });
            ev.event_id = eventId;
            ev.unsigned = {transaction_id: "txn1"};
            setNextSyncData([ev]);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                client.sendTextMessage(roomId, "I am a fish", "txn1").done(
                function() {
                    expect(room.timeline[1].getId()).toEqual(eventId);
                    httpBackend.flush("/sync", 1).done(function() {
                        expect(room.timeline[1].getId()).toEqual(eventId);
                        done();
                    });
                });
                httpBackend.flush("/txn1", 1);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should be updated correctly when the send request finishes " +
        "AFTER the event comes down the event stream", function(done) {
            var eventId = "$foo:bar";
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: eventId
            });

            var ev = utils.mkMessage({
                body: "I am a fish", user: userId, room: roomId
            });
            ev.event_id = eventId;
            ev.unsigned = {transaction_id: "txn1"};
            setNextSyncData([ev]);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                var promise = client.sendTextMessage(roomId, "I am a fish", "txn1");
                httpBackend.flush("/sync", 1).done(function() {
                    expect(room.timeline.length).toEqual(2);
                    httpBackend.flush("/txn1", 1);
                    promise.done(function() {
                        expect(room.timeline.length).toEqual(2);
                        expect(room.timeline[1].getId()).toEqual(eventId);
                        done();
                    });
                });

            });
            httpBackend.flush("/sync", 1);
        });
    });

    describe("paginated events", function() {
        var sbEvents;
        var sbEndTok = "pagin_end";

        beforeEach(function() {
            sbEvents = [];
            httpBackend.when("GET", "/messages").respond(200, function() {
                return {
                    chunk: sbEvents,
                    start: "pagin_start",
                    end: sbEndTok
                };
            });
        });

        it("should set Room.oldState.paginationToken to null at the start" +
        " of the timeline.", function(done) {
            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(1);
                    expect(room.oldState.paginationToken).toBeNull();
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should set the right event.sender values", function(done) {
            // We're aiming for an eventual timeline of:
            //
            // 'Old Alice' joined the room
            // <Old Alice> I'm old alice
            // @alice:localhost changed their name from 'Old Alice' to 'Alice'
            // <Alice> I'm alice
            // ------^ /messages results above this point, /sync result below
            // <Bob> hello

            // make an m.room.member event for alice's join
            var joinMshipEvent = utils.mkMembership({
                mship: "join", user: userId, room: roomId, name: "Old Alice",
                url: null
            });

            // make an m.room.member event with prev_content for alice's nick
            // change
            var oldMshipEvent = utils.mkMembership({
                mship: "join", user: userId, room: roomId, name: userName,
                url: "mxc://some/url"
            });
            oldMshipEvent.prev_content = {
                displayname: "Old Alice",
                avatar_url: null,
                membership: "join"
            };

            // set the list of events to return on scrollback (/messages)
            // N.B. synapse returns /messages in reverse chronological order
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I'm alice"
                }),
                oldMshipEvent,
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I'm old alice"
                }),
                joinMshipEvent,
            ];

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                // sync response
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(5);
                    var joinMsg = room.timeline[0];
                    expect(joinMsg.sender.name).toEqual("Old Alice");
                    var oldMsg = room.timeline[1];
                    expect(oldMsg.sender.name).toEqual("Old Alice");
                    var newMsg = room.timeline[3];
                    expect(newMsg.sender.name).toEqual(userName);
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should add it them to the right place in the timeline", function(done) {
            // set the list of events to return on scrollback
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am new"
                }),
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am old"
                })
            ];

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(3);
                    expect(room.timeline[0].event).toEqual(sbEvents[1]);
                    expect(room.timeline[1].event).toEqual(sbEvents[0]);
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should use 'end' as the next pagination token", function(done) {
            // set the list of events to return on scrollback
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am new"
                })
            ];

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                expect(room.oldState.paginationToken).toBeDefined();

                client.scrollback(room, 1).done(function() {
                    expect(room.oldState.paginationToken).toEqual(sbEndTok);
                });

                httpBackend.flush("/sync", 1);
                httpBackend.flush("/messages", 1).done(function() {
                    done();
                });
            });
            httpBackend.flush("/sync", 1);
        });
    });

    describe("new events", function() {
        it("should be added to the right place in the timeline", function(done) {
            var eventData = [
                utils.mkMessage({user: userId, room: roomId}),
                utils.mkMessage({user: userId, room: roomId})
            ];
            setNextSyncData(eventData);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);

                var index = 0;
                client.on("Room.timeline", function(event, rm, toStart) {
                    expect(toStart).toBe(false);
                    expect(rm).toEqual(room);
                    expect(event.event).toEqual(eventData[index]);
                    index += 1;
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1).then(function() {
                    expect(index).toEqual(2);
                    expect(room.timeline.length).toEqual(3);
                    expect(room.timeline[2].event).toEqual(
                        eventData[1]
                    );
                    expect(room.timeline[1].event).toEqual(
                        eventData[0]
                    );
                }).catch(utils.failTest).done(done);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should set the right event.sender values", function(done) {
            var eventData = [
                utils.mkMessage({user: userId, room: roomId}),
                utils.mkMembership({
                    user: userId, room: roomId, mship: "join", name: "New Name"
                }),
                utils.mkMessage({user: userId, room: roomId})
            ];
            eventData[1].__prev_event = USER_MEMBERSHIP_EVENT;
            setNextSyncData(eventData);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                httpBackend.flush("/sync", 1).then(function() {
                    var preNameEvent = room.timeline[room.timeline.length - 3];
                    var postNameEvent = room.timeline[room.timeline.length - 1];
                    expect(preNameEvent.sender.name).toEqual(userName);
                    expect(postNameEvent.sender.name).toEqual("New Name");
                }).catch(utils.failTest).done(done);
            });
            httpBackend.flush("/sync", 1);
        });

        it("should set the right room.name", function(done) {
            var secondRoomNameEvent = utils.mkEvent({
                user: userId, room: roomId, type: "m.room.name", content: {
                    name: "Room 2"
                }
            });
            secondRoomNameEvent.__prev_event = ROOM_NAME_EVENT;
            setNextSyncData([secondRoomNameEvent]);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                var nameEmitCount = 0;
                client.on("Room.name", function(rm) {
                    nameEmitCount += 1;
                });

                httpBackend.flush("/sync", 1).done(function() {
                    expect(nameEmitCount).toEqual(1);
                    expect(room.name).toEqual("Room 2");
                    // do another round
                    var thirdRoomNameEvent = utils.mkEvent({
                        user: userId, room: roomId, type: "m.room.name", content: {
                            name: "Room 3"
                        }
                    });
                    thirdRoomNameEvent.__prev_event = secondRoomNameEvent;
                    setNextSyncData([thirdRoomNameEvent]);
                    httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);
                    httpBackend.flush("/sync", 1).done(function() {
                        expect(nameEmitCount).toEqual(2);
                        expect(room.name).toEqual("Room 3");
                        done();
                    });
                });
            });
            httpBackend.flush("/sync", 1);
        });

        it("should set the right room members", function(done) {
            var userC = "@cee:bar";
            var userD = "@dee:bar";
            var eventData = [
                utils.mkMembership({
                    user: userC, room: roomId, mship: "join", name: "C"
                }),
                utils.mkMembership({
                    user: userC, room: roomId, mship: "invite", skey: userD
                })
            ];
            eventData[0].__prev_event = null;
            eventData[1].__prev_event = null;
            setNextSyncData(eventData);

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);
                httpBackend.flush("/sync", 1).then(function() {
                    expect(room.currentState.getMembers().length).toEqual(4);
                    expect(room.currentState.getMember(userC).name).toEqual("C");
                    expect(room.currentState.getMember(userC).membership).toEqual(
                        "join"
                    );
                    expect(room.currentState.getMember(userD).name).toEqual(userD);
                    expect(room.currentState.getMember(userD).membership).toEqual(
                        "invite"
                    );
                }).catch(utils.failTest).done(done);
            });
            httpBackend.flush("/sync", 1);
        });
    });

    describe("gappy sync", function() {
        it("should copy the last known state to the new timeline", function(done) {
            var eventData = [
                utils.mkMessage({user: userId, room: roomId}),
            ];
            setNextSyncData(eventData);
            NEXT_SYNC_DATA.rooms.join[roomId].timeline.limited = true;

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1).done(function() {
                    expect(room.timeline.length).toEqual(1);
                    expect(room.timeline[0].event).toEqual(eventData[0]);
                    expect(room.currentState.getMembers().length).toEqual(2);
                    expect(room.currentState.getMember(userId).name).toEqual(userName);
                    expect(room.currentState.getMember(userId).membership).toEqual(
                        "join"
                    );
                    expect(room.currentState.getMember(otherUserId).name).toEqual("Bob");
                    expect(room.currentState.getMember(otherUserId).membership).toEqual(
                        "join"
                    );
                    done();
                });
            });
            httpBackend.flush("/sync", 1);
        });

        it("should emit a 'Room.timelineReset' event", function(done) {
            var eventData = [
                utils.mkMessage({user: userId, room: roomId}),
            ];
            setNextSyncData(eventData);
            NEXT_SYNC_DATA.rooms.join[roomId].timeline.limited = true;

            client.on("sync", function(state) {
                if (state !== "PREPARED") { return; }
                var room = client.getRoom(roomId);

                var emitCount = 0;
                client.on("Room.timelineReset", function(emitRoom) {
                    expect(emitRoom).toEqual(room);
                    emitCount++;
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/sync", 1).done(function() {
                    expect(emitCount).toEqual(1);
                    done();
                });
            });
            httpBackend.flush("/sync", 1);
        });
    });
});
