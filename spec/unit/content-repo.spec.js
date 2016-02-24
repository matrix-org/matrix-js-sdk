"use strict";
var ContentRepo = require("../../lib/content-repo");
var testUtils = require("../test-utils");

describe("ContentRepo", function() {
    var baseUrl = "https://my.home.server";

    beforeEach(function() {
        testUtils.beforeEach(this);
    });

    describe("getHttpUriForMxc", function() {
        it("should do nothing to HTTP URLs when allowing direct links", function() {
            var httpUrl = "http://example.com/image.jpeg";
            expect(
                ContentRepo.getHttpUriForMxc(
                    baseUrl, httpUrl, undefined, undefined, undefined, true
                )
            ).toEqual(httpUrl);
        });

        it("should return the empty string HTTP URLs by default", function() {
            var httpUrl = "http://example.com/image.jpeg";
            expect(ContentRepo.getHttpUriForMxc(baseUrl, httpUrl)).toEqual("");
        });

        it("should return a download URL if no width/height/resize are specified",
        function() {
            var mxcUri = "mxc://server.name/resourceid";
            expect(ContentRepo.getHttpUriForMxc(baseUrl, mxcUri)).toEqual(
                baseUrl + "/_matrix/media/v1/download/server.name/resourceid"
            );
        });

        it("should return the empty string for null input", function() {
            expect(ContentRepo.getHttpUriForMxc(null)).toEqual("");
        });

        it("should return a thumbnail URL if a width/height/resize is specified",
        function() {
            var mxcUri = "mxc://server.name/resourceid";
            expect(ContentRepo.getHttpUriForMxc(baseUrl, mxcUri, 32, 64, "crop")).toEqual(
                baseUrl + "/_matrix/media/v1/thumbnail/server.name/resourceid" +
                "?width=32&height=64&method=crop"
            );
        });

        it("should put fragments from mxc:// URIs after any query parameters",
        function() {
            var mxcUri = "mxc://server.name/resourceid#automade";
            expect(ContentRepo.getHttpUriForMxc(baseUrl, mxcUri, 32)).toEqual(
                baseUrl + "/_matrix/media/v1/thumbnail/server.name/resourceid" +
                "?width=32#automade"
            );
        });

        it("should put fragments from mxc:// URIs at the end of the HTTP URI",
        function() {
            var mxcUri = "mxc://server.name/resourceid#automade";
            expect(ContentRepo.getHttpUriForMxc(baseUrl, mxcUri)).toEqual(
                baseUrl + "/_matrix/media/v1/download/server.name/resourceid#automade"
            );
        });
    });

    describe("getIdenticonUri", function() {
        it("should do nothing for null input", function() {
            expect(ContentRepo.getIdenticonUri(null)).toEqual(null);
        });

        it("should set w/h by default to 96", function() {
            expect(ContentRepo.getIdenticonUri(baseUrl, "foobar")).toEqual(
                baseUrl + "/_matrix/media/v1/identicon/foobar" +
                "?width=96&height=96"
            );
        });

        it("should be able to set custom w/h", function() {
            expect(ContentRepo.getIdenticonUri(baseUrl, "foobar", 32, 64)).toEqual(
                baseUrl + "/_matrix/media/v1/identicon/foobar" +
                "?width=32&height=64"
            );
        });

        it("should URL encode the identicon string", function() {
            expect(ContentRepo.getIdenticonUri(baseUrl, "foo#bar", 32, 64)).toEqual(
                baseUrl + "/_matrix/media/v1/identicon/foo%23bar" +
                "?width=32&height=64"
            );
        });
    });
});
