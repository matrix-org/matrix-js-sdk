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

import type { SigningKey } from "oidc-client-ts";
import { ValidatedIssuerConfig, ValidatedIssuerMetadata } from "./validate.ts";

export * from "./authorize.ts";
export * from "./discovery.ts";
export * from "./error.ts";
export * from "./register.ts";
export * from "./tokenRefresher.ts";
export * from "./validate.ts";

/**
 * Validated config for native OIDC authentication, as returned by {@link discoverAndValidateOIDCIssuerWellKnown}.
 * Contains metadata and signing keys from the issuer's well-known (https://oidc-issuer.example.com/.well-known/openid-configuration).
 */
export interface OidcClientConfig extends ValidatedIssuerConfig {
    metadata: ValidatedIssuerMetadata;
    signingKeys?: SigningKey[];
}
