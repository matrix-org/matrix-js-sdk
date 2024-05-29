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

import { AuthDict } from "../interactive-auth";

/**
 * The request body of a call to `POST /_matrix/client/v3/register`.
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3register
 */
export interface RegisterRequest {
    /**
     * Additional authentication information for the user-interactive authentication API.
     * Note that this information is not used to define how the registered user should be authenticated,
     * but is instead used to authenticate the register call itself.
     */
    auth?: AuthDict;
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
     * Guest users can also upgrade their account by going through the ordinary register flow,
     * but specifying the additional POST parameter guest_access_token containing the guest’s access token.
     * They are also required to specify the username parameter to the value of the local part of their username,
     * which is otherwise optional.
     * @see https://spec.matrix.org/v1.10/client-server-api/#guest-access
     */
    guest_access_token?: string;
}

/**
 * The result of a successful call to `POST /_matrix/client/v3/register`.
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3register
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
}
