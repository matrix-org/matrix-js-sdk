/*
Copyright 2018 New Vector Ltd

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

import Promise from 'bluebird';
const logger = require("./logger");
import { URL as NodeURL } from "url";

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
                error: "Invalid homeserver discovery response",
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
        if (!wellknown || wellknown.action !== "SUCCESS"
            || !wellknown.raw["m.homeserver"]
            || !wellknown.raw["m.homeserver"]["base_url"]) {
            logger.error("No m.homeserver key in well-known response");
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
            }
            return Promise.resolve(clientConfig);
        }

        // Step 2: Make sure the homeserver URL is valid *looking*. We'll make
        // sure it points to a homeserver in Step 3.
        const hsUrl = this._sanitizeWellKnownUrl(
            wellknown.raw["m.homeserver"]["base_url"],
        );
        if (!hsUrl) {
            logger.error("Invalid base_url for m.homeserver");
            return Promise.resolve(clientConfig);
        }

        // Step 3: Make sure the homeserver URL points to a homeserver.
        const hsVersions = await this._fetchWellKnownObject(
            `${hsUrl}/_matrix/client/versions`,
        );
        if (!hsVersions || !hsVersions.raw["versions"]) {
            logger.error("Invalid /versions response");
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
        if (wellknown.raw["m.identity_server"]) {
            // We prepare a failing identity server response to save lines later
            // in this branch. Note that we also fail the homeserver check in the
            // object because according to the spec we're supposed to FAIL_ERROR
            // if *anything* goes wrong with the IS validation, including invalid
            // format. This means we're supposed to stop discovery completely.
            const failingClientConfig = {
                "m.homeserver": {
                    state: AutoDiscovery.FAIL_ERROR,
                    error: "Invalid identity server discovery response",

                    // We'll provide the base_url that was previously valid for
                    // debugging purposes.
                    base_url: clientConfig["m.homeserver"].base_url,
                },
                "m.identity_server": {
                    state: AutoDiscovery.FAIL_ERROR,
                    error: "Invalid identity server discovery response",
                    base_url: null,
                },
            };

            // Step 5a: Make sure the URL is valid *looking*. We'll make sure it
            // points to an identity server in Step 5b.
            isUrl = this._sanitizeWellKnownUrl(
                wellknown.raw["m.identity_server"]["base_url"],
            );
            if (!isUrl) {
                logger.error("Invalid base_url for m.identity_server");
                return Promise.resolve(failingClientConfig);
            }

            // Step 5b: Verify there is an identity server listening on the provided
            // URL.
            const isResponse = await this._fetchWellKnownObject(
                `${isUrl}/_matrix/identity/api/v1`,
            );
            if (!isResponse || !isResponse.raw || isResponse.action !== "SUCCESS") {
                logger.error("Invalid /api/v1 response");
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
        Object.keys(wellknown.raw)
            .filter((k) => k !== "m.homeserver" && k !== "m.identity_server")
            .map((k) => clientConfig[k] = wellknown.raw[k]);

        // Step 8: Give the config to the caller (finally)
        return Promise.resolve(clientConfig);
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
                { method: "GET", uri: url },
                (err, response, body) => {
                    if (err || response.statusCode < 200 || response.statusCode >= 300) {
                        let action = "FAIL_PROMPT";
                        let reason = (err ? err.message : null) || "General failure";
                        if (response.statusCode === 404) {
                            action = "IGNORE";
                            reason = "No .well-known JSON file found";
                        }
                        resolve({raw: {}, action: action, reason: reason, error: err});
                        return;
                    }

                    try {
                        resolve({raw: JSON.parse(body), action: "SUCCESS"});
                    } catch (e) {
                        let reason = "General failure";
                        if (e.name === "SyntaxError") reason = "Invalid JSON";
                        resolve({
                            raw: {},
                            action: "FAIL_PROMPT",
                            reason: reason, error: e,
                        });
                    }
                },
            );
        });
    }
}
