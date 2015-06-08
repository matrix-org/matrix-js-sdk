"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient(baseUrl);
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("startClient", function() {
        var initialSync = {
            end: "s_5_3",
            presence: [],
            rooms: []
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: []
        };

        it("should start with /initialSync then move onto /events.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
                done();
            });
        });

        it("should pass the 'end' token from /initialSync to the from= param " +
            " of /events", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").check(function(req) {
                expect(req.queryParams.from).toEqual(initialSync.end);
            }).respond(200, eventData);

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
                done();
            });
        });
    });

});
