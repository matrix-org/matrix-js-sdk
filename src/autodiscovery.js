/*
Copyright 2018 New Vector Ltd
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

/** @module auto-discovery */

import {logger} from './logger';
import {URL as NodeURL} from "url";

// Dev note: Auto discovery is part of the spec.
// See: https://matrix.org/docs/spec/client_server/r0.4.0.html#server-discovery

/**
 * Description for what an automatically discovered client configuration
 * would look like. Although this is a class, it is recommended that it
 * be treated as an interface definition rather than as a class.
 *
 * Additional properties than those defined here may be present, and
 * should follow the Java package naming convention.
 */
class DiscoveredClientConfig { // eslint-disable-line no-unused-vars
    // Dev note: this is basically a copy/paste of the .well-known response
    // object as defined in the spec. It does have additional information,
    // however. Overall, this exists to serve as a place for documentation
    // and not functionality.
    // See https://matrix.org/docs/spec/client_server/r0.4.0.html#get-well-known-matrix-client

    constructor() {
        /**
         * The homeserver configuration the client should use. This will
         * always be present on the object.
         * @type {{state: string, base_url: string}} The configuration.
         */
        this["m.homeserver"] = {
            /**
             * The lookup result state. If this is anything other than
             * AutoDiscovery.SUCCESS then base_url may be falsey. Additionally,
             * if this is not AutoDiscovery.SUCCESS then the client should
             * assume the other properties in the client config (such as
             * the identity server configuration) are not valid.
             */
            state: AutoDiscovery.PROMPT,

            /**
             * If the state is AutoDiscovery.FAIL_ERROR or .FAIL_PROMPT
             * then this will contain a human-readable (English) message
             * for what went wrong. If the state is none of those previously
             * mentioned, this will be falsey.
             */
            error: "Something went wrong",

            /**
             * The base URL clients should use to talk to the homeserver,
             * particularly for the login process. May be falsey if the
             * state is not AutoDiscovery.SUCCESS.
             */
            base_url: "https://matrix.org",
        };

        /**
         * The identity server configuration the client should use. This
         * will always be present on teh object.
         * @type {{state: string, base_url: string}} The configuration.
         */
        this["m.identity_server"] = {
            /**
             * The lookup result state. If this is anything other than
             * AutoDiscovery.SUCCESS then base_url may be falsey.
             */
            state: AutoDiscovery.PROMPT,

            /**
             * The base URL clients should use for interacting with the
             * identity server. May be falsey if the state is not
             * AutoDiscovery.SUCCESS.
             */
            base_url: "https://vector.im",
        };
    }
}

/**
 * Utilities for automatically discovery resources, such as homeservers
 * for users to log in to.
 */
export class AutoDiscovery {
    // Dev note: the constants defined here are related to but not
    // exactly the same as those in the spec. This is to hopefully
    // translate the meaning of the states in the spec, but also
    // support our own if needed.

    static get ERROR_INVALID() {
        return "Invalid homeserver discovery response";
    }

    static get ERROR_GENERIC_FAILURE() {
        return "Failed to get autodiscovery configuration from server";
    }

    static get ERROR_INVALID_HS_BASE_URL() {
        return "Invalid base_url for m.homeserver";
    }

    static get ERROR_INVALID_HOMESERVER() {
        return "Homeserver URL does not appear to be a valid Matrix homeserver";
    }

    static get ERROR_INVALID_IS_BASE_URL() {
        return "Invalid base_url for m.identity_server";
    }

    static get ERROR_INVALID_IDENTITY_SERVER() {
        return "Identity server URL does not appear to be a valid identity server";
    }

    static get ERROR_INVALID_IS() {
        return "Invalid identity server discovery response";
    }

    static get ERROR_MISSING_WELLKNOWN() {
        return "No .well-known JSON file found";
    }

    static get ERROR_INVALID_JSON() {
        return "Invalid JSON";
    }

    static get ALL_ERRORS() {
        return [
            AutoDiscovery.ERROR_INVALID,
            AutoDiscovery.ERROR_GENERIC_FAILURE,
            AutoDiscovery.ERROR_INVALID_HS_BASE_URL,
            AutoDiscovery.ERROR_INVALID_HOMESERVER,
            AutoDiscovery.ERROR_INVALID_IS_BASE_URL,
            AutoDiscovery.ERROR_INVALID_IDENTITY_SERVER,
            AutoDiscovery.ERROR_INVALID_IS,
            AutoDiscovery.ERROR_MISSING_WELLKNOWN,
            AutoDiscovery.ERROR_INVALID_JSON,
        ];
    }

    /**
     * The auto discovery failed. The client is expected to communicate
     * the error to the user and refuse logging in.
     * @return {string}
     * @constructor
     */
    static get FAIL_ERROR() { return "FAIL_ERROR"; }

    /**
     * The auto discovery failed, however the client may still recover
     * from the problem. The client is recommended to that the same
     * action it would for PROMPT while also warning the user about
     * what went wrong. The client may also treat this the same as
     * a FAIL_ERROR state.
     * @return {string}
     * @constructor
     */
    static get FAIL_PROMPT() { return "FAIL_PROMPT"; }

    /**
     * The auto discovery didn't fail but did not find anything of
     * interest. The client is expected to prompt the user for more
     * information, or fail if it prefers.
     * @return {string}
     * @constructor
     */
    static get PROMPT() { return "PROMPT"; }

    /**
     * The auto discovery was successful.
     * @return {string}
     * @constructor
     */
    static get SUCCESS() { return "SUCCESS"; }

    /**
     * Validates and verifies client configuration information for purposes
     * of logging in. Such information includes the homeserver URL
     * and identity server URL the client would want. Additional details
     * may also be included, and will be transparently brought into the
     * response object unaltered.
     * @param {string} wellknown The configuration object itself, as returned
     * by the .well-known auto-discovery endpoint.
     * @return {Promise<DiscoveredClientConfig>} Resolves to the verified
     * configuration, which may include error states. Rejects on unexpected
     * failure, not when verification fails.
     */
    static async fromDiscoveryConfig(wellknown) {
        // Step 1 is to get the config, which is provided to us here.

        // We default to an error state to make the first few checks easier to
        // write. We'll update the properties of this object over the duration
        // of this function.
        const clientConfig = {
            "m.homeserver": {
                state: AutoDiscovery.FAIL_ERROR,
                error: AutoDiscovery.ERROR_INVALID,
                base_url: null,
            },
            "m.identity_server": {
                // Technically, we don't have a problem with the identity server
                // config at this point.
                state: AutoDiscovery.PROMPT,
                error: null,
                base_url: null,
            },
        };

        if (!wellknown || !wellknown["m.homeserver"]) {
            logger.error("No m.homeserver key in config");

            clientConfig["m.homeserver"].state = AutoDiscovery.FAIL_PROMPT;
            clientConfig["m.homeserver"].error = AutoDiscovery.ERROR_INVALID;

            return Promise.resolve(clientConfig);
        }

        if (!wellknown["m.homeserver"]["base_url"]) {
            logger.error("No m.homeserver base_url in config");

            clientConfig["m.homeserver"].state = AutoDiscovery.FAIL_PROMPT;
            clientConfig["m.homeserver"].error = AutoDiscovery.ERROR_INVALID_HS_BASE_URL;

            return Promise.resolve(clientConfig);
        }

        // Step 2: Make sure the homeserver URL is valid *looking*. We'll make
        // sure it points to a homeserver in Step 3.
        const hsUrl = this._sanitizeWellKnownUrl(
            wellknown["m.homeserver"]["base_url"],
        );
        if (!hsUrl) {
            logger.error("Invalid base_url for m.homeserver");
            clientConfig["m.homeserver"].error = AutoDiscovery.ERROR_INVALID_HS_BASE_URL;
            return Promise.resolve(clientConfig);
        }

        // Step 3: Make sure the homeserver URL points to a homeserver.
        const hsVersions = await this._fetchWellKnownObject(
            `${hsUrl}/_matrix/client/versions`,
        );
        if (!hsVersions || !hsVersions.raw["versions"]) {
            logger.error("Invalid /versions response");
            clientConfig["m.homeserver"].error = AutoDiscovery.ERROR_INVALID_HOMESERVER;

            // Supply the base_url to the caller because they may be ignoring liveliness
            // errors, like this one.
            clientConfig["m.homeserver"].base_url = hsUrl;

            return Promise.resolve(clientConfig);
        }

        // Step 4: Now that the homeserver looks valid, update our client config.
        clientConfig["m.homeserver"] = {
            state: AutoDiscovery.SUCCESS,
            error: null,
            base_url: hsUrl,
        };

        // Step 5: Try to pull out the identity server configuration
        let isUrl = "";
        if (wellknown["m.identity_server"]) {
            // We prepare a failing identity server response to save lines later
            // in this branch.
            const failingClientConfig = {
                "m.homeserver": clientConfig["m.homeserver"],
                "m.identity_server": {
                    state: AutoDiscovery.FAIL_PROMPT,
                    error: AutoDiscovery.ERROR_INVALID_IS,
                    base_url: null,
                },
            };

            // Step 5a: Make sure the URL is valid *looking*. We'll make sure it
            // points to an identity server in Step 5b.
            isUrl = this._sanitizeWellKnownUrl(
                wellknown["m.identity_server"]["base_url"],
            );
            if (!isUrl) {
                logger.error("Invalid base_url for m.identity_server");
                failingClientConfig["m.identity_server"].error =
                    AutoDiscovery.ERROR_INVALID_IS_BASE_URL;
                return Promise.resolve(failingClientConfig);
            }

            // Step 5b: Verify there is an identity server listening on the provided
            // URL.
            const isResponse = await this._fetchWellKnownObject(
                `${isUrl}/_matrix/identity/api/v1`,
            );
            if (!isResponse || !isResponse.raw || isResponse.action !== "SUCCESS") {
                logger.error("Invalid /api/v1 response");
                failingClientConfig["m.identity_server"].error =
                    AutoDiscovery.ERROR_INVALID_IDENTITY_SERVER;

                // Supply the base_url to the caller because they may be ignoring
                // liveliness errors, like this one.
                failingClientConfig["m.identity_server"].base_url = isUrl;

                return Promise.resolve(failingClientConfig);
            }
        }

        // Step 6: Now that the identity server is valid, or never existed,
        // populate the IS section.
        if (isUrl && isUrl.length > 0) {
            clientConfig["m.identity_server"] = {
                state: AutoDiscovery.SUCCESS,
                error: null,
                base_url: isUrl,
            };
        }

        // Step 7: Copy any other keys directly into the clientConfig. This is for
        // things like custom configuration of services.
        Object.keys(wellknown)
            .map((k) => {
                if (k === "m.homeserver" || k === "m.identity_server") {
                    // Only copy selected parts of the config to avoid overwriting
                    // properties computed by the validation logic above.
                    const notProps = ["error", "state", "base_url"];
                    for (const prop of Object.keys(wellknown[k])) {
                        if (notProps.includes(prop)) continue;
                        clientConfig[k][prop] = wellknown[k][prop];
                    }
                } else {
                    // Just copy the whole thing over otherwise
                    clientConfig[k] = wellknown[k];
                }
            });

        // Step 8: Give the config to the caller (finally)
        return Promise.resolve(clientConfig);
    }

    /**
     * Attempts to automatically discover client configuration information
     * prior to logging in. Such information includes the homeserver URL
     * and identity server URL the client would want. Additional details
     * may also be discovered, and will be transparently included in the
     * response object unaltered.
     * @param {string} domain The homeserver domain to perform discovery
     * on. For example, "matrix.org".
     * @return {Promise<DiscoveredClientConfig>} Resolves to the discovered
     * configuration, which may include error states. Rejects on unexpected
     * failure, not when discovery fails.
     */
    static async findClientConfig(domain) {
        if (!domain || typeof(domain) !== "string" || domain.length === 0) {
            throw new Error("'domain' must be a string of non-zero length");
        }

        // We use a .well-known lookup for all cases. According to the spec, we
        // can do other discovery mechanisms if we want such as custom lookups
        // however we won't bother with that here (mostly because the spec only
        // supports .well-known right now).
        //
        // By using .well-known, we need to ensure we at least pull out a URL
        // for the homeserver. We don't really need an identity server configuration
        // but will return one anyways (with state PROMPT) to make development
        // easier for clients. If we can't get a homeserver URL, all bets are
        // off on the rest of the config and we'll assume it is invalid too.

        // We default to an error state to make the first few checks easier to
        // write. We'll update the properties of this object over the duration
        // of this function.
        const clientConfig = {
            "m.homeserver": {
                state: AutoDiscovery.FAIL_ERROR,
                error: AutoDiscovery.ERROR_INVALID,
                base_url: null,
            },
            "m.identity_server": {
                // Technically, we don't have a problem with the identity server
                // config at this point.
                state: AutoDiscovery.PROMPT,
                error: null,
                base_url: null,
            },
        };

        // Step 1: Actually request the .well-known JSON file and make sure it
        // at least has a homeserver definition.
        const wellknown = await this._fetchWellKnownObject(
            `https://${domain}/.well-known/matrix/client`,
        );
        if (!wellknown || wellknown.action !== "SUCCESS") {
            logger.error("No response or error when parsing .well-known");
            if (wellknown.reason) logger.error(wellknown.reason);
            if (wellknown.action === "IGNORE") {
                clientConfig["m.homeserver"] = {
                    state: AutoDiscovery.PROMPT,
                    error: null,
                    base_url: null,
                };
            } else {
                // this can only ever be FAIL_PROMPT at this point.
                clientConfig["m.homeserver"].state = AutoDiscovery.FAIL_PROMPT;
                clientConfig["m.homeserver"].error = AutoDiscovery.ERROR_INVALID;
            }
            return Promise.resolve(clientConfig);
        }

        // Step 2: Validate and parse the config
        return AutoDiscovery.fromDiscoveryConfig(wellknown.raw);
    }

    /**
     * Gets the raw discovery client configuration for the given domain name.
     * Should only be used if there's no validation to be done on the resulting
     * object, otherwise use findClientConfig().
     * @param {string} domain The domain to get the client config for.
     * @returns {Promise<object>} Resolves to the domain's client config. Can
     * be an empty object.
     */
    static async getRawClientConfig(domain) {
        if (!domain || typeof(domain) !== "string" || domain.length === 0) {
            throw new Error("'domain' must be a string of non-zero length");
        }

        const response = await this._fetchWellKnownObject(
            `https://${domain}/.well-known/matrix/client`,
        );
        if (!response) return {};
        return response.raw || {};
    }

    /**
     * Sanitizes a given URL to ensure it is either an HTTP or HTTP URL and
     * is suitable for the requirements laid out by .well-known auto discovery.
     * If valid, the URL will also be stripped of any trailing slashes.
     * @param {string} url The potentially invalid URL to sanitize.
     * @return {string|boolean} The sanitized URL or a falsey value if the URL is invalid.
     * @private
     */
    static _sanitizeWellKnownUrl(url) {
        if (!url) return false;

        try {
            // We have to try and parse the URL using the NodeJS URL
            // library if we're on NodeJS and use the browser's URL
            // library when we're in a browser. To accomplish this, we
            // try the NodeJS version first and fall back to the browser.
            let parsed = null;
            try {
                if (NodeURL) parsed = new NodeURL(url);
                else parsed = new URL(url);
            } catch (e) {
                parsed = new URL(url);
            }

            if (!parsed || !parsed.hostname) return false;
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

            const port = parsed.port ? `:${parsed.port}` : "";
            const path = parsed.pathname ? parsed.pathname : "";
            let saferUrl = `${parsed.protocol}//${parsed.hostname}${port}${path}`;
            if (saferUrl.endsWith("/")) {
                saferUrl = saferUrl.substring(0, saferUrl.length - 1);
            }
            return saferUrl;
        } catch (e) {
            logger.error(e);
            return false;
        }
    }

    /**
     * Fetches a JSON object from a given URL, as expected by all .well-known
     * related lookups. If the server gives a 404 then the `action` will be
     * IGNORE. If the server returns something that isn't JSON, the `action`
     * will be FAIL_PROMPT. For any other failure the `action` will be FAIL_PROMPT.
     *
     * The returned object will be a result of the call in object form with
     * the following properties:
     *   raw: The JSON object returned by the server.
     *   action: One of SUCCESS, IGNORE, or FAIL_PROMPT.
     *   reason: Relatively human readable description of what went wrong.
     *   error: The actual Error, if one exists.
     * @param {string} url The URL to fetch a JSON object from.
     * @return {Promise<object>} Resolves to the returned state.
     * @private
     */
    static async _fetchWellKnownObject(url) {
        return new Promise(function(resolve, reject) {
            const request = require("./matrix").getRequest();
            if (!request) throw new Error("No request library available");
            request(
                { method: "GET", uri: url, timeout: 5000 },
                (err, response, body) => {
                    if (err || response &&
                        (response.statusCode < 200 || response.statusCode >= 300)
                    ) {
                        let action = "FAIL_PROMPT";
                        let reason = (err ? err.message : null) || "General failure";
                        if (response && response.statusCode === 404) {
                            action = "IGNORE";
                            reason = AutoDiscovery.ERROR_MISSING_WELLKNOWN;
                        }
                        resolve({raw: {}, action: action, reason: reason, error: err});
                        return;
                    }

                    try {
                        resolve({raw: JSON.parse(body), action: "SUCCESS"});
                    } catch (e) {
                        let reason = AutoDiscovery.ERROR_INVALID;
                        if (e.name === "SyntaxError") {
                            reason = AutoDiscovery.ERROR_INVALID_JSON;
                        }
                        resolve({
                            raw: {},
                            action: "FAIL_PROMPT",
                            reason: reason,
                            error: e,
                        });
                    }
                },
            );
        });
    }
}
