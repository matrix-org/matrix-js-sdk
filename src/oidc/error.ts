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

/**
 * Errors expected to be encountered during OIDC discovery, client registration, and authentication.
 * Not intended to be displayed directly to the user.
 */
export enum OidcError {
    NotSupported = "OIDC authentication not supported",
    Misconfigured = "OIDC is misconfigured",
    General = "Something went wrong with OIDC discovery",
    OpSupport = "Configured OIDC OP does not support required functions",
    DynamicRegistrationNotSupported = "Dynamic registration not supported",
    DynamicRegistrationFailed = "Dynamic registration failed",
    DynamicRegistrationInvalid = "Dynamic registration invalid response",
    CodeExchangeFailed = "Failed to exchange code for token",
    InvalidBearerTokenResponse = "Invalid bearer token response",
    InvalidIdToken = "Invalid ID token",
    MissingOrInvalidStoredState = "State required to finish logging in is not found in storage.",
}
