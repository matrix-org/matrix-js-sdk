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

import { linkNewDeviceByGeneratingQR, MSC4108FailureReason, signInByGeneratingQR } from "../../../src/rendezvous";
import { ClientPrefix, DEVICE_CODE_SCOPE, type IHttpOpts, type MatrixClient, MatrixHttpApi } from "../../../src";
import { makeDelegatedAuthConfig } from "../../../src/testing.ts";

function makeMockClient(): MatrixClient {
    const baseUrl = "https://example.com";
    const crypto = {
        exportSecretsForQrLogin: vi.fn(),
    };
    const client = {
        doesServerSupportUnstableFeature(feature: string) {
            return Promise.resolve(feature === "org.matrix.msc4108");
        },
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
        getAuthMetadata: vi.fn().mockResolvedValue(makeDelegatedAuthConfig("https://issuer/", [DEVICE_CODE_SCOPE])),
    } as unknown as MatrixClient;
    client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
        baseUrl: client.baseUrl,
        prefix: ClientPrefix.Unstable,
        onlyData: true,
    });
    return client;
}

function mockRendezvousPaths() {
    const rendezvousUrl = "https://rendezvous.example.com/foobar";
    fetchMock.postOnce("path:/_matrix/client/unstable/org.matrix.msc4108/rendezvous", { url: rendezvousUrl });
    fetchMock.delete(rendezvousUrl, 200);
}

describe("MSC4108", () => {
    const client = makeMockClient();

    describe("linkNewDeviceByGeneratingQR", () => {
        it("should generate code successfully", async () => {
            mockRendezvousPaths();
            const onFailure = vi.fn();
            const flow = await linkNewDeviceByGeneratingQR(client, onFailure);

            expect(flow.isNewDevice).toBe(false);
            expect(flow.isExistingDevice).toBe(true);

            expect(flow.code).toHaveLength(92);
            expect(onFailure).not.toHaveBeenCalled();
        });

        it("should fire onFailure if flow was cancelled", async () => {
            mockRendezvousPaths();
            const onFailure = vi.fn();
            const flow = await linkNewDeviceByGeneratingQR(client, onFailure);

            expect(onFailure).not.toHaveBeenCalled();
            await flow.cancel(MSC4108FailureReason.UserCancelled);
            expect(onFailure).toHaveBeenCalledWith(MSC4108FailureReason.UserCancelled);
        });
    });

    describe("signInByGeneratingQR", () => {
        it("should generate code successfully", async () => {
            mockRendezvousPaths();
            const onFailure = vi.fn();
            const flow = await signInByGeneratingQR(client, onFailure);

            expect(flow.isNewDevice).toBe(true);
            expect(flow.isExistingDevice).toBe(false);

            expect(flow.code).toHaveLength(79);
            expect(onFailure).not.toHaveBeenCalled();
        });

        it("should fire onFailure if flow was cancelled", async () => {
            mockRendezvousPaths();
            const onFailure = vi.fn();
            const flow = await signInByGeneratingQR(client, onFailure);

            expect(onFailure).not.toHaveBeenCalled();
            await flow.cancel(MSC4108FailureReason.UserCancelled);
            expect(onFailure).toHaveBeenCalledWith(MSC4108FailureReason.UserCancelled);
        });
    });
});
