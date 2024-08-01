/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { QrCodeData, QrCodeMode } from "@matrix-org/matrix-sdk-crypto-wasm";
import { mocked } from "jest-mock";
import fetchMock from "fetch-mock-jest";

import {
    MSC4108FailureReason,
    MSC4108RendezvousSession,
    MSC4108SecureChannel,
    MSC4108SignInWithQR,
    PayloadType,
    RendezvousError,
} from "../../../src/rendezvous";
import { defer } from "../../../src/utils";
import {
    ClientPrefix,
    DEVICE_CODE_SCOPE,
    IHttpOpts,
    IMyDevice,
    MatrixClient,
    MatrixError,
    MatrixHttpApi,
} from "../../../src";
import { mockOpenIdConfiguration } from "../../test-utils/oidc";

function makeMockClient(opts: { userId: string; deviceId: string; msc4108Enabled: boolean }): MatrixClient {
    const baseUrl = "https://example.com";
    const crypto = {
        exportSecretsForQrLogin: jest.fn(),
    };
    const client = {
        doesServerSupportUnstableFeature(feature: string) {
            return Promise.resolve(opts.msc4108Enabled && feature === "org.matrix.msc4108");
        },
        getUserId() {
            return opts.userId;
        },
        getDeviceId() {
            return opts.deviceId;
        },
        baseUrl,
        getDomain: () => "example.com",
        getDevice: jest.fn(),
        getCrypto: jest.fn(() => crypto),
        getAuthIssuer: jest.fn().mockResolvedValue({ issuer: "https://issuer/" }),
    } as unknown as MatrixClient;
    client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
        baseUrl: client.baseUrl,
        prefix: ClientPrefix.Unstable,
        onlyData: true,
    });
    return client;
}

describe("MSC4108SignInWithQR", () => {
    beforeEach(() => {
        fetchMock.get(
            "https://issuer/.well-known/openid-configuration",
            mockOpenIdConfiguration("https://issuer/", [DEVICE_CODE_SCOPE]),
        );
        fetchMock.get("https://issuer/jwks", {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
            keys: [],
        });
    });

    afterEach(() => {
        fetchMock.reset();
    });

    const url = "https://fallbackserver/rz/123";
    const deviceId = "DEADB33F";
    const verificationUri = "https://example.com/verify";
    const verificationUriComplete = "https://example.com/verify/complete";

    it("should generate qr code data as expected", async () => {
        const session = new MSC4108RendezvousSession({
            url,
        });
        const channel = new MSC4108SecureChannel(session);
        const login = new MSC4108SignInWithQR(channel, false);

        await login.generateCode();
        const code = login.code;
        expect(code).toHaveLength(71);
        const text = new TextDecoder().decode(code);
        expect(text.startsWith("MATRIX")).toBeTruthy();
        expect(text.endsWith(url)).toBeTruthy();

        // Assert that the code is stable
        await login.generateCode();
        expect(login.code).toEqual(code);
    });

    describe("should be able to connect as a reciprocating device", () => {
        let client: MatrixClient;
        let ourLogin: MSC4108SignInWithQR;
        let opponentLogin: MSC4108SignInWithQR;

        beforeEach(async () => {
            let ourData = defer<string>();
            let opponentData = defer<string>();

            const ourMockSession = {
                send: jest.fn(async (newData) => {
                    ourData.resolve(newData);
                }),
                receive: jest.fn(() => {
                    const prom = opponentData.promise;
                    prom.then(() => {
                        opponentData = defer();
                    });
                    return prom;
                }),
                url,
                cancelled: false,
                cancel: () => {
                    // @ts-ignore
                    ourMockSession.cancelled = true;
                    ourData.resolve("");
                },
            } as unknown as MSC4108RendezvousSession;
            const opponentMockSession = {
                send: jest.fn(async (newData) => {
                    opponentData.resolve(newData);
                }),
                receive: jest.fn(() => {
                    const prom = ourData.promise;
                    prom.then(() => {
                        ourData = defer();
                    });
                    return prom;
                }),
                url,
            } as unknown as MSC4108RendezvousSession;

            client = makeMockClient({ userId: "@alice:example.com", deviceId: "alice", msc4108Enabled: true });

            const ourChannel = new MSC4108SecureChannel(ourMockSession);
            const qrCodeData = QrCodeData.fromBytes(
                await ourChannel.generateCode(QrCodeMode.Reciprocate, client.getDomain()!),
            );
            const opponentChannel = new MSC4108SecureChannel(opponentMockSession, qrCodeData.publicKey);

            ourLogin = new MSC4108SignInWithQR(ourChannel, true, client);
            opponentLogin = new MSC4108SignInWithQR(opponentChannel, false);
        });

        it("should be able to connect with opponent and share server name & check code", async () => {
            await Promise.all([
                expect(ourLogin.negotiateProtocols()).resolves.toEqual({}),
                expect(opponentLogin.negotiateProtocols()).resolves.toEqual({ serverName: client.getDomain() }),
            ]);

            expect(ourLogin.checkCode).toBe(opponentLogin.checkCode);
        });

        it("should be able to connect with opponent and share verificationUri", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            mocked(client.getDevice).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));

            await Promise.all([
                expect(ourLogin.deviceAuthorizationGrant()).resolves.toEqual({
                    verificationUri: verificationUriComplete,
                }),
                // We don't have the new device side of this flow implemented at this time so mock it
                // @ts-ignore
                opponentLogin.send({
                    type: PayloadType.Protocol,
                    protocol: "device_authorization_grant",
                    device_authorization_grant: {
                        verification_uri: verificationUri,
                        verification_uri_complete: verificationUriComplete,
                    },
                    device_id: deviceId,
                }),
            ]);
        });

        it("should abort if device already exists", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            mocked(client.getDevice).mockResolvedValue({} as IMyDevice);

            await Promise.all([
                expect(ourLogin.deviceAuthorizationGrant()).rejects.toThrow("Specified device ID already exists"),
                // We don't have the new device side of this flow implemented at this time so mock it
                // @ts-ignore
                opponentLogin.send({
                    type: PayloadType.Protocol,
                    protocol: "device_authorization_grant",
                    device_authorization_grant: {
                        verification_uri: verificationUri,
                    },
                    device_id: deviceId,
                }),
            ]);
        });

        it("should abort on unsupported protocol", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            await Promise.all([
                expect(ourLogin.deviceAuthorizationGrant()).rejects.toThrow(
                    "Received a request for an unsupported protocol",
                ),
                // We don't have the new device side of this flow implemented at this time so mock it
                // @ts-ignore
                opponentLogin.send({
                    type: PayloadType.Protocol,
                    protocol: "device_authorization_grant_v2",
                    device_authorization_grant: {
                        verification_uri: verificationUri,
                    },
                    device_id: deviceId,
                }),
            ]);
        });

        it("should be able to connect with opponent and share secrets", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            // @ts-ignore
            ourLogin.expectingNewDeviceId = "DEADB33F";

            const ourProm = ourLogin.shareSecrets();

            // Consume the ProtocolAccepted message which would normally be handled by step 4 which we do not have here
            // @ts-ignore
            await opponentLogin.receive();

            mocked(client.getDevice).mockResolvedValue({} as IMyDevice);

            const secrets = {
                cross_signing: { master_key: "mk", user_signing_key: "usk", self_signing_key: "ssk" },
            };
            client.getCrypto()!.exportSecretsBundle = jest.fn().mockResolvedValue(secrets);

            const payload = {
                secrets: expect.objectContaining(secrets),
            };
            await Promise.all([
                expect(ourProm).resolves.toEqual(payload),
                expect(opponentLogin.shareSecrets()).resolves.toEqual(payload),
            ]);
        });

        it("should abort if device doesn't come up by timeout", async () => {
            jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
                (<Function>fn)();
                // TODO: mock timers properly
                return -1 as any;
            });
            jest.spyOn(Date, "now").mockImplementation(() => {
                return 12345678 + mocked(setTimeout).mock.calls.length * 1000;
            });

            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            // @ts-ignore
            ourLogin.expectingNewDeviceId = "DEADB33F";

            // @ts-ignore
            await opponentLogin.send({
                type: PayloadType.Success,
            });
            mocked(client.getDevice).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));

            const ourProm = ourLogin.shareSecrets();
            await expect(ourProm).rejects.toThrow("New device not found");
        });

        it("should abort on unexpected errors", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            // @ts-ignore
            ourLogin.expectingNewDeviceId = "DEADB33F";

            // @ts-ignore
            await opponentLogin.send({
                type: PayloadType.Success,
            });
            mocked(client.getDevice).mockRejectedValue(
                new MatrixError({ errcode: "M_UNKNOWN", error: "The message" }, 500),
            );

            await expect(ourLogin.shareSecrets()).rejects.toThrow("The message");
        });

        it("should abort on declined login", async () => {
            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            await ourLogin.declineLoginOnExistingDevice();
            await expect(opponentLogin.shareSecrets()).rejects.toThrow(
                new RendezvousError("Failed", MSC4108FailureReason.UserCancelled),
            );
        });

        it("should not send secrets if user cancels", async () => {
            jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
                (<Function>fn)();
                // TODO: mock timers properly
                return -1 as any;
            });

            await Promise.all([ourLogin.negotiateProtocols(), opponentLogin.negotiateProtocols()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            // @ts-ignore
            ourLogin.expectingNewDeviceId = "DEADB33F";

            const ourProm = ourLogin.shareSecrets();
            const opponentProm = opponentLogin.shareSecrets();

            // Consume the ProtocolAccepted message which would normally be handled by step 4 which we do not have here
            // @ts-ignore
            await opponentLogin.receive();

            const deferred = defer<IMyDevice>();
            mocked(client.getDevice).mockReturnValue(deferred.promise);

            ourLogin.cancel(MSC4108FailureReason.UserCancelled).catch(() => {});
            deferred.resolve({} as IMyDevice);

            const secrets = {
                cross_signing: { master_key: "mk", user_signing_key: "usk", self_signing_key: "ssk" },
            };
            client.getCrypto()!.exportSecretsBundle = jest.fn().mockResolvedValue(secrets);

            await Promise.all([
                expect(ourProm).rejects.toThrow("User cancelled"),
                expect(opponentProm).rejects.toThrow("Unexpected message received"),
            ]);
        });
    });
});
