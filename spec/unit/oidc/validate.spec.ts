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

import { M_AUTHENTICATION } from "../../../src";
import { OidcDiscoveryError, validateWellKnownAuthentication } from "../../../src/oidc/validate";

describe('validateWellKnownAuthentication()', () => {
    const baseWk = {
        "m.homeserver" : {
            base_url: "https://hs.org"
        }
    }
    it('should throw not supported error when wellKnown has no m.authentication section', () => {
        expect(() => validateWellKnownAuthentication(baseWk)).toThrow(OidcDiscoveryError.NotSupported);
    });

    it('should throw misconfigured error when authentication issuer is not a string', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.stable!]: {
                issuer: { url: 'test.com' }
            }
        }
        expect(() => validateWellKnownAuthentication(wk)).toThrow(OidcDiscoveryError.Misconfigured);
    });

    it('should throw misconfigured error when authentication account is not a string', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.stable!]: {
                issuer: "test.com",
                account: { url: "test" }
            }
        }
        expect(() => validateWellKnownAuthentication(wk)).toThrow(OidcDiscoveryError.Misconfigured);
    });

    it('should return valid config when wk uses stable m.authentication', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.stable!]: {
                issuer: "test.com",
                account: "account.com",
            }
        }
        expect(validateWellKnownAuthentication(wk)).toEqual({
            issuer: "test.com",
            account: "account.com"
        });
    });

    it('should return valid config when m.authentication account is falsy', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.stable!]: {
                issuer: "test.com",
            }
        }
        expect(validateWellKnownAuthentication(wk)).toEqual({
            issuer: "test.com",
        });
    });

    it('should remove unexpected properties', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.stable!]: {
                issuer: "test.com",
                somethingElse: "test"
            }
        }
        expect(validateWellKnownAuthentication(wk)).toEqual({
            issuer: "test.com",
        });
    });

    it('should return valid config when wk uses unstable prefix for m.authentication', () => {
        const wk = {
            ...baseWk,
            [M_AUTHENTICATION.unstable!]: {
                issuer: "test.com",
                account: "account.com",
            }
        }
        expect(validateWellKnownAuthentication(wk)).toEqual({
            issuer: "test.com",
            account: "account.com"
        });
    });
});