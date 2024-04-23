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

import {
    MSC4108RendezvousSession,
    MSC4108SecureChannel,
    MSC4108SignInWithQR,
    PayloadType,
} from "../../../src/rendezvous";
import { defer } from "../../../src/utils";
import { ClientPrefix, IHttpOpts, IMyDevice, MatrixClient, MatrixError, MatrixHttpApi } from "../../../src";

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
        getHomeserverUrl() {
            return baseUrl;
        },
        getDevice: jest.fn(),
        getCrypto: jest.fn(() => crypto),
    } as unknown as MatrixClient;
    client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
        baseUrl: client.baseUrl,
        prefix: ClientPrefix.Unstable,
        onlyData: true,
    });
    return client;
}

describe("MSC4108SignInWithQR", () => {
    const url = "https://fallbackserver/rz/123";

    it("should generate qr code data as expected", async () => {
        const session = new MSC4108RendezvousSession({
            url,
        });
        const channel = new MSC4108SecureChannel(session);
        const login = new MSC4108SignInWithQR(channel, false);

        await login.generateCode();
        expect(login.code).toHaveLength(71);
        const text = new TextDecoder().decode(login.code);
        expect(text.startsWith("MATRIX")).toBeTruthy();
        expect(text.endsWith(url)).toBeTruthy();
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

            const ourChannel = new MSC4108SecureChannel(ourMockSession);
            const qrCodeData = QrCodeData.from_bytes(await ourChannel.generateCode(QrCodeMode.Reciprocate));
            const opponentChannel = new MSC4108SecureChannel(opponentMockSession, qrCodeData.public_key);

            client = makeMockClient({ userId: "@alice:example.com", deviceId: "alice", msc4108Enabled: true });
            ourLogin = new MSC4108SignInWithQR(ourChannel, true, client);
            opponentLogin = new MSC4108SignInWithQR(opponentChannel, false);
        });

        it("should be able to connect with opponent and share homeserver url & check code", async () => {
            await Promise.all([
                expect(ourLogin.loginStep1()).resolves.toEqual({}),
                expect(opponentLogin.loginStep1()).resolves.toEqual({ homeserverBaseUrl: client.baseUrl }),
            ]);

            expect(ourLogin.checkCode).toBe(opponentLogin.checkCode);
        });

        it("should be able to connect with opponent and share verificationUri", async () => {
            await Promise.all([ourLogin.loginStep1(), opponentLogin.loginStep1()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            const deviceId = "DEADB33F";
            const verificationUri = "https://example.com/verify";
            const verificationUriComplete = "https://example.com/verify/complete";

            mocked(client.getDevice).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));

            await Promise.all([
                expect(ourLogin.loginStep2And3()).resolves.toEqual({ verificationUri: verificationUriComplete }),
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

        it("should be able to connect with opponent and share secrets", async () => {
            await Promise.all([ourLogin.loginStep1(), opponentLogin.loginStep1()]);

            // We don't have the new device side of this flow implemented at this time so mock it
            // @ts-ignore
            ourLogin.expectingNewDeviceId = "DEADB33F";

            const ourProm = ourLogin.loginStep5();

            // Consume the ProtocolAccepted message which would normally be handled by step 4 which we do not have here
            // @ts-ignore
            await opponentLogin.receive();

            mocked(client.getDevice).mockResolvedValue({} as IMyDevice);

            const secrets = {
                cross_signing: { master_key: "mk", user_signing_key: "usk", self_signing_key: "ssk" },
            };
            mocked(client.getCrypto()!.exportSecretsForQrLogin).mockResolvedValue(secrets);

            const payload = {
                secrets: expect.objectContaining(secrets),
            };
            await Promise.all([
                expect(ourProm).resolves.toEqual(payload),
                expect(opponentLogin.loginStep5()).resolves.toEqual(payload),
            ]);
        });

        it("should abort on unexpected errors", async () => {
            await Promise.all([ourLogin.loginStep1(), opponentLogin.loginStep1()]);

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

            await expect(ourLogin.loginStep5()).rejects.toThrow("The message");
        });

        it("should abort on declined login", async () => {
            await Promise.all([ourLogin.loginStep1(), opponentLogin.loginStep1()]);

            await ourLogin.declineLoginOnExistingDevice();
            await expect(opponentLogin.loginStep5()).rejects.toThrow("Unexpected message received");
        });
    });
});
