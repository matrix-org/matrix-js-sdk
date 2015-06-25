"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient opts", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var userId = "@alice:localhost";
    var accessToken = "aseukfgwef";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken
        });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("without opts.store", function() {
        xit("should be able to send messages", function() {

        });

        xit("should be able to sync / get new events", function() {
            // use 'events' emissions.
        });
    });

    describe("without opts.scheduler", function() {
        xit("shouldn't retry sending events", function() {

        });

        xit("shouldn't queue events", function() {

        });

        xit("should be able to send messages", function() {

        });
    });
});
