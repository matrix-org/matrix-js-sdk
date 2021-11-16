/** @module auto-discovery */
import { IClientWellKnown } from "./client";
export declare enum AutoDiscoveryAction {
    SUCCESS = "SUCCESS",
    IGNORE = "IGNORE",
    PROMPT = "PROMPT",
    FAIL_PROMPT = "FAIL_PROMPT",
    FAIL_ERROR = "FAIL_ERROR"
}
/**
 * Utilities for automatically discovery resources, such as homeservers
 * for users to log in to.
 */
export declare class AutoDiscovery {
    static readonly ERROR_INVALID = "Invalid homeserver discovery response";
    static readonly ERROR_GENERIC_FAILURE = "Failed to get autodiscovery configuration from server";
    static readonly ERROR_INVALID_HS_BASE_URL = "Invalid base_url for m.homeserver";
    static readonly ERROR_INVALID_HOMESERVER = "Homeserver URL does not appear to be a valid Matrix homeserver";
    static readonly ERROR_INVALID_IS_BASE_URL = "Invalid base_url for m.identity_server";
    static readonly ERROR_INVALID_IDENTITY_SERVER = "Identity server URL does not appear to be a valid identity server";
    static readonly ERROR_INVALID_IS = "Invalid identity server discovery response";
    static readonly ERROR_MISSING_WELLKNOWN = "No .well-known JSON file found";
    static readonly ERROR_INVALID_JSON = "Invalid JSON";
    static readonly ALL_ERRORS: string[];
    /**
     * The auto discovery failed. The client is expected to communicate
     * the error to the user and refuse logging in.
     * @return {string}
     * @constructor
     */
    static readonly FAIL_ERROR = AutoDiscoveryAction.FAIL_ERROR;
    /**
     * The auto discovery failed, however the client may still recover
     * from the problem. The client is recommended to that the same
     * action it would for PROMPT while also warning the user about
     * what went wrong. The client may also treat this the same as
     * a FAIL_ERROR state.
     * @return {string}
     * @constructor
     */
    static readonly FAIL_PROMPT = AutoDiscoveryAction.FAIL_PROMPT;
    /**
     * The auto discovery didn't fail but did not find anything of
     * interest. The client is expected to prompt the user for more
     * information, or fail if it prefers.
     * @return {string}
     * @constructor
     */
    static readonly PROMPT = AutoDiscoveryAction.PROMPT;
    /**
     * The auto discovery was successful.
     * @return {string}
     * @constructor
     */
    static readonly SUCCESS = AutoDiscoveryAction.SUCCESS;
    /**
     * Validates and verifies client configuration information for purposes
     * of logging in. Such information includes the homeserver URL
     * and identity server URL the client would want. Additional details
     * may also be included, and will be transparently brought into the
     * response object unaltered.
     * @param {object} wellknown The configuration object itself, as returned
     * by the .well-known auto-discovery endpoint.
     * @return {Promise<DiscoveredClientConfig>} Resolves to the verified
     * configuration, which may include error states. Rejects on unexpected
     * failure, not when verification fails.
     */
    static fromDiscoveryConfig(wellknown: any): Promise<IClientWellKnown>;
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
    static findClientConfig(domain: string): Promise<IClientWellKnown>;
    /**
     * Gets the raw discovery client configuration for the given domain name.
     * Should only be used if there's no validation to be done on the resulting
     * object, otherwise use findClientConfig().
     * @param {string} domain The domain to get the client config for.
     * @returns {Promise<object>} Resolves to the domain's client config. Can
     * be an empty object.
     */
    static getRawClientConfig(domain: string): Promise<IClientWellKnown>;
    /**
     * Sanitizes a given URL to ensure it is either an HTTP or HTTP URL and
     * is suitable for the requirements laid out by .well-known auto discovery.
     * If valid, the URL will also be stripped of any trailing slashes.
     * @param {string} url The potentially invalid URL to sanitize.
     * @return {string|boolean} The sanitized URL or a falsey value if the URL is invalid.
     * @private
     */
    private static sanitizeWellKnownUrl;
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
    private static fetchWellKnownObject;
}
//# sourceMappingURL=autodiscovery.d.ts.map