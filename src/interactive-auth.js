/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/** @module interactive-auth */

import url from "url";
import * as utils from "./utils";
import {logger} from './logger';

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
 * @param {function(object?): Promise} opts.doRequest
 *     called with the new auth dict to submit the request. Also passes a
 *     second deprecated arg which is a flag set to true if this request
 *     is a background request. The busyChanged callback should be used
 *     instead of the backfround flag. Should return a promise which resolves
 *     to the successful response or rejects with a MatrixError.
 *
 * @param {function(bool): Promise} opts.busyChanged
 *     called whenever the interactive auth logic becomes busy submitting
 *     information provided by the user or finsihes. After this has been
 *     called with true the UI should indicate that a request is in progress
 *     until it is called again with false.
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
 * @param {function?} opts.requestEmailToken A function that takes the email address (string),
 *     clientSecret (string), attempt number (int) and sessionId (string) and calls the
 *     relevant requestToken function and returns the promise returned by that function.
 *     If the resulting promise rejects, the rejection will propagate through to the
 *     attemptAuth promise.
 *
 */
export function InteractiveAuth(opts) {
    this._matrixClient = opts.matrixClient;
    this._data = opts.authData || {};
    this._requestCallback = opts.doRequest;
    this._busyChangedCallback = opts.busyChanged;
    // startAuthStage included for backwards compat
    this._stateUpdatedCallback = opts.stateUpdated || opts.startAuthStage;
    this._resolveFunc = null;
    this._rejectFunc = null;
    this._inputs = opts.inputs || {};
    this._requestEmailTokenCallback = opts.requestEmailToken;

    if (opts.sessionId) this._data.session = opts.sessionId;
    this._clientSecret = opts.clientSecret || this._matrixClient.generateClientSecret();
    this._emailSid = opts.emailSid;
    if (this._emailSid === undefined) this._emailSid = null;
    this._requestingEmailToken = false;

    this._chosenFlow = null;
    this._currentStage = null;

    // if we are currently trying to submit an auth dict (which includes polling)
    // the promise the will resolve/reject when it completes
    this._submitPromise = null;
}

InteractiveAuth.prototype = {
    /**
     * begin the authentication process.
     *
     * @return {Promise} which resolves to the response on success,
     * or rejects with the error on failure. Rejects with NoAuthFlowFoundError if
     *     no suitable authentication flow can be found
     */
    attemptAuth: function() {
        // This promise will be quite long-lived and will resolve when the
        // request is authenticated and completes successfully.
        return new Promise((resolve, reject) => {
            this._resolveFunc = resolve;
            this._rejectFunc = reject;

            const hasFlows = this._data && this._data.flows;

            // if we have no flows, try a request to acquire the flows
            if (!hasFlows) {
                if (this._busyChangedCallback) this._busyChangedCallback(true);
                // use the existing sessionid, if one is present.
                let auth = null;
                if (this._data.session) {
                    auth = {
                        session: this._data.session,
                    };
                }
                this._doRequest(auth).finally(() => {
                    if (this._busyChangedCallback) this._busyChangedCallback(false);
                });
            } else {
                this._startNextAuthStage();
            }
        });
    },

    /**
     * Poll to check if the auth session or current stage has been
     * completed out-of-band. If so, the attemptAuth promise will
     * be resolved.
     */
    poll: async function() {
        if (!this._data.session) return;
        // likewise don't poll if there is no auth session in progress
        if (!this._resolveFunc) return;
        // if we currently have a request in flight, there's no point making
        // another just to check what the status is
        if (this._submitPromise) return;

        let authDict = {};
        if (this._currentStage == EMAIL_STAGE_TYPE) {
            // The email can be validated out-of-band, but we need to provide the
            // creds so the HS can go & check it.
            if (this._emailSid) {
                const creds = {
                    sid: this._emailSid,
                    client_secret: this._clientSecret,
                };
                if (await this._matrixClient.doesServerRequireIdServerParam()) {
                    const idServerParsedUrl = url.parse(
                        this._matrixClient.getIdentityServerUrl(),
                    );
                    creds.id_server = idServerParsedUrl.host;
                }
                authDict = {
                    type: EMAIL_STAGE_TYPE,
                    // TODO: Remove `threepid_creds` once servers support proper UIA
                    // See https://github.com/matrix-org/synapse/issues/5665
                    // See https://github.com/matrix-org/matrix-doc/issues/2220
                    threepid_creds: creds,
                    threepidCreds: creds,
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

    getChosenFlow() {
        return this._chosenFlow;
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
    submitAuthDict: async function(authData, background) {
        if (!this._resolveFunc) {
            throw new Error("submitAuthDict() called before attemptAuth()");
        }

        if (!background && this._busyChangedCallback) {
            this._busyChangedCallback(true);
        }

        // if we're currently trying a request, wait for it to finish
        // as otherwise we can get multiple 200 responses which can mean
        // things like multiple logins for register requests.
        // (but discard any expections as we only care when its done,
        // not whether it worked or not)
        while (this._submitPromise) {
            try {
                await this._submitPromise;
            } catch (e) {
            }
        }

        // use the sessionid from the last request, if one is present.
        let auth;
        if (this._data.session) {
            auth = {
                session: this._data.session,
            };
            utils.extend(auth, authData);
        } else {
            auth = authData;
        }

        try {
            // NB. the 'background' flag is deprecated by the busyChanged
            // callback and is here for backwards compat
            this._submitPromise = this._doRequest(auth, background);
            await this._submitPromise;
        } finally {
            this._submitPromise = null;
            if (!background && this._busyChangedCallback) {
                this._busyChangedCallback(false);
            }
        }
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
    _doRequest: async function(auth, background) {
        try {
            const result = await this._requestCallback(auth, background);
            this._resolveFunc(result);
            this._resolveFunc = null;
            this._rejectFunc = null;
        } catch (error) {
            // sometimes UI auth errors don't come with flows
            const errorFlows = error.data ? error.data.flows : null;
            const haveFlows = this._data.flows || Boolean(errorFlows);
            if (error.httpStatus !== 401 || !error.data || !haveFlows) {
                // doesn't look like an interactive-auth failure.
                if (!background) {
                    this._rejectFunc(error);
                } else {
                    // We ignore all failures here (even non-UI auth related ones)
                    // since we don't want to suddenly fail if the internet connection
                    // had a blip whilst we were polling
                    logger.log(
                        "Background poll request failed doing UI auth: ignoring",
                        error,
                    );
                }
            }
            // if the error didn't come with flows, completed flows or session ID,
            // copy over the ones we have. Synapse sometimes sends responses without
            // any UI auth data (eg. when polling for email validation, if the email
            // has not yet been validated). This appears to be a Synapse bug, which
            // we workaround here.
            if (!error.data.flows && !error.data.completed && !error.data.session) {
                error.data.flows = this._data.flows;
                error.data.completed = this._data.completed;
                error.data.session = this._data.session;
            }
            this._data = error.data;
            try {
                this._startNextAuthStage();
            } catch (e) {
                this._rejectFunc(e);
                this._resolveFunc = null;
                this._rejectFunc = null;
            }

            if (
                !this._emailSid &&
                !this._requestingEmailToken &&
                this._chosenFlow.stages.includes('m.login.email.identity')
            ) {
                // If we've picked a flow with email auth, we send the email
                // now because we want the request to fail as soon as possible
                // if the email address is not valid (ie. already taken or not
                // registered, depending on what the operation is).
                this._requestingEmailToken = true;
                try {
                    const requestTokenResult = await this._requestEmailTokenCallback(
                        this._inputs.emailAddress,
                        this._clientSecret,
                        1, // TODO: Multiple send attempts?
                        this._data.session,
                    );
                    this._emailSid = requestTokenResult.sid;
                    // NB. promise is not resolved here - at some point, doRequest
                    // will be called again and if the user has jumped through all
                    // the hoops correctly, auth will be complete and the request
                    // will succeed.
                    // Also, we should expose the fact that this request has compledted
                    // so clients can know that the email has actually been sent.
                } catch (e) {
                    // we failed to request an email token, so fail the request.
                    // This could be due to the email already beeing registered
                    // (or not being registered, depending on what we're trying
                    // to do) or it could be a network failure. Either way, pass
                    // the failure up as the user can't complete auth if we can't
                    // send the email, for whatever reason.
                    this._rejectFunc(e);
                    this._resolveFunc = null;
                    this._rejectFunc = null;
                } finally {
                    this._requestingEmailToken = false;
                }
            }
        }
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

        if (nextStage === 'm.login.dummy') {
            this.submitAuthDict({
                type: 'm.login.dummy',
            });
            return;
        }

        if (this._data && this._data.errcode || this._data.error) {
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
        if (this._chosenFlow === null) {
            this._chosenFlow = this._chooseFlow();
        }
        logger.log("Active flow => %s", JSON.stringify(this._chosenFlow));
        const nextStage = this._firstUncompletedStage(this._chosenFlow);
        logger.log("Next stage: %s", nextStage);
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

