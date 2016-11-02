/*
Copyright 2016 OpenMarket Ltd

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

/** @module interactive-auth */
var q = require("q");

var utils = require("./utils");

/**
 * Abstracts the logic used to drive the interactive auth process.
 *
 * <p>Components implementing an interactive auth flow should instantiate one of
 * these, passing in the necessary callbacks to the constructor. They should
 * then call attemptAuth, which will return a promise which will resolve or
 * reject when the interactive-auth process completes.
 *
 * <p>Meanwhile, calls will be made to the startAuthStage and doRequest
 * callbacks, and information gathered from the user can be submitted with
 * submitAuthDict.
 *
 * @constructor
 * @alias module:interactive-auth
 *
 * @param {object} opts  options object
 *
 * @param {object?} opts.authData error response from the last request. If
 *    null, a request will be made with no auth before starting.
 *
 * @param {function(object?): module:client.Promise} opts.doRequest
 *     called with the new auth dict to submit the request. Should return a
 *     promise which resolves to the successful response or rejects with a
 *     MatrixError.
 *
 * @param {function(string, object?)} opts.startAuthStage
 *     called to ask the UI to start a particular auth stage. The arguments
 *     are: the login type (eg m.login.password); and (if the last request
 *     returned an error), an error object, with fields 'errcode' and 'error'.
 *
 */
function InteractiveAuth(opts) {
    this._data = opts.authData;
    this._requestCallback = opts.doRequest;
    this._startAuthStageCallback = opts.startAuthStage;
    this._completionDeferred = null;
}

InteractiveAuth.prototype = {
    /**
     * begin the authentication process.
     *
     * @return {module:client.Promise}  which resolves to the response on success,
     * or rejects with the error on failure.
     */
    attemptAuth: function() {
        this._completionDeferred = q.defer();

        if (!this._data) {
            this._doRequest(null);
        } else {
            this._startNextAuthStage();
        }

        return this._completionDeferred.promise;
    },

    /**
     * get the auth session ID
     *
     * @return {string} session id
     */
    getSessionId: function() {
        return this._data ? this._data.session : undefined;
    },

    /**
     * get the server params for a given stage
     *
     * @param {string}  login type for the stage
     * @return {object?}  any parameters from the server for this stage
     */
    getStageParams: function(loginType) {
        var params = {};
        if (this._data && this._data.params) {
            params = this._data.params;
        }
        return params[loginType];
    },

    /**
     * submit a new auth dict and fire off the request. This will either
     * make attemptAuth resolve/reject, or cause the startAuthStage callback
     * to be called for a new stage.
     *
     * @param {object} authData new auth dict to send to the server. Should
     *    include a `type` propterty denoting the login type, as well as any
     *    other params for that stage.
     */
    submitAuthDict: function(authData) {
        if (!this._completionDeferred) {
            throw new Error("submitAuthDict() called before attemptAuth()");
        }

        // use the sessionid from the last request.
        var auth = {
            session: this._data.session,
        };
        utils.extend(auth, authData);

        this._doRequest(auth);
    },

    /**
     * Fire off a request, and either resolve the promise, or call
     * startAuthStage.
     *
     * @private
     * @param {object?} auth new auth dict, including session id
     */
    _doRequest: function(auth) {
        var self = this;

        // hackery to make sure that synchronous exceptions end up in the catch
        // handler (without the additional event loop entailed by q.fcall or an
        // extra q().then)
        var prom;
        try {
            prom = this._requestCallback(auth);
        } catch (e) {
            prom = q.reject(e);
        }

        prom.then(
            function(result) {
                console.log("result from request: ", result);
                self._completionDeferred.resolve(result);
            }, function(error) {
                if (error.httpStatus !== 401 || !error.data || !error.data.flows) {
                    // doesn't look like an interactive-auth failure. fail the whole lot.
                    throw error;
                }
                self._data = error.data;
                self._startNextAuthStage();
            }
        ).catch(this._completionDeferred.reject).done();
    },

    /**
     * Pick the next stage and call the callback
     *
     * @private
     */
    _startNextAuthStage: function() {
        var nextStage = this._chooseStage();
        if (!nextStage) {
            throw new Error("No incomplete flows from the server");
        }

        var stageError = null;
        if (this._data.errcode || this._data.error) {
            stageError = {
                errcode: this._data.errcode || "",
                error: this._data.error || "",
            };
        }
        this._startAuthStageCallback(nextStage, stageError);
    },

    /**
     * Pick the next auth stage
     *
     * @private
     * @return {string?} login type
     */
    _chooseStage: function() {
        var flow = this._chooseFlow();
        console.log("Active flow => %s", JSON.stringify(flow));
        var nextStage = this._firstUncompletedStage(flow);
        console.log("Next stage: %s", nextStage);
        return nextStage;
    },

    /**
     * Pick one of the flows from the returned list
     *
     * @private
     * @return {object} flow
     */
    _chooseFlow: function() {
        var flows = this._data.flows || [];
        // always use the first flow for now
        return flows[0];
    },

    /**
     * Get the first uncompleted stage in the given flow
     *
     * @private
     * @param {object} flow
     * @return {string} login type
     */
    _firstUncompletedStage: function(flow) {
        var completed = (this._data || {}).completed || [];
        for (var i = 0; i < flow.stages.length; ++i) {
            var stageType = flow.stages[i];
            if (completed.indexOf(stageType) === -1) {
                return stageType;
            }
        }
    },
};


/** */
module.exports = InteractiveAuth;
