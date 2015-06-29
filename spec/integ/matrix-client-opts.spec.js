"use strict";
var sdk = require("../..");
var MatrixClient = sdk.MatrixClient;
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient opts", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var userId = "@alice:localhost";
    var userB = "@bob:localhost";
    var accessToken = "aseukfgwef";
    var roomId = "!foo:bar";
    var eventData = {
        chunk: [],
        start: "s",
        end: "e"
    };
    var initialSync = {
        end: "s_5_3",
        presence: [],
        rooms: [{
            membership: "join",
            room_id: roomId,
            messages: {
                start: "f_1_1",
                end: "f_2_2",
                chunk: [
                    utils.mkMessage({
                        room: roomId, user: userB, msg: "hello"
                    })
                ]
            },
            state: [
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: userB,
                    content: {
                        name: "Old room name"
                    }
                }),
                utils.mkMembership({
                    room: roomId, mship: "join", user: userB, name: "Bob"
                }),
                utils.mkMembership({
                    room: roomId, mship: "join", user: userId, name: "Alice"
                }),
                utils.mkEvent({
                    type: "m.room.create", room: roomId, user: userId,
                    content: {
                        creator: userId
                    }
                })
            ]
        }]
    };

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("without opts.store", function() {
        beforeEach(function() {
            client = new MatrixClient({
                request: httpBackend.requestFn,
                store: undefined,
                baseUrl: baseUrl,
                userId: userId,
                accessToken: accessToken,
                scheduler: new sdk.MatrixScheduler()
            });
        });

        it("should be able to send messages", function(done) {
            var eventId = "$flibble:wibble";
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: eventId
            });
            client.sendTextMessage("!foo:bar", "a body", "txn1").done(function(res) {
                expect(res.event_id).toEqual(eventId);
                done();
            });
            httpBackend.flush("/txn1", 1);
        });

        it("should be able to sync / get new events", function(done) {
            var expectedEventTypes = [ // from /initialSync
                "m.room.message", "m.room.name", "m.room.member", "m.room.member",
                "m.room.create"
            ];
            client.on("event", function(event) {
                expect(expectedEventTypes.indexOf(event.getType())).not.toEqual(
                    -1, "Recv unexpected event type: " + event.getType()
                );
                expectedEventTypes.splice(
                    expectedEventTypes.indexOf(event.getType()), 1
                );
            });
            httpBackend.when("GET", "/pushrules").respond(200, {});
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);
            client.startClient();
            httpBackend.flush("/pushrules", 1).then(function() {
                return httpBackend.flush("/initialSync", 1);
            }).then(function() {
                return httpBackend.flush("/events", 1);
            }).done(function() {
                expect(expectedEventTypes.length).toEqual(
                    0, "Expected to see event types: " + expectedEventTypes
                );
                done();
            });
        });
    });

    describe("without opts.scheduler", function() {
        beforeEach(function() {
            client = new MatrixClient({
                request: httpBackend.requestFn,
                store: new sdk.MatrixInMemoryStore(),
                baseUrl: baseUrl,
                userId: userId,
                accessToken: accessToken,
                scheduler: undefined
            });
        });

        it("shouldn't retry sending events", function(done) {
            httpBackend.when("PUT", "/txn1").fail(500, {
                errcode: "M_SOMETHING",
                error: "Ruh roh"
            });
            client.sendTextMessage("!foo:bar", "a body", "txn1").done(function(res) {
                expect(false).toBe(true, "sendTextMessage resolved but shouldn't");
            }, function(err) {
                expect(err.errcode).toEqual("M_SOMETHING");
                done();
            });
            httpBackend.flush("/txn1", 1);
        });

        it("shouldn't queue events", function(done) {
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: "AAA"
            });
            httpBackend.when("PUT", "/txn2").respond(200, {
                event_id: "BBB"
            });
            var sentA = false;
            var sentB = false;
            client.sendTextMessage("!foo:bar", "a body", "txn1").done(function(res) {
                sentA = true;
                expect(sentB).toBe(true);
            });
            client.sendTextMessage("!foo:bar", "b body", "txn2").done(function(res) {
                sentB = true;
                expect(sentA).toBe(false);
            });
            httpBackend.flush("/txn2", 1).done(function() {
                httpBackend.flush("/txn1", 1).done(function() {
                    done();
                });
            });
        });

        it("should be able to send messages", function(done) {
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: "foo"
            });
            client.sendTextMessage("!foo:bar", "a body", "txn1").done(function(res) {
                expect(res.event_id).toEqual("foo");
                done();
            });
            httpBackend.flush("/txn1", 1);
        });
    });
});
