"use strict";
import 'source-map-support/register';
import Promise from 'bluebird';

const sdk = require("../..");
const HttpBackend = require("matrix-mock-request");
const utils = require("../test-utils");
const EventStatus = sdk.EventStatus;

import expect from 'expect';

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
        return httpBackend.stop();
    });

    xit("should retry according to MatrixScheduler.retryFn", function() {

    });

    xit("should queue according to MatrixScheduler.queueFn", function() {

    });

    xit("should mark events as EventStatus.NOT_SENT when giving up", function() {

    });

    xit("should mark events as EventStatus.QUEUED when queued", function() {

    });

    it("should mark events as EventStatus.CANCELLED when cancelled", function() {
        // send a couple of events; the second will be queued
        const p1 = client.sendMessage(roomId, "m1").then(function(ev) {
            // we expect the first message to fail
            throw new Error('Message 1 unexpectedly sent successfully');
        }, (e) => {
            // this is expected
        });

        // XXX: it turns out that the promise returned by this message
        // never gets resolved.
        // https://github.com/matrix-org/matrix-js-sdk/issues/496
        client.sendMessage(roomId, "m2");

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

        // wait for the localecho of ev1 to be updated
        const p3 = new Promise((resolve, reject) => {
            room.on("Room.localEchoUpdated", (ev0) => {
                if(ev0 === ev1) {
                    resolve();
                }
            });
        }).then(function() {
            expect(ev1.status).toEqual(EventStatus.NOT_SENT);
            expect(tl.length).toEqual(1);

            // cancel the first message
            client.cancelPendingEvent(ev1);
            expect(ev1.status).toEqual(EventStatus.CANCELLED);
            expect(tl.length).toEqual(0);
        });

        return Promise.all([
            p1,
            p3,
            httpBackend.flushAllExpected(),
        ]);
    });

    describe("resending", function() {
        xit("should be able to resend a NOT_SENT event", function() {

        });
        xit("should be able to resend a sent event", function() {

        });
    });
});
