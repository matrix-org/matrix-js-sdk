"use strict";
/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 * @module http-api
 */
var q = require("q");
var utils = require("./utils");

/*
TODO:
- CS: complete register function (doing stages)
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
*/

/**
 * A constant representing the URI path for version 1 of the Client-Server HTTP API.
 */
module.exports.PREFIX_V1 = "/_matrix/client/api/v1";

/**
 * A constant representing the URI path for version 2 alpha of the Client-Server
 * HTTP API.
 */
module.exports.PREFIX_V2_ALPHA = "/_matrix/client/v2_alpha";

/**
 * URI path for the identity API
 */
module.exports.PREFIX_IDENTITY_V1 = "/_matrix/identity/api/v1";

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
 * @param {bool} opts.onlyData True to return only the 'data' component of the
 * response (e.g. the parsed HTTP body). If false, requests will return status
 * codes and headers in addition to data. Default: false.
 * @param {string} opts.accessToken The access_token to send with requests. Can be
 * null to not send an access token.
 * @param {Object} opts.extraParams Optional. Extra query parameters to send on
 * requests.
 */
module.exports.MatrixHttpApi = function MatrixHttpApi(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request", "prefix"]);
    opts.onlyData = opts.onlyData || false;
    this.opts = opts;
};

module.exports.MatrixHttpApi.prototype = {

    // URI functions
    // =============

    /**
     * Get the HTTP URL for an MXC URI.
     * @param {string} mxc The mxc:// URI.
     * @param {Number} width The desired width of the thumbnail.
     * @param {Number} height The desired height of the thumbnail.
     * @param {string} resizeMethod The thumbnail resize method to use, either
     * "crop" or "scale".
     * @return {string} The complete URL to the content.
     */
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
        return this.opts.baseUrl + prefix + serverAndMediaId +
            (utils.keys(params).length === 0 ? "" :
            ("?" + utils.encodeParams(params))) + fragment;
    },

    /**
     * Get an identicon URL from an arbitrary string.
     * @param {string} identiconString The string to create an identicon for.
     * @param {Number} width The desired width of the image in pixels.
     * @param {Number} height The desired height of the image in pixels.
     * @return {string} The complete URL to the identicon.
     */
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
        return this.opts.baseUrl + path +
            (utils.keys(params).length === 0 ? "" :
                ("?" + utils.encodeParams(params)));
    },

    /**
     * Get the content repository url with query parameters.
     * @return {Object} An object with a 'base', 'path' and 'params' for base URL,
     *          path and query parameters respectively.
     */
    getContentUri: function() {
        var params = {
            access_token: this.opts.accessToken
        };
        return {
            base: this.opts.baseUrl,
            path: "/_matrix/media/v1/upload",
            params: params
        };
    },

    /**
     * Upload content to the Home Server
     * @param {File} file A File object (in a browser) or in Node,
                                 an object with properties:
                                 name: The file's name
                                 stream: A read stream
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     */
    uploadContent: function(file, callback) {
        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback
            );
        }
        var defer = q.defer();
        var url = this.opts.baseUrl + "/_matrix/media/v1/upload";
        // browser-request doesn't support File objects because it deep-copies
        // the options using JSON.parse(JSON.stringify(options)). Instead of
        // loading the whole file into memory as a string and letting
        // browser-request base64 encode and then decode it again, we just
        // use XMLHttpRequest directly.
        // (browser-request doesn't support progress either, which is also kind
        // of important here)
        if (global.XMLHttpRequest) {
            var xhr = new global.XMLHttpRequest();
            var cb = requestCallback(defer, callback, this.opts.onlyData);

            var timeout_fn = function() {
                xhr.abort();
                cb(new Error('Timeout'));
            };

            xhr.timeout_timer = setTimeout(timeout_fn, 30000);

            xhr.onreadystatechange = function() {
                switch (xhr.readyState) {
                    case global.XMLHttpRequest.DONE:
                        clearTimeout(xhr.timeout_timer);

                        var resp = JSON.parse(xhr.responseText);
                        if (resp.content_uri === undefined) {
                            cb(new Error('Bad response'));
                            return;
                        }

                        cb(undefined, xhr, resp.content_uri);
                        break;
                }
            };
            xhr.upload.addEventListener("progress", function(ev) {
                clearTimeout(xhr.timeout_timer);
                xhr.timeout_timer = setTimeout(timeout_fn, 30000);
                defer.notify(ev);
            });
            url += "?access_token=" + encodeURIComponent(this.opts.accessToken);
            url += "&filename=" + encodeURIComponent(file.name);

            xhr.open("POST", url);
            if (file.type) {
                xhr.setRequestHeader("Content-Type", file.type);
            } else {
                // if the file doesn't have a mime type, use a default since
                // the HS errors if we don't supply one.
                xhr.setRequestHeader("Content-Type", 'application/octet-stream');
            }
            xhr.send(file);
        } else {
            var queryParams = {
                filename: file.name,
                access_token: this.opts.accessToken
            };
            file.stream.pipe(
                this.opts.request({
                    uri: url,
                    qs: queryParams,
                    method: "POST"
                }, requestCallback(defer, callback, this.opts.onlyData))
            );
        }

        return defer.promise;
    },

    idServerRequest: function(callback, method, path, params, prefix) {
        var fullUri = this.opts.idBaseUrl + prefix + path;

        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback
            );
        }

        var opts = {
            uri: fullUri,
            method: method,
            withCredentials: false,
            json: false,
            _matrix_opts: this.opts
        };
        if (method == 'GET') {
            opts.qs = params;
        } else {
            opts.form = params;
        }

        var defer = q.defer();
        this.opts.request(
            opts,
            requestCallback(defer, callback, this.opts.onlyData)
        );
        return defer.promise;
    },

    /**
     * Perform an authorised request to the homeserver.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {Object} data The HTTP JSON body.
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    authedRequest: function(callback, method, path, queryParams, data) {
        if (!queryParams) { queryParams = {}; }
        queryParams.access_token = this.opts.accessToken;
        return this.request(callback, method, path, queryParams, data);
    },

    /**
     * Perform a request to the homeserver without any credentials.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {Object} data The HTTP JSON body.
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    request: function(callback, method, path, queryParams, data) {
        return this.requestWithPrefix(
            callback, method, path, queryParams, data, this.opts.prefix
        );
    },

    /**
     * Perform an authorised request to the homeserver with a specific path
     * prefix which overrides the default for this call only. Useful for hitting
     * different Matrix Client-Server versions.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {Object} data The HTTP JSON body.
     * @param {string} prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha".
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    authedRequestWithPrefix: function(callback, method, path, queryParams, data,
                                      prefix) {
        var fullUri = this.opts.baseUrl + prefix + path;
        if (!queryParams) {
            queryParams = {};
        }
        queryParams.access_token = this.opts.accessToken;
        return this._request(callback, method, fullUri, queryParams, data);
    },

    /**
     * Perform a request to the homeserver without any credentials but with a
     * specific path prefix which overrides the default for this call only.
     * Useful for hitting different Matrix Client-Server versions.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {Object} data The HTTP JSON body.
     * @param {string} prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha".
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
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
        if (!queryParams) {
            queryParams = {};
        }
        if (this.opts.extraParams) {
            for (var key in this.opts.extraParams) {
                if (!this.opts.extraParams.hasOwnProperty(key)) { continue; }
                queryParams[key] = this.opts.extraParams[key];
            }
        }
        var defer = q.defer();
        try {
            this.opts.request(
                {
                    uri: uri,
                    method: method,
                    withCredentials: false,
                    qs: queryParams,
                    body: data,
                    json: true,
                    _matrix_opts: this.opts
                },
                requestCallback(defer, callback, this.opts.onlyData)
            );
        }
        catch (ex) {
            defer.reject(ex);
            if (callback) {
                callback(ex);
            }
        }
        return defer.promise;
    }
};

/*
 * Returns a callback that can be invoked by an HTTP request on completion,
 * that will either resolve or reject the given defer as well as invoke the
 * given userDefinedCallback (if any).
 *
 * If onlyData is true, the defer/callback is invoked with the body of the
 * response, otherwise the result code.
 */
var requestCallback = function(defer, userDefinedCallback, onlyData) {
    userDefinedCallback = userDefinedCallback || function() {};

    return function(err, response, body) {
        if (!err && response.statusCode >= 400) {
            err = new module.exports.MatrixError(body);
            err.httpStatus = response.statusCode;
        }

        if (err) {
            defer.reject(err);
            userDefinedCallback(err);
        }
        else {
            var res = {
                code: response.statusCode,
                headers: response.headers,
                data: body
            };
            defer.resolve(onlyData ? body : res);
            userDefinedCallback(null, onlyData ? body : res);
        }
    };
};

/**
 * Construct a Matrix error. This is a JavaScript Error with additional
 * information specific to the standard Matrix error response.
 * @constructor
 * @param {Object} errorJson The Matrix error JSON returned from the homeserver.
 * @prop {string} errcode The Matrix 'errcode' value, e.g. "M_FORBIDDEN".
 * @prop {string} name Same as MatrixError.errcode but with a default unknown string.
 * @prop {string} message The Matrix 'error' value, e.g. "Missing token."
 * @prop {Object} data The raw Matrix error JSON used to construct this object.
 * @prop {integer} httpStatus The numeric HTTP status code given
 */
module.exports.MatrixError = function MatrixError(errorJson) {
    this.errcode = errorJson.errcode;
    this.name = errorJson.errcode || "Unknown error code";
    this.message = errorJson.error || "Unknown message";
    this.data = errorJson;
};
module.exports.MatrixError.prototype = Object.create(Error.prototype);
/** */
module.exports.MatrixError.prototype.constructor = module.exports.MatrixError;
