/**
 * @module content-repo
 */
var utils = require("./utils");

module.exports = {
    /**
     * Get the HTTP URL for an MXC URI.
     * @param {string} baseUrl The base homeserver url which has a content repo.
     * @param {string} mxc The mxc:// URI.
     * @param {Number} width The desired width of the thumbnail.
     * @param {Number} height The desired height of the thumbnail.
     * @param {string} resizeMethod The thumbnail resize method to use, either
     * "crop" or "scale".
     * @return {string} The complete URL to the content.
     */
    getHttpUriForMxc: function(baseUrl, mxc, width, height, resizeMethod) {
        if (typeof mxc !== "string" || !mxc) {
            return mxc;
        }
        if (mxc.indexOf("mxc://") !== 0) {
            return mxc;
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
     * @param {Number} width The desired width of the image in pixels.
     * @param {Number} height The desired height of the image in pixels.
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
