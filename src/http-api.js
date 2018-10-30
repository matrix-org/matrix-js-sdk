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
"use strict";
/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 * @module http-api
 */
import Promise from 'bluebird';
const parseContentType = require('content-type').parse;

const utils = require("./utils");

// we use our own implementation of setTimeout, so that if we get suspended in
// the middle of a /sync, we cancel the sync as soon as we awake, rather than
// waiting for the delay to elapse.
const callbacks = require("./realtime-callbacks");

/*
TODO:
- CS: complete register function (doing stages)
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
*/

/**
 * A constant representing the URI path for release 0 of the Client-Server HTTP API.
 */
module.exports.PREFIX_R0 = "/_matrix/client/r0";

/**
 * A constant representing the URI path for as-yet unspecified Client-Server HTTP APIs.
 */
module.exports.PREFIX_UNSTABLE = "/_matrix/client/unstable";

/**
 * URI path for the identity API
 */
module.exports.PREFIX_IDENTITY_V1 = "/_matrix/identity/api/v1";

/**
 * URI path for the media repo API
 */
module.exports.PREFIX_MEDIA_R0 = "/_matrix/media/r0";

/**
 * Construct a MatrixHttpApi.
 * @constructor
 * @param {EventEmitter} event_emitter The event emitter to use for emitting events
 * @param {Object} opts The options to use for this HTTP API.
 * @param {string} opts.baseUrl Required. The base client-server URL e.g.
 * 'http://localhost:8008'.
 * @param {Function} opts.request Required. The function to call for HTTP
 * requests. This function must look like function(opts, callback){ ... }.
 * @param {string} opts.prefix Required. The matrix client prefix to use, e.g.
 * '/_matrix/client/r0'. See PREFIX_R0 and PREFIX_UNSTABLE for constants.
 *
 * @param {boolean} opts.onlyData True to return only the 'data' component of the
 * response (e.g. the parsed HTTP body). If false, requests will return an
 * object with the properties <tt>code</tt>, <tt>headers</tt> and <tt>data</tt>.
 *
 * @param {string} opts.accessToken The access_token to send with requests. Can be
 * null to not send an access token.
 * @param {Object=} opts.extraParams Optional. Extra query parameters to send on
 * requests.
 * @param {Number=} opts.localTimeoutMs The default maximum amount of time to wait
 * before timing out the request. If not specified, there is no timeout.
 * @param {boolean} [opts.useAuthorizationHeader = false] Set to true to use
 * Authorization header instead of query param to send the access token to the server.
 */
module.exports.MatrixHttpApi = function MatrixHttpApi(event_emitter, opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request", "prefix"]);
    opts.onlyData = opts.onlyData || false;
    this.event_emitter = event_emitter;
    this.opts = opts;
    this.useAuthorizationHeader = Boolean(opts.useAuthorizationHeader);
    this.uploads = [];
};

module.exports.MatrixHttpApi.prototype = {

    /**
     * Get the content repository url with query parameters.
     * @return {Object} An object with a 'base', 'path' and 'params' for base URL,
     *          path and query parameters respectively.
     */
    getContentUri: function() {
        const params = {
            access_token: this.opts.accessToken,
        };
        return {
            base: this.opts.baseUrl,
            path: "/_matrix/media/v1/upload",
            params: params,
        };
    },

    /**
     * Upload content to the Home Server
     *
     * @param {object} file The object to upload. On a browser, something that
     *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
     *   a Buffer, String or ReadStream.
     *
     * @param {object} opts  options object
     *
     * @param {string=} opts.name   Name to give the file on the server. Defaults
     *   to <tt>file.name</tt>.
     *
     * @param {boolean=} opts.includeFilename if false will not send the filename,
     *   e.g for encrypted file uploads where filename leaks are undesirable.
     *   Defaults to true.
     *
     * @param {string=} opts.type   Content-type for the upload. Defaults to
     *   <tt>file.type</tt>, or <tt>applicaton/octet-stream</tt>.
     *
     * @param {boolean=} opts.rawResponse Return the raw body, rather than
     *   parsing the JSON. Defaults to false (except on node.js, where it
     *   defaults to true for backwards compatibility).
     *
     * @param {boolean=} opts.onlyContentUri Just return the content URI,
     *   rather than the whole body. Defaults to false (except on browsers,
     *   where it defaults to true for backwards compatibility). Ignored if
     *   opts.rawResponse is true.
     *
     * @param {Function=} opts.callback Deprecated. Optional. The callback to
     *    invoke on success/failure. See the promise return values for more
     *    information.
     *
     * @param {Function=} opts.progressHandler Optional. Called when a chunk of
     *    data has been uploaded, with an object containing the fields `loaded`
     *    (number of bytes transferred) and `total` (total size, if known).
     *
     * @return {module:client.Promise} Resolves to response object, as
     *    determined by this.opts.onlyData, opts.rawResponse, and
     *    opts.onlyContentUri.  Rejects with an error (usually a MatrixError).
     */
    uploadContent: function(file, opts) {
        if (utils.isFunction(opts)) {
            // opts used to be callback
            opts = {
                callback: opts,
            };
        } else if (opts === undefined) {
            opts = {};
        }

        // default opts.includeFilename to true (ignoring falsey values)
        const includeFilename = opts.includeFilename !== false;

        // if the file doesn't have a mime type, use a default since
        // the HS errors if we don't supply one.
        const contentType = opts.type || file.type || 'application/octet-stream';
        const fileName = opts.name || file.name;

        // we used to recommend setting file.stream to the thing to upload on
        // nodejs.
        const body = file.stream ? file.stream : file;

        // backwards-compatibility hacks where we used to do different things
        // between browser and node.
        let rawResponse = opts.rawResponse;
        if (rawResponse === undefined) {
            if (global.XMLHttpRequest) {
                rawResponse = false;
            } else {
                console.warn(
                    "Returning the raw JSON from uploadContent(). Future " +
                    "versions of the js-sdk will change this default, to " +
                    "return the parsed object. Set opts.rawResponse=false " +
                    "to change this behaviour now.",
                );
                rawResponse = true;
            }
        }

        let onlyContentUri = opts.onlyContentUri;
        if (!rawResponse && onlyContentUri === undefined) {
            if (global.XMLHttpRequest) {
                console.warn(
                    "Returning only the content-uri from uploadContent(). " +
                    "Future versions of the js-sdk will change this " +
                    "default, to return the whole response object. Set " +
                    "opts.onlyContentUri=false to change this behaviour now.",
                );
                onlyContentUri = true;
            } else {
                onlyContentUri = false;
            }
        }

        // browser-request doesn't support File objects because it deep-copies
        // the options using JSON.parse(JSON.stringify(options)). Instead of
        // loading the whole file into memory as a string and letting
        // browser-request base64 encode and then decode it again, we just
        // use XMLHttpRequest directly.
        // (browser-request doesn't support progress either, which is also kind
        // of important here)

        const upload = { loaded: 0, total: 0 };
        let promise;

        // XMLHttpRequest doesn't parse JSON for us. request normally does, but
        // we're setting opts.json=false so that it doesn't JSON-encode the
        // request, which also means it doesn't JSON-decode the response. Either
        // way, we have to JSON-parse the response ourselves.
        let bodyParser = null;
        if (!rawResponse) {
            bodyParser = function(rawBody) {
                let body = JSON.parse(rawBody);
                if (onlyContentUri) {
                    body = body.content_uri;
                    if (body === undefined) {
                        throw Error('Bad response');
                    }
                }
                return body;
            };
        }

        if (global.XMLHttpRequest) {
            const defer = Promise.defer();
            const xhr = new global.XMLHttpRequest();
            upload.xhr = xhr;
            const cb = requestCallback(defer, opts.callback, this.opts.onlyData);

            const timeout_fn = function() {
                xhr.abort();
                cb(new Error('Timeout'));
            };

            // set an initial timeout of 30s; we'll advance it each time we get
            // a progress notification
            xhr.timeout_timer = callbacks.setTimeout(timeout_fn, 30000);

            xhr.onreadystatechange = function() {
                switch (xhr.readyState) {
                    case global.XMLHttpRequest.DONE:
                        callbacks.clearTimeout(xhr.timeout_timer);
                        var resp;
                        try {
                            if (!xhr.responseText) {
                                throw new Error('No response body.');
                            }
                            resp = xhr.responseText;
                            if (bodyParser) {
                                resp = bodyParser(resp);
                            }
                        } catch (err) {
                            err.http_status = xhr.status;
                            cb(err);
                            return;
                        }
                        cb(undefined, xhr, resp);
                        break;
                }
            };
            xhr.upload.addEventListener("progress", function(ev) {
                callbacks.clearTimeout(xhr.timeout_timer);
                upload.loaded = ev.loaded;
                upload.total = ev.total;
                xhr.timeout_timer = callbacks.setTimeout(timeout_fn, 30000);
                if (opts.progressHandler) {
                    opts.progressHandler({
                        loaded: ev.loaded,
                        total: ev.total,
                    });
                }
            });
            let url = this.opts.baseUrl + "/_matrix/media/v1/upload";

            const queryArgs = [];

            if (includeFilename && fileName) {
                queryArgs.push("filename=" + encodeURIComponent(fileName));
            }

            if (!this.useAuthorizationHeader) {
                queryArgs.push("access_token="
                    + encodeURIComponent(this.opts.accessToken));
            }

            if (queryArgs.length > 0) {
                url += "?" + queryArgs.join("&");
            }

            xhr.open("POST", url);
            if (this.useAuthorizationHeader) {
                xhr.setRequestHeader("Authorization", "Bearer " + this.opts.accessToken);
            }
            xhr.setRequestHeader("Content-Type", contentType);
            xhr.send(body);
            promise = defer.promise;

            // dirty hack (as per _request) to allow the upload to be cancelled.
            promise.abort = xhr.abort.bind(xhr);
        } else {
            const queryParams = {};

            if (includeFilename && fileName) {
                queryParams.filename = fileName;
            }

            promise = this.authedRequest(
                opts.callback, "POST", "/upload", queryParams, body, {
                    prefix: "/_matrix/media/v1",
                    headers: {"Content-Type": contentType},
                    json: false,
                    bodyParser: bodyParser,
                },
            );
        }

        const self = this;

        // remove the upload from the list on completion
        const promise0 = promise.finally(function() {
            for (let i = 0; i < self.uploads.length; ++i) {
                if (self.uploads[i] === upload) {
                    self.uploads.splice(i, 1);
                    return;
                }
            }
        });

        // copy our dirty abort() method to the new promise
        promise0.abort = promise.abort;

        upload.promise = promise0;
        this.uploads.push(upload);

        return promise0;
    },

    cancelUpload: function(promise) {
        if (promise.abort) {
            promise.abort();
            return true;
        }
        return false;
    },

    getCurrentUploads: function() {
        return this.uploads;
    },

    idServerRequest: function(callback, method, path, params, prefix) {
        const fullUri = this.opts.idBaseUrl + prefix + path;

        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback,
            );
        }

        const opts = {
            uri: fullUri,
            method: method,
            withCredentials: false,
            json: false,
            _matrix_opts: this.opts,
        };
        if (method == 'GET') {
            opts.qs = params;
        } else {
            opts.form = params;
        }

        const defer = Promise.defer();
        this.opts.request(
            opts,
            requestCallback(defer, callback, this.opts.onlyData),
        );
        // ID server does not always take JSON, so we can't use requests' 'json'
        // option as we do with the home server, but it does return JSON, so
        // parse it manually
        return defer.promise.then(function(response) {
            return JSON.parse(response);
        });
    },

    /**
     * Perform an authorised request to the homeserver.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} data The HTTP JSON body.
     *
     * @param {Object|Number=} opts additional options. If a number is specified,
     * this is treated as `opts.localTimeoutMs`.
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    authedRequest: function(callback, method, path, queryParams, data, opts) {
        if (!queryParams) {
            queryParams = {};
        }
        if (this.useAuthorizationHeader) {
            if (isFinite(opts)) {
                // opts used to be localTimeoutMs
                opts = {
                    localTimeoutMs: opts,
                };
            }
            if (!opts) {
                opts = {};
            }
            if (!opts.headers) {
                opts.headers = {};
            }
            if (!opts.headers.Authorization) {
                opts.headers.Authorization = "Bearer " + this.opts.accessToken;
            }
            if (queryParams.access_token) {
                delete queryParams.access_token;
            }
        } else {
            if (!queryParams.access_token) {
                queryParams.access_token = this.opts.accessToken;
            }
        }

        const requestPromise = this.request(
            callback, method, path, queryParams, data, opts,
        );

        const self = this;
        requestPromise.catch(function(err) {
            if (err.errcode == 'M_UNKNOWN_TOKEN') {
                self.event_emitter.emit("Session.logged_out");
            } else if (err.errcode == 'M_CONSENT_NOT_GIVEN') {
                self.event_emitter.emit(
                    "no_consent",
                    err.message,
                    err.data.consent_uri,
                );
            }
        });

        // return the original promise, otherwise tests break due to it having to
        // go around the event loop one more time to process the result of the request
        return requestPromise;
    },

    /**
     * Perform a request to the homeserver without any credentials.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} data The HTTP JSON body.
     *
     * @param {Object=} opts additional options
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    request: function(callback, method, path, queryParams, data, opts) {
        opts = opts || {};
        const prefix = opts.prefix !== undefined ? opts.prefix : this.opts.prefix;
        const fullUri = this.opts.baseUrl + prefix + path;

        return this.requestOtherUrl(
            callback, method, fullUri, queryParams, data, opts,
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
     * @param {Number=} localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     *
     * @deprecated prefer authedRequest with opts.prefix
     */
    authedRequestWithPrefix: function(callback, method, path, queryParams, data,
                                      prefix, localTimeoutMs) {
        return this.authedRequest(
            callback, method, path, queryParams, data, {
                localTimeoutMs: localTimeoutMs,
                prefix: prefix,
            },
        );
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
     * @param {Number=} localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     *
     * @deprecated prefer request with opts.prefix
     */
    requestWithPrefix: function(callback, method, path, queryParams, data, prefix,
                                localTimeoutMs) {
        return this.request(
            callback, method, path, queryParams, data, {
                localTimeoutMs: localTimeoutMs,
                prefix: prefix,
            },
        );
    },

    /**
     * Perform a request to an arbitrary URL.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} uri The HTTP URI
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} data The HTTP JSON body.
     *
     * @param {Object=} opts additional options
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {module:client.Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    requestOtherUrl: function(callback, method, uri, queryParams, data,
                              opts) {
        if (opts === undefined || opts === null) {
            opts = {};
        } else if (isFinite(opts)) {
            // opts used to be localTimeoutMs
            opts = {
                localTimeoutMs: opts,
            };
        }

        return this._request(
            callback, method, uri, queryParams, data, opts,
        );
    },

    /**
     * Form and return a homeserver request URL based on the given path
     * params and prefix.
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {string} prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha".
     * @return {string} URL
     */
    getUrl: function(path, queryParams, prefix) {
        let queryString = "";
        if (queryParams) {
            queryString = "?" + utils.encodeParams(queryParams);
        }
        return this.opts.baseUrl + prefix + path + queryString;
    },

    /**
     * @private
     *
     * @param {function} callback
     * @param {string} method
     * @param {string} uri
     * @param {object} queryParams
     * @param {object|string} data
     * @param {object=} opts
     *
     * @param {boolean} [opts.json =true] Json-encode data before sending, and
     *   decode response on receipt. (We will still json-decode error
     *   responses, even if this is false.)
     *
     * @param {object=} opts.headers  extra request headers
     *
     * @param {number=} opts.localTimeoutMs client-side timeout for the
     *    request. Default timeout if falsy.
     *
     * @param {function=} opts.bodyParser function to parse the body of the
     *    response before passing it to the promise and callback.
     *
     * @return {module:client.Promise} a promise which resolves to either the
     * response object (if this.opts.onlyData is truthy), or the parsed
     * body. Rejects
     */
    _request: function(callback, method, uri, queryParams, data, opts) {
        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback,
            );
        }
        opts = opts || {};

        const self = this;
        if (this.opts.extraParams) {
            for (const key in this.opts.extraParams) {
                if (!this.opts.extraParams.hasOwnProperty(key)) {
                    continue;
                }
                queryParams[key] = this.opts.extraParams[key];
            }
        }

        const headers = utils.extend({}, opts.headers || {});
        const json = opts.json === undefined ? true : opts.json;
        let bodyParser = opts.bodyParser;

        // we handle the json encoding/decoding here, because request and
        // browser-request make a mess of it. Specifically, they attempt to
        // json-decode plain-text error responses, which in turn means that the
        // actual error gets swallowed by a SyntaxError.

        if (json) {
            if (data) {
                data = JSON.stringify(data);
                headers['content-type'] = 'application/json';
            }

            if (!headers['accept']) {
                headers['accept'] = 'application/json';
            }

            if (bodyParser === undefined) {
                bodyParser = function(rawBody) {
                    return JSON.parse(rawBody);
                };
            }
        }

        const defer = Promise.defer();

        let timeoutId;
        let timedOut = false;
        let req;
        const localTimeoutMs = opts.localTimeoutMs || this.opts.localTimeoutMs;

        const resetTimeout = () => {
            if (localTimeoutMs) {
                if (timeoutId) {
                    callbacks.clearTimeout(timeoutId);
                }
                timeoutId = callbacks.setTimeout(function() {
                    timedOut = true;
                    if (req && req.abort) {
                        req.abort();
                    }
                    defer.reject(new module.exports.MatrixError({
                        error: "Locally timed out waiting for a response",
                        errcode: "ORG.MATRIX.JSSDK_TIMEOUT",
                        timeout: localTimeoutMs,
                    }));
                }, localTimeoutMs);
            }
        };
        resetTimeout();

        const reqPromise = defer.promise;

        try {
            req = this.opts.request(
                {
                    uri: uri,
                    method: method,
                    withCredentials: false,
                    qs: queryParams,
                    qsStringifyOptions: opts.qsStringifyOptions,
                    useQuerystring: true,
                    body: data,
                    json: false,
                    timeout: localTimeoutMs,
                    headers: headers || {},
                    _matrix_opts: this.opts,
                },
                function(err, response, body) {
                    if (localTimeoutMs) {
                        callbacks.clearTimeout(timeoutId);
                        if (timedOut) {
                            return; // already rejected promise
                        }
                    }

                    const handlerFn = requestCallback(
                        defer, callback, self.opts.onlyData,
                        bodyParser,
                    );
                    handlerFn(err, response, body);
                },
            );
            if (req) {
                // This will only work in a browser, where opts.request is the
                // `browser-request` import. Currently `request` does not support progress
                // updates - see https://github.com/request/request/pull/2346.
                // `browser-request` returns an XHRHttpRequest which exposes `onprogress`
                if ('onprogress' in req) {
                    req.onprogress = (e) => {
                        // Prevent the timeout from rejecting the deferred promise if progress is
                        // seen with the request
                        resetTimeout();
                    };
                }

                // FIXME: This is EVIL, but I can't think of a better way to expose
                // abort() operations on underlying HTTP requests :(
                if (req.abort) reqPromise.abort = req.abort.bind(req);
            }
        } catch (ex) {
            defer.reject(ex);
            if (callback) {
                callback(ex);
            }
        }
        return reqPromise;
    },
};

/*
 * Returns a callback that can be invoked by an HTTP request on completion,
 * that will either resolve or reject the given defer as well as invoke the
 * given userDefinedCallback (if any).
 *
 * HTTP errors are transformed into javascript errors and the deferred is rejected.
 *
 * If bodyParser is given, it is used to transform the body of the successful
 * responses before passing to the defer/callback.
 *
 * If onlyData is true, the defer/callback is invoked with the body of the
 * response, otherwise the result object (with `code` and `data` fields)
 *
 */
const requestCallback = function(
    defer, userDefinedCallback, onlyData,
    bodyParser,
) {
    userDefinedCallback = userDefinedCallback || function() {};

    return function(err, response, body) {
        if (!err) {
            try {
                if (response.statusCode >= 400) {
                    err = parseErrorResponse(response, body);
                } else if (bodyParser) {
                    body = bodyParser(body);
                }
            } catch (e) {
                err = new Error(`Error parsing server response: ${e}`);
            }
        }

        if (err) {
            defer.reject(err);
            userDefinedCallback(err);
        } else {
            const res = {
                code: response.statusCode,

                // XXX: why do we bother with this? it doesn't work for
                // XMLHttpRequest, so clearly we don't use it.
                headers: response.headers,
                data: body,
            };
            defer.resolve(onlyData ? body : res);
            userDefinedCallback(null, onlyData ? body : res);
        }
    };
};

/**
 * Attempt to turn an HTTP error response into a Javascript Error.
 *
 * If it is a JSON response, we will parse it into a MatrixError. Otherwise
 * we return a generic Error.
 *
 * @param {XMLHttpRequest|http.IncomingMessage} response response object
 * @param {String} body raw body of the response
 * @returns {Error}
 */
function parseErrorResponse(response, body) {
    const httpStatus = response.statusCode;
    const contentType = getResponseContentType(response);

    let err;
    if (contentType) {
        if (contentType.type === 'application/json') {
            err = new module.exports.MatrixError(JSON.parse(body));
        } else if (contentType.type === 'text/plain') {
            err = new Error(`Server returned ${httpStatus} error: ${body}`);
        }
    }

    if (!err) {
        err = new Error(`Server returned ${httpStatus} error`);
    }
    err.httpStatus = httpStatus;
    return err;
}


/**
 * extract the Content-Type header from the response object, and
 * parse it to a `{type, parameters}` object.
 *
 * returns null if no content-type header could be found.
 *
 * @param {XMLHttpRequest|http.IncomingMessage} response response object
 * @returns {{type: String, parameters: Object}?} parsed content-type header, or null if not found
 */
function getResponseContentType(response) {
    let contentType;
    if (response.getResponseHeader) {
        // XMLHttpRequest provides getResponseHeader
        contentType = response.getResponseHeader("Content-Type");
    } else if (response.headers) {
        // request provides http.IncomingMessage which has a message.headers map
        contentType = response.headers['content-type'] || null;
    }

    if (!contentType) {
        return null;
    }

    try {
        return parseContentType(contentType);
    } catch(e) {
        throw new Error(`Error parsing Content-Type '${contentType}': ${e}`);
    }
}

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
    errorJson = errorJson || {};
    this.errcode = errorJson.errcode;
    this.name = errorJson.errcode || "Unknown error code";
    this.message = errorJson.error || "Unknown message";
    this.data = errorJson;
};
module.exports.MatrixError.prototype = Object.create(Error.prototype);
/** */
module.exports.MatrixError.prototype.constructor = module.exports.MatrixError;
