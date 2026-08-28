/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import fetchMock from "@fetch-mock/vitest";

import { OAuth2 } from "../../../src";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";

describe("tokenRevocation", () => {
    const issuer = "https://issuer.org/";
    const clientId = "test-client-id";
    const redirectUri = "https://test.org";
    const deviceId = "abc123";

    const metadata = makeDelegatedAuthMetadata(issuer);
    const auth = new OAuth2(metadata, { clientId, redirectUri, deviceId });

    beforeEach(() => {
        // A successful revocation response as described by RFC 7009 § 2.2: the authorization server
        // responds with HTTP 200 and can have anything as the body including empty.
        // https://datatracker.ietf.org/doc/html/rfc7009#section-2.2
        fetchMock.post(
            metadata.revocation_endpoint,
            {
                status: 200,
                headers: {
                    "Content-Length": "0",
                },
                body: "",
            },
            { name: "revocation-endpoint" },
        );
    });

    it("should resolve on the empty 200 response the RFC mandates for a successful revocation", async () => {
        await expect(auth.revokeToken("access-token", "access_token")).resolves.toBeUndefined();

        expect(fetchMock).toHaveFetchedTimes(1, metadata.revocation_endpoint);
    });

    it("should make correct request to the revocation endpoint", async () => {
        await auth.revokeToken("access-token", "access_token");

        expect(fetchMock.callHistory.lastCall(metadata.revocation_endpoint)?.options).toStrictEqual(
            expect.objectContaining({
                method: "post",
                headers: {
                    "accept": "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                },
            }),
        );

        // check body is correctly formed
        const queryParams = fetchMock.callHistory.lastCall(metadata.revocation_endpoint)!.options
            .body as URLSearchParams;
        expect(queryParams.get("token")).toEqual("access-token");
        expect(queryParams.get("client_id")).toEqual(clientId);
        expect(queryParams.get("token_type_hint")).toEqual("access_token");
    });

    it("should omit the token_type_hint when no token type is given", async () => {
        await auth.revokeToken("refresh-token");

        const queryParams = fetchMock.callHistory.lastCall(metadata.revocation_endpoint)!.options
            .body as URLSearchParams;
        expect(queryParams.get("token")).toEqual("refresh-token");
        expect(queryParams.has("token_type_hint")).toBe(false);
    });
});
