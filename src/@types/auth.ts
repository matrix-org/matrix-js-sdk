/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { UnstableValue } from "../NamespacedValue";
import { IClientWellKnown } from "../client";

// disable lint because these are wire responses
/* eslint-disable camelcase */

/**
 * Represents a response to the CSAPI `/refresh` endpoint.
 */
export interface IRefreshTokenResponse {
    access_token: string;
    expires_in_ms: number;
    refresh_token: string;
}

/* eslint-enable camelcase */

/**
 * Response to GET login flows as per https://spec.matrix.org/v1.3/client-server-api/#get_matrixclientv3login
 */
export interface ILoginFlowsResponse {
    flows: LoginFlow[];
}

export type LoginFlow = ISSOFlow | IPasswordFlow | ILoginFlow;

export interface ILoginFlow {
    type: string;
}

export interface IPasswordFlow extends ILoginFlow {
    type: "m.login.password";
}

export const DELEGATED_OIDC_COMPATIBILITY = new UnstableValue(
    "delegated_oidc_compatibility",
    "org.matrix.msc3824.delegated_oidc_compatibility",
);

/**
 * Representation of SSO flow as per https://spec.matrix.org/v1.3/client-server-api/#client-login-via-sso
 */
export interface ISSOFlow extends ILoginFlow {
    type: "m.login.sso" | "m.login.cas";
    // eslint-disable-next-line camelcase
    identity_providers?: IIdentityProvider[];
    [DELEGATED_OIDC_COMPATIBILITY.name]?: boolean;
    [DELEGATED_OIDC_COMPATIBILITY.altName]?: boolean;
}

export enum IdentityProviderBrand {
    Gitlab = "gitlab",
    Github = "github",
    Apple = "apple",
    Google = "google",
    Facebook = "facebook",
    Twitter = "twitter",
}

export interface IIdentityProvider {
    id: string;
    name: string;
    icon?: string;
    brand?: IdentityProviderBrand | string;
}

export enum SSOAction {
    /** The user intends to login to an existing account */
    LOGIN = "login",

    /** The user intends to register for a new account */
    REGISTER = "register",
}

/**
 * A client can identify a user using their Matrix ID.
 * This can either be the fully qualified Matrix user ID, or just the localpart of the user ID.
 * @see https://spec.matrix.org/v1.7/client-server-api/#matrix-user-id
 */
type UserLoginIdentifier = {
    type: "m.id.user";
    user: string;
};

/**
 * A client can identify a user using a 3PID associated with the user’s account on the homeserver,
 * where the 3PID was previously associated using the /account/3pid API.
 * See the 3PID Types Appendix for a list of Third-party ID media.
 * @see https://spec.matrix.org/v1.7/client-server-api/#third-party-id
 */
type ThirdPartyLoginIdentifier = {
    type: "m.id.thirdparty";
    medium: string;
    address: string;
};

/**
 * A client can identify a user using a phone number associated with the user’s account,
 * where the phone number was previously associated using the /account/3pid API.
 * The phone number can be passed in as entered by the user; the homeserver will be responsible for canonicalising it.
 * If the client wishes to canonicalise the phone number,
 * then it can use the m.id.thirdparty identifier type with a medium of msisdn instead.
 *
 * The country is the two-letter uppercase ISO-3166-1 alpha-2 country code that the number in phone should be parsed as if it were dialled from.
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#phone-number
 */
type PhoneLoginIdentifier = {
    type: "m.id.phone";
    country: string;
    phone: string;
};

type SpecUserIdentifier = UserLoginIdentifier | ThirdPartyLoginIdentifier | PhoneLoginIdentifier;

/**
 * User Identifiers usable for login & user-interactive authentication.
 *
 * Extensibly allows more than Matrix specified identifiers.
 */
export type UserIdentifier =
    | SpecUserIdentifier
    | { type: Exclude<string, SpecUserIdentifier["type"]>; [key: string]: any };

/**
 * Request body for POST /login request
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3login
 */
export interface LoginRequest {
    /**
     * The login type being used.
     */
    type: "m.login.password" | "m.login.token" | string;
    /**
     * ID of the client device.
     * If this does not correspond to a known client device, a new device will be created.
     * The given device ID must not be the same as a cross-signing key ID.
     * The server will auto-generate a device_id if this is not specified.
     */
    device_id?: string;
    /**
     * Identification information for a user
     */
    identifier?: UserIdentifier;
    /**
     * A display name to assign to the newly-created device.
     * Ignored if device_id corresponds to a known device.
     */
    initial_device_display_name?: string;
    /**
     * When logging in using a third-party identifier, the medium of the identifier.
     * Must be `email`.
     * @deprecated in favour of `identifier`.
     */
    medium?: "email";
    /**
     * Required when type is `m.login.password`. The user’s password.
     */
    password?: string;
    /**
     * If true, the client supports refresh tokens.
     */
    refresh_token?: boolean;
    /**
     * Required when type is `m.login.token`. Part of Token-based login.
     */
    token?: string;
    /**
     * The fully qualified user ID or just local part of the user ID, to log in.
     * @deprecated in favour of identifier.
     */
    user?: string;
    // Extensible
    [key: string]: any;
}

// Export for backwards compatibility
export type ILoginParams = LoginRequest;

/**
 * Response body for POST /login request
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3login
 */
export interface LoginResponse {
    /**
     * An access token for the account.
     * This access token can then be used to authorize other requests.
     */
    access_token: string;
    /**
     * ID of the logged-in device.
     * Will be the same as the corresponding parameter in the request, if one was specified.
     */
    device_id: string;
    /**
     * The fully-qualified Matrix ID for the account.
     */
    user_id: string;
    /**
     * The lifetime of the access token, in milliseconds.
     * Once the access token has expired a new access token can be obtained by using the provided refresh token.
     * If no refresh token is provided, the client will need to re-log in to obtain a new access token.
     * If not given, the client can assume that the access token will not expire.
     */
    expires_in_ms?: number;
    /**
     * A refresh token for the account.
     * This token can be used to obtain a new access token when it expires by calling the /refresh endpoint.
     */
    refresh_token?: string;
    /**
     * Optional client configuration provided by the server.
     * If present, clients SHOULD use the provided object to reconfigure themselves, optionally validating the URLs within.
     * This object takes the same form as the one returned from .well-known autodiscovery.
     */
    well_known?: IClientWellKnown;
    /**
     * The server_name of the homeserver on which the account has been registered.
     * @deprecated Clients should extract the server_name from user_id (by splitting at the first colon) if they require it.
     */
    home_server?: string;
}

/**
 * The result of a successful `m.login.token` issuance request as per https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv1loginget_token
 */
export interface LoginTokenPostResponse {
    /**
     * The token to use with `m.login.token` to authenticate.
     */
    login_token: string;
    /**
     * Expiration in milliseconds.
     */
    expires_in_ms: number;
}
