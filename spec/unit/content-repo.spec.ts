/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { getHttpUriForMxc } from "../../src/content-repo";

describe("ContentRepo", function () {
    const baseUrl = "https://my.home.server";

    describe("getHttpUriForMxc", function () {
        it("should do nothing to HTTP URLs when allowing direct links", function () {
            const httpUrl = "http://example.com/image.jpeg";
            expect(getHttpUriForMxc(baseUrl, httpUrl, undefined, undefined, undefined, true)).toEqual(httpUrl);
        });

        it("should return the empty string HTTP URLs by default", function () {
            const httpUrl = "http://example.com/image.jpeg";
            expect(getHttpUriForMxc(baseUrl, httpUrl)).toEqual("");
        });

        it("should return a download URL if no width/height/resize are specified", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual(
                baseUrl + "/_matrix/media/v3/download/server.name/resourceid",
            );
        });

        it("should allow redirects when requested on download URLs", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri, undefined, undefined, undefined, false, true)).toEqual(
                baseUrl + "/_matrix/media/v3/download/server.name/resourceid?allow_redirect=true",
            );
        });

        it("should allow redirects when requested on thumbnail URLs", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri, 32, 32, "scale", false, true)).toEqual(
                baseUrl +
                    "/_matrix/media/v3/thumbnail/server.name/resourceid?width=32&height=32&method=scale&allow_redirect=true",
            );
        });

        it("should return the empty string for null input", function () {
            expect(getHttpUriForMxc(null as any, "")).toEqual("");
        });

        it("should return a thumbnail URL if a width/height/resize is specified", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri, 32, 64, "crop")).toEqual(
                baseUrl + "/_matrix/media/v3/thumbnail/server.name/resourceid" + "?width=32&height=64&method=crop",
            );
        });

        it("should return an authenticated URL when requested", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri, undefined, undefined, undefined, undefined, true, true)).toEqual(
                baseUrl + "/_matrix/client/v1/media/download/server.name/resourceid?allow_redirect=true",
            );
            expect(getHttpUriForMxc(baseUrl, mxcUri, 64, 64, "scale", undefined, true, true)).toEqual(
                baseUrl +
                    "/_matrix/client/v1/media/thumbnail/server.name/resourceid?width=64&height=64&method=scale&allow_redirect=true",
            );
        });

        it("should force-enable allow_redirects when useAuthentication is set true", function () {
            const mxcUri = "mxc://server.name/resourceid";
            expect(getHttpUriForMxc(baseUrl, mxcUri, undefined, undefined, undefined, undefined, false, true)).toEqual(
                baseUrl + "/_matrix/client/v1/media/download/server.name/resourceid?allow_redirect=true",
            );
            expect(getHttpUriForMxc(baseUrl, mxcUri, 64, 64, "scale", undefined, false, true)).toEqual(
                baseUrl +
                    "/_matrix/client/v1/media/thumbnail/server.name/resourceid?width=64&height=64&method=scale&allow_redirect=true",
            );
        });

        it("should drop mxc urls with invalid server_name", () => {
            const mxcUri = "mxc://server.name:test/foobar";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual("");
        });

        it("should drop mxc urls with invalid media_id", () => {
            const mxcUri = "mxc://server.name/foobar:test";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual("");
        });

        it("should drop mxc urls attempting a path traversal attack", () => {
            const mxcUri = "mxc://../../../../foo";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual("");
        });

        it("should drop mxc urls attempting to pass query parameters", () => {
            const mxcUri = "mxc://server.name/foobar?bar=baz";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual("");
        });

        it("should drop mxc urls with too many parts", () => {
            const mxcUri = "mxc://server.name/foo//bar";
            expect(getHttpUriForMxc(baseUrl, mxcUri)).toEqual("");
        });
    });
});
