/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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
import Promise from 'bluebird';
const url = require("url");

const utils = require("./utils");

const EMAIL_STAGE_TYPE = "m.login.email.identity";
const MSISDN_STAGE_TYPE = "m.login.msisdn";

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
 * @param {object} opts.matrixClient A matrix client to use for the auth process
 *
 * @param {object?} opts.authData error response from the last request. If
 *    null, a request will be made with no auth before starting.
 *
 * @param {function(object?, bool?): module:client.Promise} opts.doRequest
 *     called with the new auth dict to submit the request and a flag set
 *     to true if this request is a background request. Should return a
 *     promise which resolves to the successful response or rejects with a
 *     MatrixError.
 *
 * @param {function(string, object?)} opts.stateUpdated
 *     called when the status of the UI auth changes, ie. when the state of
 *     an auth stage changes of when the auth flow moves to a new stage.
 *     The arguments are: the login type (eg m.login.password); and an object
 *     which is either an error or an informational object specific to the
 *     login type. If the 'errcode' key is defined, the object is an error,
 *     and has keys:
 *         errcode: string, the textual error code, eg. M_UNKNOWN
 *         error: string, human readable string describing the error
 *
 *     The login type specific objects are as follows:
 *         m.login.email.identity:
 *          * emailSid: string, the sid of the active email auth session
 *
 * @param {object?} opts.inputs Inputs provided by the user and used by different
 *     stages of the auto process. The inputs provided will affect what flow is chosen.
 *
 * @param {string?} opts.inputs.emailAddress An email address. If supplied, a flow
 *     using email verification will be chosen.
 *
 * @param {string?} opts.inputs.phoneCountry An ISO two letter country code. Gives
 *     the country that opts.phoneNumber should be resolved relative to.
 *
 * @param {string?} opts.inputs.phoneNumber A phone number. If supplied, a flow
 *     using phone number validation will be chosen.
 *
 * @param {string?} opts.sessionId If resuming an existing interactive auth session,
 *     the sessionId of that session.
 *
 * @param {string?} opts.clientSecret If resuming an existing interactive auth session,
 *     the client secret for that session
 *
 * @param {string?} opts.emailSid If returning from having completed m.login.email.identity
 *     auth, the sid for the email verification session.
 *
 */
function InteractiveAuth(opts) {
    this._matrixClient = opts.matrixClient;
    this._data = opts.authData || {};
    this._requestCallback = opts.doRequest;
    // startAuthStage included for backwards compat
    this._stateUpdatedCallback = opts.stateUpdated || opts.startAuthStage;
    this._completionDeferred = null;
    this._inputs = opts.inputs || {};

    if (opts.sessionId) this._data.session = opts.sessionId;
    this._clientSecret = opts.clientSecret || this._matrixClient.generateClientSecret();
    this._emailSid = opts.emailSid;
    if (this._emailSid === undefined) this._emailSid = null;

    this._currentStage = null;
}

InteractiveAuth.prototype = {
    /**
     * begin the authentication process.
     *
     * @return {module:client.Promise} which resolves to the response on success,
     * or rejects with the error on failure. Rejects with NoAuthFlowFoundError if
     *     no suitable authentication flow can be found
     */
    attemptAuth: function() {
        this._completionDeferred = Promise.defer();

        // wrap in a promise so that if _startNextAuthStage
        // throws, it rejects the promise in a consistent way
        return Promise.resolve().then(() => {
            // if we have no flows, try a request (we'll have
            // just a session ID in _data if resuming)
            if (!this._data.flows) {
                this._doRequest(this._data);
            } else {
                this._startNextAuthStage();
            }
            return this._completionDeferred.promise;
        });
    },

    /**
     * Poll to check if the auth session or current stage has been
     * completed out-of-band. If so, the attemptAuth promise will
     * be resolved.
     */
    poll: function() {
        if (!this._data.session) return;

        let authDict = {};
        if (this._currentStage == EMAIL_STAGE_TYPE) {
            // The email can be validated out-of-band, but we need to provide the
            // creds so the HS can go & check it.
            if (this._emailSid) {
                const idServerParsedUrl = url.parse(
                    this._matrixClient.getIdentityServerUrl(),
                );
                authDict = {
                    type: EMAIL_STAGE_TYPE,
                    threepid_creds: {
                        sid: this._emailSid,
                        client_secret: this._clientSecret,
                        id_server: idServerParsedUrl.host,
                    },
                };
            }
        }

        this.submitAuthDict(authDict, true);
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
     * get the client secret used for validation sessions
     * with the ID server.
     *
     * @return {string} client secret
     */
    getClientSecret: function() {
        return this._clientSecret;
    },

    /**
     * get the server params for a given stage
     *
     * @param {string} loginType login type for the stage
     * @return {object?} any parameters from the server for this stage
     */
    getStageParams: function(loginType) {
        let params = {};
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
     * @param {bool} background If true, this request failing will not result
     *    in the attemptAuth promise being rejected. This can be set to true
     *    for requests that just poll to see if auth has been completed elsewhere.
     */
    submitAuthDict: function(authData, background) {
        if (!this._completionDeferred) {
            throw new Error("submitAuthDict() called before attemptAuth()");
        }

        // use the sessionid from the last request.
        const auth = {
            session: this._data.session,
        };
        utils.extend(auth, authData);

        this._doRequest(auth, background);
    },

    /**
     * Gets the sid for the email validation session
     * Specific to m.login.email.identity
     *
     * @returns {string} The sid of the email auth session
     */
    getEmailSid: function() {
        return this._emailSid;
    },

    /**
     * Sets the sid for the email validation session
     * This must be set in order to successfully poll for completion
     * of the email validation.
     * Specific to m.login.email.identity
     *
     * @param {string} sid The sid for the email validation session
     */
    setEmailSid: function(sid) {
        this._emailSid = sid;
    },

    /**
     * Fire off a request, and either resolve the promise, or call
     * startAuthStage.
     *
     * @private
     * @param {object?} auth new auth dict, including session id
     * @param {bool?} background If true, this request is a background poll, so it
     *    failing will not result in the attemptAuth promise being rejected.
     *    This can be set to true for requests that just poll to see if auth has
     *    been completed elsewhere.
     */
    _doRequest: function(auth, background) {
        const self = this;

        // hackery to make sure that synchronous exceptions end up in the catch
        // handler (without the additional event loop entailed by q.fcall or an
        // extra Promise.resolve().then)
        let prom;
        try {
            prom = this._requestCallback(auth, background);
        } catch (e) {
            prom = Promise.reject(e);
        }

        prom = prom.then(
            function(result) {
                console.log("result from request: ", result);
                self._completionDeferred.resolve(result);
            }, function(error) {
                // sometimes UI auth errors don't come with flows
                const errorFlows = error.data ? error.data.flows : null;
                const haveFlows = Boolean(self._data.flows) || Boolean(errorFlows);
                if (error.httpStatus !== 401 || !error.data || !haveFlows) {
                    // doesn't look like an interactive-auth failure. fail the whole lot.
                    throw error;
                }
                // if the error didn't come with flows, completed flows or session ID,
                // copy over the ones we have. Synapse sometimes sends responses without
                // any UI auth data (eg. when polling for email validation, if the email
                // has not yet been validated). This appears to be a Synapse bug, which
                // we workaround here.
                if (!error.data.flows && !error.data.completed && !error.data.session) {
                    error.data.flows = self._data.flows;
                    error.data.completed = self._data.completed;
                    error.data.session = self._data.session;
                }
                self._data = error.data;
                self._startNextAuthStage();
            },
        );
        if (!background) {
            prom = prom.catch((e) => {
                this._completionDeferred.reject(e);
            });
        } else {
            // We ignore all failures here (even non-UI auth related ones)
            // since we don't want to suddenly fail if the internet connection
            // had a blip whilst we were polling
            prom = prom.catch((error) => {
                console.log("Ignoring error from UI auth: " + error);
            });
        }
        prom.done();
    },

    /**
     * Pick the next stage and call the callback
     *
     * @private
     * @throws {NoAuthFlowFoundError} If no suitable authentication flow can be found
     */
    _startNextAuthStage: function() {
        const nextStage = this._chooseStage();
        if (!nextStage) {
            throw new Error("No incomplete flows from the server");
        }
        this._currentStage = nextStage;

        if (nextStage == 'm.login.dummy') {
            this.submitAuthDict({
                type: 'm.login.dummy',
            });
            return;
        }

        if (this._data.errcode || this._data.error) {
            this._stateUpdatedCallback(nextStage, {
                errcode: this._data.errcode || "",
                error: this._data.error || "",
            });
            return;
        }

        const stageStatus = {};
        if (nextStage == EMAIL_STAGE_TYPE) {
            stageStatus.emailSid = this._emailSid;
        }
        this._stateUpdatedCallback(nextStage, stageStatus);
    },

    /**
     * Pick the next auth stage
     *
     * @private
     * @return {string?} login type
     * @throws {NoAuthFlowFoundError} If no suitable authentication flow can be found
     */
    _chooseStage: function() {
        const flow = this._chooseFlow();
        console.log("Active flow => %s", JSON.stringify(flow));
        const nextStage = this._firstUncompletedStage(flow);
        console.log("Next stage: %s", nextStage);
        return nextStage;
    },

    /**
     * Pick one of the flows from the returned list
     * If a flow using all of the inputs is found, it will
     * be returned, otherwise, null will be returned.
     *
     * Only flows using all given inputs are chosen because it
     * is likley to be surprising if the user provides a
     * credential and it is not used. For example, for registration,
     * this could result in the email not being used which would leave
     * the account with no means to reset a password.
     *
     * @private
     * @return {object} flow
     * @throws {NoAuthFlowFoundError} If no suitable authentication flow can be found
     */
    _chooseFlow: function() {
        const flows = this._data.flows || [];

        // we've been given an email or we've already done an email part
        const haveEmail = Boolean(this._inputs.emailAddress) || Boolean(this._emailSid);
        const haveMsisdn = (
            Boolean(this._inputs.phoneCountry) &&
            Boolean(this._inputs.phoneNumber)
        );

        for (const flow of flows) {
            let flowHasEmail = false;
            let flowHasMsisdn = false;
            for (const stage of flow.stages) {
                if (stage === EMAIL_STAGE_TYPE) {
                    flowHasEmail = true;
                } else if (stage == MSISDN_STAGE_TYPE) {
                    flowHasMsisdn = true;
                }
            }

            if (flowHasEmail == haveEmail && flowHasMsisdn == haveMsisdn) {
                return flow;
            }
        }
        // Throw an error with a fairly generic description, but with more
        // information such that the app can give a better one if so desired.
        const err = new Error("No appropriate authentication flow found");
        err.name = 'NoAuthFlowFoundError';
        err.required_stages = [];
        if (haveEmail) err.required_stages.push(EMAIL_STAGE_TYPE);
        if (haveMsisdn) err.required_stages.push(MSISDN_STAGE_TYPE);
        err.available_flows = flows;
        throw err;
    },

    /**
     * Get the first uncompleted stage in the given flow
     *
     * @private
     * @param {object} flow
     * @return {string} login type
     */
    _firstUncompletedStage: function(flow) {
        const completed = (this._data || {}).completed || [];
        for (let i = 0; i < flow.stages.length; ++i) {
            const stageType = flow.stages[i];
            if (completed.indexOf(stageType) === -1) {
                return stageType;
            }
        }
    },
};


/** */
module.exports = InteractiveAuth;
