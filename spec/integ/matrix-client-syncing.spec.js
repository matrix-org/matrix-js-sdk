"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");
var MatrixEvent = sdk.MatrixEvent;
var EventTimeline = sdk.EventTimeline;

describe("MatrixClient syncing", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var selfUserId = "@alice:localhost";
    var selfAccessToken = "aseukfgwef";
    var otherUserId = "@bob:localhost";
    var userA = "@alice:bar";
    var userB = "@bob:bar";
    var userC = "@claire:bar";
    var roomOne = "!foo:localhost";
    var roomTwo = "!bar:localhost";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: selfUserId,
            accessToken: selfAccessToken
        });
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
    });

    describe("startClient", function() {
        var syncData = {
            next_batch: "batch_token",
            rooms: {},
            presence: {}
        };

        it("should /sync after /pushrules and /filter.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            httpBackend.flush().done(function() {
                done();
            });
        });

        it("should pass the 'next_batch' token from /sync to the since= param " +
            " of the next /sync", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").check(function(req) {
                expect(req.queryParams.since).toEqual(syncData.next_batch);
            }).respond(200, syncData);

            client.startClient();

            httpBackend.flush().done(function() {
                done();
            });
        });
    });

    describe("resolving invites to profile info", function() {

        var syncData = {
            next_batch: "s_5_3",
            presence: {
                events: []
            },
            rooms: {
                join: {

                }
            }
        };

        beforeEach(function() {
            syncData.presence.events = [];
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "hello"
                        })
                    ]
                },
                state: {
                    events: [
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: otherUserId
                        }),
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: selfUserId
                        }),
                        utils.mkEvent({
                            type: "m.room.create", room: roomOne, user: selfUserId,
                            content: {
                                creator: selfUserId
                            }
                        })
                    ]
                }
            };
        });

        it("should resolve incoming invites from /sync", function(done) {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC
                })
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/profile/" + encodeURIComponent(userC)).respond(
                200, {
                    avatar_url: "mxc://flibble/wibble",
                    displayname: "The Boss"
                }
            );

            client.startClient({
                resolveInvitesToProfiles: true
            });

            httpBackend.flush().done(function() {
                var member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual("The Boss");
                expect(
                    member.getAvatarUrl("home.server.url", null, null, null, false)
                ).toBeDefined();
                done();
            });
        });

        it("should use cached values from m.presence wherever possible", function(done) {
            syncData.presence.events = [
                utils.mkPresence({
                    user: userC, presence: "online", name: "The Ghost"
                }),
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC
                })
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient({
                resolveInvitesToProfiles: true
            });

            httpBackend.flush().done(function() {
                var member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual("The Ghost");
                done();
            });
        });

        it("should result in events on the room member firing", function(done) {
            syncData.presence.events = [
                utils.mkPresence({
                    user: userC, presence: "online", name: "The Ghost"
                })
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC
                })
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            var latestFiredName = null;
            client.on("RoomMember.name", function(event, m) {
                if (m.userId === userC && m.roomId === roomOne) {
                    latestFiredName = m.name;
                }
            });

            client.startClient({
                resolveInvitesToProfiles: true
            });

            httpBackend.flush().done(function() {
                expect(latestFiredName).toEqual("The Ghost");
                done();
            });
        });

        it("should no-op if resolveInvitesToProfiles is not set", function(done) {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC
                })
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            httpBackend.flush().done(function() {
                var member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual(userC);
                expect(
                    member.getAvatarUrl("home.server.url", null, null, null, false)
                ).toBeNull();
                done();
            });
        });
    });

    describe("users", function() {
        var syncData = {
            next_batch: "nb",
            presence: {
                events: [
                    utils.mkPresence({
                        user: userA, presence: "online"
                    }),
                    utils.mkPresence({
                        user: userB, presence: "unavailable"
                    })
                ]
            }
        };

        it("should create users for presence events from /sync",
        function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            httpBackend.flush().done(function() {
                expect(client.getUser(userA).presence).toEqual("online");
                expect(client.getUser(userB).presence).toEqual("unavailable");
                done();
            });
        });
    });

    describe("room state", function() {
        var msgText = "some text here";
        var otherDisplayName = "Bob Smith";

        var syncData = {
            rooms: {
                join: {

                }
            }
        };
        syncData.rooms.join[roomOne] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "hello"
                    })
                ]
            },
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: otherUserId,
                        content: {
                            name: "Old room name"
                        }
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: otherUserId
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: selfUserId
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomOne, user: selfUserId,
                        content: {
                            creator: selfUserId
                        }
                    })
                ]
            }
        };
        syncData.rooms.join[roomTwo] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomTwo, user: otherUserId, msg: "hiii"
                    })
                ]
            },
            state: {
                events: [
                    utils.mkMembership({
                        room: roomTwo, mship: "join", user: otherUserId,
                        name: otherDisplayName
                    }),
                    utils.mkMembership({
                        room: roomTwo, mship: "join", user: selfUserId
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomTwo, user: selfUserId,
                        content: {
                            creator: selfUserId
                        }
                    })
                ]
            }
        };

        var nextSyncData = {
            rooms: {
                join: {

                }
            }
        };

        nextSyncData.rooms.join[roomOne] = {
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: selfUserId,
                        content: { name: "A new room name" }
                    })
                ]
            }
        };

        nextSyncData.rooms.join[roomTwo] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomTwo, user: otherUserId, msg: msgText
                    })
                ]
            },
            ephemeral: {
                events: [
                    utils.mkEvent({
                        type: "m.typing", room: roomTwo,
                        content: { user_ids: [otherUserId] }
                    })
                ]
            }
        };

        it("should continually recalculate the right room name.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomOne);
                // should have clobbered the name to the one from /events
                expect(room.name).toEqual(
                    nextSyncData.rooms.join[roomOne].state.events[0].content.name
                );
                done();
            });
        });

        it("should store the right events in the timeline.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                // should have added the message from /events
                expect(room.timeline.length).toEqual(2);
                expect(room.timeline[1].getContent().body).toEqual(msgText);
                done();
            });
        });

        it("should set the right room name.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();
            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                // should use the display name of the other person.
                expect(room.name).toEqual(otherDisplayName);
                done();
            });
        });

        it("should set the right user's typing flag.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                var member = room.getMember(otherUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(true);
                member = room.getMember(selfUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(false);
                done();
            });
        });

        xit("should update power levels for users in a room", function() {

        });

        xit("should update the room topic", function() {

        });
    });

    describe("timeline", function() {
        beforeEach(function() {
            var syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "hello"
                        }),
                    ],
                    prev_batch: "pagTok",
                },
            };

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();
            httpBackend.flush();
        });

        it("should set the back-pagination token on new rooms", function(done) {
            var syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomTwo] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomTwo, user: otherUserId, msg: "roomtwo"
                        }),
                    ],
                    prev_batch: "roomtwotok",
                },
            };

            httpBackend.when("GET", "/sync").respond(200, syncData);

            httpBackend.flush().then(function() {
                var room = client.getRoom(roomTwo);
                var tok = room.getLiveTimeline()
                    .getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("roomtwotok");
                done();
            }).catch(utils.failTest).done();
        });

        it("should set the back-pagination token on gappy syncs", function(done) {
            var syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "world"
                        }),
                    ],
                    limited: true,
                    prev_batch: "newerTok",
                },
            };
            httpBackend.when("GET", "/sync").respond(200, syncData);

            var resetCallCount = 0;
            // the token should be set *before* timelineReset is emitted
            client.on("Room.timelineReset", function(room) {
                resetCallCount++;

                var tl = room.getLiveTimeline();
                expect(tl.getEvents().length).toEqual(0);
                var tok = tl.getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("newerTok");
            });

            httpBackend.flush().then(function() {
                var room = client.getRoom(roomOne);
                var tl = room.getLiveTimeline();
                expect(tl.getEvents().length).toEqual(1);
                expect(resetCallCount).toEqual(1);
                done();
            }).catch(utils.failTest).done();
        });
    });

    describe("receipts", function() {
        var syncData = {
            rooms: {
                join: {

                }
            }
        };
        syncData.rooms.join[roomOne] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "hello"
                    }),
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "world"
                    })
                ]
            },
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: otherUserId,
                        content: {
                            name: "Old room name"
                        }
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: otherUserId
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: selfUserId
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomOne, user: selfUserId,
                        content: {
                            creator: selfUserId
                        }
                    })
                ]
            }
        };

        beforeEach(function() {
            syncData.rooms.join[roomOne].ephemeral = {
                events: []
            };
        });

        it("should sync receipts from /sync.", function(done) {
            var ackEvent = syncData.rooms.join[roomOne].timeline.events[0];
            var receipt = {};
            receipt[ackEvent.event_id] = {
                "m.read": {}
            };
            receipt[ackEvent.event_id]["m.read"][userC] = {
                ts: 176592842636
            };
            syncData.rooms.join[roomOne].ephemeral.events = [{
                content: receipt,
                room_id: roomOne,
                type: "m.receipt"
            }];
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomOne);
                expect(room.getReceiptsForEvent(new MatrixEvent(ackEvent))).toEqual([{
                    type: "m.read",
                    userId: userC,
                    data: {
                        ts: 176592842636
                    }
                }]);
                done();
            });
        });
    });

    describe("of a room", function() {
        xit("should sync when a join event (which changes state) for the user" +
        " arrives down the event stream (e.g. join from another device)", function() {

        });

        xit("should sync when the user explicitly calls joinRoom", function() {

        });
    });

    describe("syncLeftRooms", function() {
        beforeEach(function(done) {
            client.startClient();

            httpBackend.flush().then(function() {
                // the /sync call from syncLeftRooms ends up in the request
                // queue behind the call from the running client; add a response
                // to flush the client's one out.
                httpBackend.when("GET", "/sync").respond(200, {});

                done();
            });
        });

        it("should create and use an appropriate filter", function(done) {
            httpBackend.when("POST", "/filter").check(function(req) {
                expect(req.data).toEqual({
                    room: { timeline: {limit: 1},
                            include_leave: true }});
            }).respond(200, { filter_id: "another_id" });

            httpBackend.when("GET", "/sync").check(function(req) {
                expect(req.queryParams.filter).toEqual("another_id");
                done();
            }).respond(200, {});

            client.syncLeftRooms();

            // first flush the filter request; this will make syncLeftRooms
            // make its /sync call
            httpBackend.flush("/filter").then(function() {
                // flush the syncs
                return httpBackend.flush();
            }).catch(utils.failTest);
        });

        it("should set the back-pagination token on left rooms", function(done) {
            var syncData = {
                next_batch: "batch_token",
                rooms: {
                    leave: {}
                },
            };

            syncData.rooms.leave[roomTwo] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomTwo, user: otherUserId, msg: "hello"
                        }),
                    ],
                    prev_batch: "pagTok",
                },
            };

            httpBackend.when("POST", "/filter").respond(200, {
                filter_id: "another_id"
            });

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.syncLeftRooms().then(function() {
                var room = client.getRoom(roomTwo);
                var tok = room.getLiveTimeline().getPaginationToken(
                    EventTimeline.BACKWARDS);

                expect(tok).toEqual("pagTok");
                done();
            }).catch(utils.failTest).done();

            // first flush the filter request; this will make syncLeftRooms
            // make its /sync call
            httpBackend.flush("/filter").then(function() {
                return httpBackend.flush();
            }).catch(utils.failTest);
        });
    });
});
