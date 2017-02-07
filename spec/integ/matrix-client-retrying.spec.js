"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const HttpBackend = require("../mock-request");
const utils = require("../test-utils");
const EventStatus = sdk.EventStatus;

describe("MatrixClient retrying", function() {
    const baseUrl = "http://localhost.or.something";
    let client = null;
    let httpBackend = null;
    let scheduler;
    const userId = "@alice:localhost";
    const accessToken = "aseukfgwef";
    const roomId = "!room:here";
    let room;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        scheduler = new sdk.MatrixScheduler();
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken,
            scheduler: scheduler,
        });
        room = new sdk.Room(roomId);
        client.store.storeRoom(room);
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    xit("should retry according to MatrixScheduler.retryFn", function() {

    });

    xit("should queue according to MatrixScheduler.queueFn", function() {

    });

    xit("should mark events as EventStatus.NOT_SENT when giving up", function() {

    });

    xit("should mark events as EventStatus.QUEUED when queued", function() {

    });

    it("should mark events as EventStatus.CANCELLED when cancelled", function(done) {
        // send a couple of events; the second will be queued
        client.sendMessage(roomId, "m1").then(function(ev) {
            expect(ev).toEqual(ev1);
        });
        client.sendMessage(roomId, "m2").then(function(ev) {
            expect(ev).toEqual(ev2);
        });

        // both events should be in the timeline at this point
        const tl = room.getLiveTimeline().getEvents();
        expect(tl.length).toEqual(2);
        const ev1 = tl[0];
        const ev2 = tl[1];

        expect(ev1.status).toEqual(EventStatus.SENDING);
        expect(ev2.status).toEqual(EventStatus.SENDING);

        // the first message should get sent, and the second should get queued
        httpBackend.when("PUT", "/send/m.room.message/").check(function(rq) {
            // ev2 should now have been queued
            expect(ev2.status).toEqual(EventStatus.QUEUED);

            // now we can cancel the second and check everything looks sane
            client.cancelPendingEvent(ev2);
            expect(ev2.status).toEqual(EventStatus.CANCELLED);
            expect(tl.length).toEqual(1);

            // shouldn't be able to cancel the first message yet
            expect(function() {
                client.cancelPendingEvent(ev1);
            }).toThrow();
        }).respond(400); // fail the first message

        httpBackend.flush().then(function() {
            expect(ev1.status).toEqual(EventStatus.NOT_SENT);
            expect(tl.length).toEqual(1);

            // cancel the first message
            client.cancelPendingEvent(ev1);
            expect(ev1.status).toEqual(EventStatus.CANCELLED);
            expect(tl.length).toEqual(0);
        }).catch(utils.failTest).done(done);
    });

    describe("resending", function() {
        xit("should be able to resend a NOT_SENT event", function() {

        });
        xit("should be able to resend a sent event", function() {

        });
    });
});
