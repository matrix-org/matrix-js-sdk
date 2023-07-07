/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import jwtDecode from "jwt-decode";

import { IClientWellKnown, IDelegatedAuthConfig, M_AUTHENTICATION } from "../client";
import { logger } from "../logger";
import { OidcError } from "./error";

/**
 * re-export for backwards compatibility
 * @deprecated use OidcError
 */
export { OidcError as OidcDiscoveryError };

export type ValidatedIssuerConfig = {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
};

/**
 * Validates MSC2965 m.authentication config
 * Returns valid configuration
 * @param wellKnown - client well known as returned from ./well-known/client/matrix
 * @returns config - when present and valid
 * @throws when config is not found or invalid
 */
export const validateWellKnownAuthentication = (wellKnown: IClientWellKnown): IDelegatedAuthConfig => {
    const authentication = M_AUTHENTICATION.findIn<IDelegatedAuthConfig>(wellKnown);

    if (!authentication) {
        throw new Error(OidcError.NotSupported);
    }

    if (
        typeof authentication.issuer === "string" &&
        (!authentication.hasOwnProperty("account") || typeof authentication.account === "string")
    ) {
        return {
            issuer: authentication.issuer,
            account: authentication.account,
        };
    }

    throw new Error(OidcError.Misconfigured);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const requiredStringProperty = (wellKnown: Record<string, unknown>, key: string): boolean => {
    if (!wellKnown[key] || !optionalStringProperty(wellKnown, key)) {
        logger.error(`OIDC issuer configuration: ${key} is invalid`);
        return false;
    }
    return true;
};
const optionalStringProperty = (wellKnown: Record<string, unknown>, key: string): boolean => {
    if (!!wellKnown[key] && typeof wellKnown[key] !== "string") {
        logger.error(`OIDC issuer configuration: ${key} is invalid`);
        return false;
    }
    return true;
};
const requiredArrayValue = (wellKnown: Record<string, unknown>, key: string, value: any): boolean => {
    const array = wellKnown[key];
    if (!array || !Array.isArray(array) || !array.includes(value)) {
        logger.error(`OIDC issuer configuration: ${key} is invalid. ${value} is required.`);
        return false;
    }
    return true;
};

/**
 * Validates issuer `.well-known/openid-configuration`
 * As defined in RFC5785 https://openid.net/specs/openid-connect-discovery-1_0.html
 * validates that OP is compatible with Element's OIDC flow
 * @param wellKnown - json object
 * @returns valid issuer config
 * @throws Error - when issuer config is not found or is invalid
 */
export const validateOIDCIssuerWellKnown = (wellKnown: unknown): ValidatedIssuerConfig => {
    if (!isRecord(wellKnown)) {
        logger.error("Issuer configuration not found or malformed");
        throw new Error(OidcError.OpSupport);
    }

    const isInvalid = [
        requiredStringProperty(wellKnown, "authorization_endpoint"),
        requiredStringProperty(wellKnown, "token_endpoint"),
        optionalStringProperty(wellKnown, "registration_endpoint"),
        requiredArrayValue(wellKnown, "response_types_supported", "code"),
        requiredArrayValue(wellKnown, "grant_types_supported", "authorization_code"),
        requiredArrayValue(wellKnown, "code_challenge_methods_supported", "S256"),
    ].some((isValid) => !isValid);

    if (!isInvalid) {
        return {
            authorizationEndpoint: wellKnown["authorization_endpoint"],
            tokenEndpoint: wellKnown["token_endpoint"],
            registrationEndpoint: wellKnown["registration_endpoint"],
        } as ValidatedIssuerConfig;
    }

    logger.error("Issuer configuration not valid");
    throw new Error(OidcError.OpSupport);
};

/**
 * Standard JWT claims.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7519#section-4.1
 */
interface JwtClaims {
    [claim: string]: unknown;
    /** The "iss" (issuer) claim identifies the principal that issued the JWT. */
    iss?: string;
    /** The "sub" (subject) claim identifies the principal that is the subject of the JWT. */
    sub?: string;
    /** The "aud" (audience) claim identifies the recipients that the JWT is intended for. */
    aud?: string | string[];
    /** The "exp" (expiration time) claim identifies the expiration time on or after which the JWT MUST NOT be accepted for processing. */
    exp?: number;
    // unused claims excluded
}
interface IdTokenClaims extends JwtClaims {
    nonce?: string;
}

const decodeIdToken = (token: string): IdTokenClaims => {
    try {
        return jwtDecode<IdTokenClaims>(token);
    } catch (error) {
        logger.error("Could not decode id_token", error);
        throw error;
    }
};

/**
 * Validate idToken
 * https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
 * @param idToken - id token from token endpoint
 * @param issuer - issuer for the OP as found during discovery
 * @param clientId - this client's id as registered with the OP
 * @param nonce - nonce used in the authentication request
 * @throws when id token is invalid
 */
export const validateIdToken = (idToken: string | undefined, issuer: string, clientId: string, nonce: string): void => {
    try {
        if (!idToken) {
            throw new Error("No ID token");
        }
        const claims = decodeIdToken(idToken);

        // The Issuer Identifier for the OpenID Provider MUST exactly match the value of the iss (issuer) Claim.
        if (claims.iss !== issuer) {
            throw new Error("Invalid issuer");
        }
        /**
         * The Client MUST validate that the aud (audience) Claim contains its client_id value registered at the Issuer identified by the iss (issuer) Claim as an audience.
         * The aud (audience) Claim MAY contain an array with more than one element.
         * The ID Token MUST be rejected if the ID Token does not list the Client as a valid audience, or if it contains additional audiences not trusted by the Client.
         * EW: Don't accept tokens with other untrusted audiences
         * */
        if (claims.aud !== clientId) {
            throw new Error("Invalid audience");
        }

        /**
         * If a nonce value was sent in the Authentication Request, a nonce Claim MUST be present and its value checked
         * to verify that it is the same value as the one that was sent in the Authentication Request.
         */
        if (claims.nonce !== nonce) {
            throw new Error("Invalid nonce");
        }

        /**
         * The current time MUST be before the time represented by the exp Claim.
         *  exp is an epoch timestamp in seconds
         * */
        if (!claims.exp || Date.now() > claims.exp * 1000) {
            throw new Error("Invalid expiry");
        }
    } catch (error) {
        logger.error("Invalid ID token", error);
        throw new Error(OidcError.InvalidIdToken);
    }
};
