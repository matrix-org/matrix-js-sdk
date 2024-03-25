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

import type { operations } from "@matrix-org/spec/client-server";
import { AuthDict } from "../interactive-auth";

/**
 * The request body of a call to `POST /_matrix/client/v3/register`.
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3register
 */
export type RegisterRequest = operations["register"]["requestBody"]["content"]["application/json"] & {
    /**
     * Additional authentication information for the user-interactive authentication API.
     * Note that this information is not used to define how the registered user should be authenticated,
     * but is instead used to authenticate the register call itself.
     */
    auth?: AuthDict;
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
};

/**
 * The result of a successful call to `POST /_matrix/client/v3/register`.
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3register
 */
export type RegisterResponse = operations["register"]["responses"]["200"]["content"]["application/json"];
