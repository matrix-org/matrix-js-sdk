"use strict";
var sdk = require("../..");
var MatrixClient = sdk.MatrixClient;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var userId = "@alice:bar";
    var client;

    beforeEach(function() {
        utils.beforeEach(this);
    });

    describe("getSyncState", function() {

        it("should return null if the client isn't started", function() {

        });

        it("should return the same sync state as emitted sync events", function() {

        });
    });

    describe("retryImmediately", function() {
        it("should return false if there is no request waiting", function() {

        });

        it("should return true if there is a request waiting", function() {

        });

        it("should work on /initialSync", function() {

        });

        it("should work on /events", function() {

        });

        it("should work on /pushrules", function() {

        });
    });

    describe("emitted sync events", function() {

        it("should transition null -> PREPARED after /initialSync", function() {

        });

        it("should transition null -> ERROR after a failed /initialSync", function() {

        });

        it("should transition ERROR -> PREPARED after /initialSync if prev failed",
        function() {

        });

        it("should transition PREPARED -> SYNCING after /initialSync", function() {

        });

        it("should transition SYNCING -> ERROR after a failed /events", function() {

        });

        it("should transition ERROR -> SYNCING after /events if prev failed", function() {

        });

        it("should transition ERROR -> ERROR if multiple /events fails", function() {

        });
    });
});
