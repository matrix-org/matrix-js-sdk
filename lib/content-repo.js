/*
Copyright 2015, 2016 OpenMarket Ltd

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
/**
 * @module content-repo
 */
var utils = require("./utils");

/** Content Repo utility functions */
module.exports = {
    /**
     * Get the HTTP URL for an MXC URI.
     * @param {string} baseUrl The base homeserver url which has a content repo.
     * @param {string} mxc The mxc:// URI.
     * @param {Number} width The desired width of the thumbnail.
     * @param {Number} height The desired height of the thumbnail.
     * @param {string} resizeMethod The thumbnail resize method to use, either
     * "crop" or "scale".
     * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
     * directly. Fetching such URLs will leak information about the user to
     * anyone they share a room with. If false, will return the emptry string
     * for such URLs.
     * @return {string} The complete URL to the content.
     */
    getHttpUriForMxc: function(baseUrl, mxc, width, height,
                               resizeMethod, allowDirectLinks) {
        if (typeof mxc !== "string" || !mxc) {
            return '';
        }
        if (mxc.indexOf("mxc://") !== 0) {
            if (allowDirectLinks) {
                return mxc;
            } else {
                return '';
            }
        }
        var serverAndMediaId = mxc.slice(6); // strips mxc://
        var prefix = "/_matrix/media/v1/download/";
        var params = {};

        if (width) {
            params.width = width;
        }
        if (height) {
            params.height = height;
        }
        if (resizeMethod) {
            params.method = resizeMethod;
        }
        if (utils.keys(params).length > 0) {
            // these are thumbnailing params so they probably want the
            // thumbnailing API...
            prefix = "/_matrix/media/v1/thumbnail/";
        }

        var fragmentOffset = serverAndMediaId.indexOf("#"),
            fragment = "";
        if (fragmentOffset >= 0) {
            fragment = serverAndMediaId.substr(fragmentOffset);
            serverAndMediaId = serverAndMediaId.substr(0, fragmentOffset);
        }
        return baseUrl + prefix + serverAndMediaId +
            (utils.keys(params).length === 0 ? "" :
            ("?" + utils.encodeParams(params))) + fragment;
    },

    /**
     * Get an identicon URL from an arbitrary string.
     * @param {string} baseUrl The base homeserver url which has a content repo.
     * @param {string} identiconString The string to create an identicon for.
     * @param {Number} width The desired width of the image in pixels. Default: 96.
     * @param {Number} height The desired height of the image in pixels. Default: 96.
     * @return {string} The complete URL to the identicon.
     */
    getIdenticonUri: function(baseUrl, identiconString, width, height) {
        if (!identiconString) {
            return null;
        }
        if (!width) { width = 96; }
        if (!height) { height = 96; }
        var params = {
            width: width,
            height: height
        };

        var path = utils.encodeUri("/_matrix/media/v1/identicon/$ident", {
            $ident: identiconString
        });
        return baseUrl + path +
            (utils.keys(params).length === 0 ? "" :
                ("?" + utils.encodeParams(params)));
    }
};
