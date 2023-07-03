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
import { IAuthDict } from "../interactive-auth";

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
 * https://spec.matrix.org/v1.7/client-server-api/#matrix-user-id
 */
type UserLoginIdentifier = {
    type: "m.id.user";
    user: string;
};

/**
 * https://spec.matrix.org/v1.7/client-server-api/#third-party-id
 */
type ThirdPartyLoginIdentifier = {
    type: "m.id.thirdparty";
    medium: string;
    address: string;
};

/**
 * https://spec.matrix.org/v1.7/client-server-api/#phone-number
 */
type PhoneLoginIdentifier = {
    type: "m.id.phone";
    country: string;
    phone: string;
};

type SpecLoginIdentifier = UserLoginIdentifier | ThirdPartyLoginIdentifier | PhoneLoginIdentifier;

type LoginIdentifier = SpecLoginIdentifier | { type: Exclude<string, SpecLoginIdentifier["type"]>; [key: string]: any };

/**
 * Request body for POST /login request
 * See https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3login
 */
export interface LoginRequest {
    /**
     * The login type being used.
     */
    type: "m.login.password" | "m.login.token" | string;
    /**
     * Third-party identifier for the user.
     * @deprecated in favour of `identifier`.
     */
    address?: string;
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
    identifier?: LoginIdentifier;
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
 * See https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3login
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
 * The result of a successful [MSC3882](https://github.com/matrix-org/matrix-spec-proposals/pull/3882)
 * `m.login.token` issuance request.
 * Note that this is UNSTABLE and subject to breaking changes without notice.
 */
export interface LoginTokenPostResponse {
    /**
     * The token to use with `m.login.token` to authenticate.
     */
    login_token: string;
    /**
     * Expiration in seconds.
     *
     * @deprecated this is only provided for compatibility with original revision of the MSC.
     */
    expires_in: number;
    /**
     * Expiration in milliseconds.
     */
    expires_in_ms: number;
}

/**
 *
 */
export interface RegisterRequest {
    /**
     * Additional authentication information for the user-interactive authentication API.
     * Note that this information is not used to define how the registered user should be authenticated,
     * but is instead used to authenticate the register call itself.
     */
    auth?: Pick<IAuthDict, "session" | "type">;
    /**
     * The basis for the localpart of the desired Matrix ID.
     * If omitted, the homeserver MUST generate a Matrix ID local part.
     */
    username?: string;
    /**
     * The desired password for the account.
     */
    password?: string;
    /**
     * If true, the client supports refresh tokens.
     */
    refresh_token?: boolean;
    /**
     * If true, an access_token and device_id should not be returned from this call, therefore preventing an automatic login.
     * Defaults to false.
     */
    inhibit_login?: boolean;
    /**
     * A display name to assign to the newly-created device.
     * Ignored if device_id corresponds to a known device.
     */
    initial_device_display_name?: string;
    /**
     * @deprecated missing in the spec
     */
    guest_access_token?: string;
    /**
     * @deprecated missing in the spec
     */
    x_show_msisdn?: boolean;
    /**
     * @deprecated missing in the spec
     */
    bind_msisdn?: boolean;
    /**
     * @deprecated missing in the spec
     */
    bind_email?: boolean;
}

/**
 * The result of a successful call to POST https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3register
 */
export interface RegisterResponse {
    /**
     * The fully-qualified Matrix user ID (MXID) that has been registered.
     */
    user_id: string;
    /**
     * An access token for the account.
     * This access token can then be used to authorize other requests.
     * Required if the inhibit_login option is false.
     */
    access_token?: string;
    /**
     * ID of the registered device.
     * Will be the same as the corresponding parameter in the request, if one was specified.
     * Required if the inhibit_login option is false.
     */
    device_id?: string;
    /**
     * The lifetime of the access token, in milliseconds.
     * Once the access token has expired a new access token can be obtained by using the provided refresh token.
     * If no refresh token is provided, the client will need to re-log in to obtain a new access token.
     * If not given, the client can assume that the access token will not expire.
     *
     * Omitted if the inhibit_login option is true.
     */
    expires_in_ms?: number;
    /**
     * A refresh token for the account.
     * This token can be used to obtain a new access token when it expires by calling the /refresh endpoint.
     *
     * Omitted if the inhibit_login option is true.
     */
    refresh_token?: string;
    /**
     * The server_name of the homeserver on which the account has been registered.
     *
     * @deprecated Clients should extract the server_name from user_id (by splitting at the first colon) if they require it.
     */
    home_server?: string;
}
