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

import { MSC4108RendezvousSession, MSC4108SecureChannel, MSC4108SignInWithQR } from "../../../src/rendezvous";
import { defer } from "../../../src/utils";
import { ClientPrefix, IHttpOpts, MatrixClient, MatrixHttpApi } from "../../../src";

function makeMockClient(opts: { userId: string; deviceId: string; msc4108Enabled: boolean }): MatrixClient {
    const baseUrl = "https://example.com";
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
                    ourData = defer();
                }),
                receive: jest.fn(() => opponentData.promise),
                url,
            } as unknown as MSC4108RendezvousSession;
            const opponentMockSession = {
                send: jest.fn(async (newData) => {
                    opponentData.resolve(newData);
                    opponentData = defer();
                }),
                receive: jest.fn(() => ourData.promise),
                url,
            } as unknown as MSC4108RendezvousSession;

            const ourChannel = new MSC4108SecureChannel(ourMockSession);
            const qrCodeData = QrCodeData.from_bytes(await ourChannel.generateCode(QrCodeMode.Reciprocate));
            const opponentChannel = new MSC4108SecureChannel(opponentMockSession, qrCodeData.public_key);

            client = makeMockClient({ userId: "@alice:example.com", deviceId: "alice", msc4108Enabled: true });
            ourLogin = new MSC4108SignInWithQR(ourChannel, true, client);
            opponentLogin = new MSC4108SignInWithQR(opponentChannel, false);
        });

        it("should be able to connect with opponent and share homeserver url", async () => {
            const [ourResp, opponentResp] = await Promise.all([ourLogin.loginStep1(), opponentLogin.loginStep1()]);
            expect(ourResp).toEqual({});
            expect(opponentResp).toEqual({ homeserverBaseUrl: client.baseUrl });
        });
    });
});
