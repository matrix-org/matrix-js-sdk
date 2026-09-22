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

import { isSignInWithQRAvailable } from "../../../src/rendezvous";
import { ClientPrefix, type IHttpOpts, type MatrixClient, MatrixHttpApi, OAuthGrantType } from "../../../src";
import { makeDelegatedAuthMetadata } from "../../../src/testing.ts";

function makeMockClient(): MatrixClient {
    const baseUrl = "https://example.com";
    const crypto = {
        exportSecretsForQrLogin: vi.fn(),
    };
    const client = {
        doesServerSupportUnstableFeature: vi.fn(),
        getUserId() {
            return "@user:server";
        },
        getDeviceId() {
            return "DEADBEEF";
        },
        baseUrl,
        getDomain: () => "example.com",
        getDevice: vi.fn(),
        getCrypto: vi.fn(() => crypto),
        getAuthMetadata: vi.fn(),
    } as unknown as MatrixClient;
    client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
        baseUrl: client.baseUrl,
        prefix: ClientPrefix.Unstable,
        onlyData: true,
    });
    return client;
}

describe("MSC4108", () => {
    const client = makeMockClient();

    describe("isSignInWithQRAvailable", () => {
        it.each([
            [false, false, false],
            [false, true, false],
            [true, false, false],
            [true, true, true],
        ])(
            "should return %s if device_code support is %s and msc4108 support is %s",
            async (deviceCodeSupport, mscSupport, expected) => {
                const metadata = makeDelegatedAuthMetadata(
                    "https://issuer/",
                    deviceCodeSupport ? [OAuthGrantType.DeviceAuthorization] : [],
                );
                vi.mocked(client.getAuthMetadata).mockResolvedValue(metadata);
                vi.mocked(client.doesServerSupportUnstableFeature).mockImplementation(
                    async (feature) => feature === "org.matrix.msc4108" && mscSupport,
                );

                await expect(isSignInWithQRAvailable(client)).resolves.toBe(expected);
            },
        );
    });
});
