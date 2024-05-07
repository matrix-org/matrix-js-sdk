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

import { jwtDecode } from "jwt-decode";
import { IdTokenClaims, OidcMetadata, SigninResponse } from "oidc-client-ts";

import { logger } from "../logger";
import { OidcError } from "./error";

export type ValidatedIssuerConfig = {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    accountManagementEndpoint?: string;
    accountManagementActionsSupported?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const requiredStringProperty = (wellKnown: Record<string, unknown>, key: string): boolean => {
    if (!wellKnown[key] || !optionalStringProperty(wellKnown, key)) {
        logger.error(`Missing or invalid property: ${key}`);
        return false;
    }
    return true;
};
const optionalStringProperty = (wellKnown: Record<string, unknown>, key: string): boolean => {
    if (!!wellKnown[key] && typeof wellKnown[key] !== "string") {
        logger.error(`Invalid property: ${key}`);
        return false;
    }
    return true;
};
const optionalStringArrayProperty = (wellKnown: Record<string, unknown>, key: string): boolean => {
    if (
        !!wellKnown[key] &&
        (!Array.isArray(wellKnown[key]) || !(<unknown[]>wellKnown[key]).every((v) => typeof v === "string"))
    ) {
        logger.error(`Invalid property: ${key}`);
        return false;
    }
    return true;
};
const requiredArrayValue = (wellKnown: Record<string, unknown>, key: string, value: any): boolean => {
    const array = wellKnown[key];
    if (!array || !Array.isArray(array) || !array.includes(value)) {
        logger.error(`Invalid property: ${key}. ${value} is required.`);
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
        requiredStringProperty(wellKnown, "revocation_endpoint"),
        optionalStringProperty(wellKnown, "registration_endpoint"),
        optionalStringProperty(wellKnown, "account_management_uri"),
        optionalStringProperty(wellKnown, "device_authorization_endpoint"),
        optionalStringArrayProperty(wellKnown, "account_management_actions_supported"),
        requiredArrayValue(wellKnown, "response_types_supported", "code"),
        requiredArrayValue(wellKnown, "grant_types_supported", "authorization_code"),
        requiredArrayValue(wellKnown, "code_challenge_methods_supported", "S256"),
    ].some((isValid) => !isValid);

    if (!isInvalid) {
        return {
            authorizationEndpoint: <string>wellKnown["authorization_endpoint"],
            tokenEndpoint: <string>wellKnown["token_endpoint"],
            registrationEndpoint: <string>wellKnown["registration_endpoint"],
            accountManagementEndpoint: <string>wellKnown["account_management_uri"],
            accountManagementActionsSupported: <string[]>wellKnown["account_management_actions_supported"],
        };
    }

    logger.error("Issuer configuration not valid");
    throw new Error(OidcError.OpSupport);
};

/**
 * Metadata from OIDC authority discovery
 * With validated properties required in type
 */
export type ValidatedIssuerMetadata = Partial<OidcMetadata> &
    Pick<
        OidcMetadata,
        | "issuer"
        | "authorization_endpoint"
        | "token_endpoint"
        | "registration_endpoint"
        | "revocation_endpoint"
        | "response_types_supported"
        | "grant_types_supported"
        | "code_challenge_methods_supported"
        | "device_authorization_endpoint"
    > & {
        // MSC2965 extensions to the OIDC spec
        account_management_uri?: string;
        account_management_actions_supported?: string[];
    };

/**
 * Wraps validateOIDCIssuerWellKnown in a type assertion
 * that asserts expected properties are present
 * (Typescript assertions cannot be arrow functions)
 * @param metadata - issuer openid-configuration response
 * @throws when metadata validation fails
 */
export function isValidatedIssuerMetadata(
    metadata: Partial<OidcMetadata>,
): asserts metadata is ValidatedIssuerMetadata {
    validateOIDCIssuerWellKnown(metadata);
}

export const decodeIdToken = (token: string): IdTokenClaims => {
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
export const validateIdToken = (
    idToken: string | undefined,
    issuer: string,
    clientId: string,
    nonce: string | undefined,
): void => {
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
        if (nonce !== undefined && claims.nonce !== nonce) {
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

/**
 * State we ask OidcClient to store when starting oidc authorization flow (in `generateOidcAuthorizationUrl`)
 * so that we can access it on return from the OP and complete login
 */
export type UserState = {
    /**
     * Remember which server we were trying to login to
     */
    homeserverUrl: string;
    identityServerUrl?: string;
    /**
     * Used to validate id token
     */
    nonce: string;
};
/**
 * Validate stored user state exists and is valid
 * @param userState - userState returned by oidcClient.processSigninResponse
 * @throws when userState is invalid
 */
export function validateStoredUserState(userState: unknown): asserts userState is UserState {
    if (!isRecord(userState)) {
        logger.error("Stored user state not found");
        throw new Error(OidcError.MissingOrInvalidStoredState);
    }
    const isInvalid = [
        requiredStringProperty(userState, "homeserverUrl"),
        requiredStringProperty(userState, "nonce"),
        optionalStringProperty(userState, "identityServerUrl"),
    ].some((isValid) => !isValid);

    if (isInvalid) {
        throw new Error(OidcError.MissingOrInvalidStoredState);
    }
}

/**
 * The expected response type from the token endpoint during authorization code flow
 * Normalized to always use capitalized 'Bearer' for token_type
 *
 * See https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.4,
 * https://openid.net/specs/openid-connect-basic-1_0.html#TokenOK.
 */
export type BearerTokenResponse = {
    token_type: "Bearer";
    access_token: string;
    scope: string;
    refresh_token?: string;
    expires_in?: number;
    // from oidc-client-ts
    expires_at?: number;
    id_token: string;
};

/**
 * Make required properties required in type
 */
type ValidSignInResponse = SigninResponse &
    BearerTokenResponse & {
        token_type: "Bearer" | "bearer";
    };

const isValidBearerTokenResponse = (response: unknown): response is ValidSignInResponse =>
    isRecord(response) &&
    requiredStringProperty(response, "token_type") &&
    // token_type is case insensitive, some OPs return `token_type: "bearer"`
    (response["token_type"] as string).toLowerCase() === "bearer" &&
    requiredStringProperty(response, "access_token") &&
    requiredStringProperty(response, "refresh_token") &&
    (!("expires_in" in response) || typeof response["expires_in"] === "number");

export function validateBearerTokenResponse(response: unknown): asserts response is ValidSignInResponse {
    if (!isValidBearerTokenResponse(response)) {
        throw new Error(OidcError.InvalidBearerTokenResponse);
    }
}
