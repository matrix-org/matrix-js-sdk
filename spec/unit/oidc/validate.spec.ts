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

import { mocked } from "jest-mock";
import { jwtDecode } from "jwt-decode";

import { logger } from "../../../src/logger";
import { validateIdToken, validateOIDCIssuerWellKnown } from "../../../src/oidc/validate";
import { OidcError } from "../../../src/oidc/error";

jest.mock("jwt-decode");

describe("validateOIDCIssuerWellKnown", () => {
    const validWk: any = {
        authorization_endpoint: "https://test.org/authorize",
        token_endpoint: "https://authorize.org/token",
        registration_endpoint: "https://authorize.org/regsiter",
        revocation_endpoint: "https://authorize.org/regsiter",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        account_management_uri: "https://authorize.org/account",
        account_management_actions_supported: ["org.matrix.cross_signing_reset"],
    };
    beforeEach(() => {
        // stub to avoid console litter
        jest.spyOn(logger, "error")
            .mockClear()
            .mockImplementation(() => {});
    });

    it("should throw OP support error when wellKnown is not an object", () => {
        expect(() => {
            validateOIDCIssuerWellKnown([]);
        }).toThrow(OidcError.OpSupport);
        expect(logger.error).toHaveBeenCalledWith("Issuer configuration not found or malformed");
    });

    it("should log all errors before throwing", () => {
        expect(() => {
            validateOIDCIssuerWellKnown({
                ...validWk,
                authorization_endpoint: undefined,
                response_types_supported: [],
            });
        }).toThrow(OidcError.OpSupport);
        expect(logger.error).toHaveBeenCalledWith("Missing or invalid property: authorization_endpoint");
        expect(logger.error).toHaveBeenCalledWith("Invalid property: response_types_supported. code is required.");
    });

    it("should return validated issuer config", () => {
        expect(validateOIDCIssuerWellKnown(validWk)).toEqual({
            authorizationEndpoint: validWk.authorization_endpoint,
            tokenEndpoint: validWk.token_endpoint,
            registrationEndpoint: validWk.registration_endpoint,
            accountManagementActionsSupported: ["org.matrix.cross_signing_reset"],
            accountManagementEndpoint: "https://authorize.org/account",
        });
    });

    it("should return validated issuer config without registrationendpoint", () => {
        const wk = { ...validWk };
        delete wk.registration_endpoint;
        expect(validateOIDCIssuerWellKnown(wk)).toEqual({
            authorizationEndpoint: validWk.authorization_endpoint,
            tokenEndpoint: validWk.token_endpoint,
            registrationEndpoint: undefined,
            accountManagementActionsSupported: ["org.matrix.cross_signing_reset"],
            accountManagementEndpoint: "https://authorize.org/account",
        });
    });

    type TestCase = [string, any];
    it.each<TestCase>([
        ["authorization_endpoint", undefined],
        ["authorization_endpoint", { not: "a string" }],
        ["token_endpoint", undefined],
        ["token_endpoint", { not: "a string" }],
        ["registration_endpoint", { not: "a string" }],
        ["response_types_supported", undefined],
        ["response_types_supported", "not an array"],
        ["response_types_supported", ["doesnt include code"]],
        ["grant_types_supported", undefined],
        ["grant_types_supported", "not an array"],
        ["grant_types_supported", ["doesnt include authorization_code"]],
        ["code_challenge_methods_supported", undefined],
        ["code_challenge_methods_supported", "not an array"],
        ["code_challenge_methods_supported", ["doesnt include S256"]],
        ["account_management_uri", { not: "a string" }],
        ["account_management_actions_supported", { not: "an array" }],
    ])("should throw OP support error when %s is %s", (key, value) => {
        const wk = {
            ...validWk,
            [key]: value,
        };
        expect(() => validateOIDCIssuerWellKnown(wk)).toThrow(OidcError.OpSupport);
    });
});

describe("validateIdToken()", () => {
    const nonce = "test-nonce";
    const issuer = "https://auth.org/issuer";
    const clientId = "test-client-id";
    const idToken = "test-id-token";

    const validDecodedIdToken = {
        // nonce matches
        nonce,
        // not expired
        exp: Date.now() / 1000 + 5555,
        // audience is this client
        aud: clientId,
        // issuer matches
        iss: issuer,
    };
    beforeEach(() => {
        mocked(jwtDecode).mockClear().mockReturnValue(validDecodedIdToken);

        jest.spyOn(logger, "error").mockClear();
    });

    it("should throw when idToken is falsy", () => {
        expect(() => validateIdToken(undefined, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
    });

    it("should throw when idToken cannot be decoded", () => {
        mocked(jwtDecode).mockImplementation(() => {
            throw new Error("oh no!");
        });
        expect(() => validateIdToken(undefined, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
    });

    it("should throw when issuer does not match", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            iss: "https://badissuer.com",
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid issuer"));
    });

    it("should throw when audience does not include clientId", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            aud: "qwerty,uiop,asdf",
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid audience"));
    });

    it("should throw when audience includes clientId and other audiences", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            aud: `${clientId},uiop,asdf`,
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid audience"));
    });

    it("should throw when nonce does not match", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            nonce: "something else",
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid nonce"));
    });

    it("should throw when token does not have an expiry", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            exp: undefined,
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid expiry"));
    });

    it("should throw when token is expired", () => {
        mocked(jwtDecode).mockReturnValue({
            ...validDecodedIdToken,
            // expired in the past
            exp: Date.now() / 1000 - 777,
        });
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).toThrow(new Error(OidcError.InvalidIdToken));
        expect(logger.error).toHaveBeenCalledWith("Invalid ID token", new Error("Invalid expiry"));
    });

    it("should not throw for a valid id token", () => {
        expect(() => validateIdToken(idToken, issuer, clientId, nonce)).not.toThrow();
    });
});
