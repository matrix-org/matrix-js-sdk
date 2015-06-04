"use strict";

var utils = require("./utils");

/*
TODO:
- CS: complete register function (doing stages)
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
- uploadContent (?)
*/

/**
 * A constant representing the URI path for version 1 of the Client-Server HTTP API.
 */
module.exports.PREFIX_V1 = "/_matrix/client/api/v1";

/**
 * A constant representing the URI path for version 2 Alpha of the Client-Server
 * HTTP API.
 */
module.exports.PREFIX_V2_ALPHA_PREFIX = "/_matrix/client/v2_alpha";

var HEADERS = {
    "User-Agent": "matrix-js"
};

/**
 * Construct a MatrixHttpApi.
 * @constructor
 * @param {Object} opts The options to use for this HTTP API.
 * @param {string} opts.baseUrl Required. The base client-server URL e.g.
 * 'http://localhost:8008'.
 * @param {Function} opts.request Required. The function to call for HTTP
 * requests. This function must look like function(opts, callback){ ... }.
 * @param {string} opts.prefix Required. The matrix client prefix to use, e.g.
 * '/_matrix/client/api/v1'. See PREFIX_V1 and PREFIX_V2_ALPHA for constants.
 * @param {boolean} opts.setUserAgent True to set a user-agent string on requests.
 * Default: True, unless there is a 'window' global present in which case the default
 * is False.
 * @param {string} opts.accessToken The access_token to send with requests. Can be
 * null to not send an access token.
 */
function MatrixHttpApi(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request", "prefix"]);
    this.opts = opts;
}

MatrixHttpApi.prototype = {

    // URI functions
    // =============

    getHttpUriForMxc: function(mxc, width, height, resizeMethod) {
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
        if (Object.keys(params).length > 0) {
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
        return this.credentials.baseUrl + prefix + serverAndMediaId +
            (Object.keys(params).length === 0 ? "" :
            ("?" + utils.encodeParams(params))) + fragment;
    },

    getIdenticonUri: function(identiconString, width, height) {
        if (!identiconString) {
            return;
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
        return this.credentials.baseUrl + path +
            (Object.keys(params).length === 0 ? "" :
                ("?" + utils.encodeParams(params)));
    },

    /**
     * Get the content repository url with query parameters.
     * @return {Object} An object with a 'base', 'path' and 'params' for base URL,
     *          path and query parameters respectively.
     */
    getContentUri: function() {
        var params = {
            access_token: this.credentials.accessToken
        };
        return {
            base: this.credentials.baseUrl,
            path: "/_matrix/media/v1/upload",
            params: params
        };
    },

    authedRequest: function(callback, method, path, queryParams, data) {
        if (!queryParams) { queryParams = {}; }
        queryParams.access_token = this.opts.accessToken;
        return this.request(callback, method, path, queryParams, data);
    },

    request: function(callback, method, path, queryParams, data) {
        return this.requestWithPrefix(
            callback, method, path, queryParams, data, this.opts.prefix
        );
    },

    authedRequestWithPrefix: function(callback, method, path, queryParams, data,
                                      prefix) {
        var fullUri = this.opts.baseUrl + prefix + path;
        if (!queryParams) {
            queryParams = {};
        }
        queryParams.access_token = this.opts.accessToken;
        return this._request(callback, method, fullUri, queryParams, data);
    },

    requestWithPrefix: function(callback, method, path, queryParams, data, prefix) {
        var fullUri = this.opts.baseUrl + prefix + path;
        if (!queryParams) {
            queryParams = {};
        }
        return this._request(callback, method, fullUri, queryParams, data);
    },

    _request: function(callback, method, uri, queryParams, data) {
        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback
            );
        }

        return this.opts.request(
        {
            uri: uri,
            method: method,
            withCredentials: false,
            qs: queryParams,
            body: data,
            json: true,
            headers: HEADERS,
            _matrix_opts: this.opts
        },
        requestCallback(callback)
        );
    }
};


var requestCallback = function(userDefinedCallback) {
    if (!userDefinedCallback) {
        return undefined;
    }
    return function(err, response, body) {
        if (err) {
            return userDefinedCallback(err);
        }
        if (response.statusCode >= 400) {
            return userDefinedCallback(body);
        }
        else {
            userDefinedCallback(null, body);
        }
    };
};



/**
 * The Matrix HTTP API class.
 */
module.exports.MatrixHttpApi = MatrixHttpApi;
