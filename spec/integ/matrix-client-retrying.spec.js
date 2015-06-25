"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient retrying", function() {
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

    xit("should retry according to MatrixScheduler.retryFn", function() {

    });

    xit("should queue according to MatrixScheduler.queueFn", function() {

    });

    xit("should mark events as EventStatus.NOT_SENT when giving up", function() {

    });

    describe("resending", function() {
        xit("should be able to resend a NOT_SENT event", function() {

        });
        xit("should be able to resend a sent event", function() {

        });
    });
});
