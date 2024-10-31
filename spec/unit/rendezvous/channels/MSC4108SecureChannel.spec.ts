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

import { EstablishedEcies, QrCodeData, QrCodeMode, Ecies } from "@matrix-org/matrix-sdk-crypto-wasm";
import { mocked } from "jest-mock";

import { MSC4108RendezvousSession, MSC4108SecureChannel, PayloadType } from "../../../../src/rendezvous";

describe("MSC4108SecureChannel", () => {
    const baseUrl = "https://example.com";
    const url = "https://fallbackserver/rz/123";

    it("should generate qr code data as expected", async () => {
        const session = new MSC4108RendezvousSession({
            url,
        });
        const channel = new MSC4108SecureChannel(session);

        const code = await channel.generateCode(QrCodeMode.Login);
        expect(code).toHaveLength(71);
        const text = new TextDecoder().decode(code);
        expect(text.startsWith("MATRIX")).toBeTruthy();
        expect(text.endsWith(url)).toBeTruthy();
    });

    it("should throw error if attempt to connect multiple times", async () => {
        const mockSession = {
            send: jest.fn(),
            receive: jest.fn(),
            url,
        } as unknown as MSC4108RendezvousSession;
        const channel = new MSC4108SecureChannel(mockSession);

        const qrCodeData = QrCodeData.fromBytes(await channel.generateCode(QrCodeMode.Reciprocate, baseUrl));
        const { initial_message: ciphertext } = new Ecies().establish_outbound_channel(
            qrCodeData.publicKey,
            "MATRIX_QR_CODE_LOGIN_INITIATE",
        );
        mocked(mockSession.receive).mockResolvedValue(ciphertext);
        await channel.connect();
        await expect(channel.connect()).rejects.toThrow("Channel already connected");
    });

    it("should throw error on invalid initiate response", async () => {
        const mockSession = {
            send: jest.fn(),
            receive: jest.fn(),
            url,
        } as unknown as MSC4108RendezvousSession;
        const channel = new MSC4108SecureChannel(mockSession);

        mocked(mockSession.receive).mockResolvedValue("");
        await expect(channel.connect()).rejects.toThrow("No response from other device");

        const qrCodeData = QrCodeData.fromBytes(await channel.generateCode(QrCodeMode.Reciprocate, baseUrl));
        const { initial_message: ciphertext } = new Ecies().establish_outbound_channel(
            qrCodeData.publicKey,
            "NOT_REAL_MATRIX_QR_CODE_LOGIN_INITIATE",
        );

        mocked(mockSession.receive).mockResolvedValue(ciphertext);
        await expect(channel.connect()).rejects.toThrow("Invalid response from other device");
    });

    describe("should be able to connect as a reciprocating device", () => {
        let mockSession: MSC4108RendezvousSession;
        let channel: MSC4108SecureChannel;
        let opponentChannel: EstablishedEcies;

        beforeEach(async () => {
            mockSession = {
                send: jest.fn(),
                receive: jest.fn(),
                url,
            } as unknown as MSC4108RendezvousSession;
            channel = new MSC4108SecureChannel(mockSession);

            const qrCodeData = QrCodeData.fromBytes(await channel.generateCode(QrCodeMode.Reciprocate, baseUrl));
            const { channel: _opponentChannel, initial_message: ciphertext } = new Ecies().establish_outbound_channel(
                qrCodeData.publicKey,
                "MATRIX_QR_CODE_LOGIN_INITIATE",
            );
            opponentChannel = _opponentChannel;

            mocked(mockSession.receive).mockResolvedValue(ciphertext);
            await channel.connect();
            expect(opponentChannel.decrypt(mocked(mockSession.send).mock.calls[0][0])).toBe("MATRIX_QR_CODE_LOGIN_OK");
            mocked(mockSession.send).mockReset();
        });

        it("should be able to securely send encrypted payloads", async () => {
            const payload = {
                type: PayloadType.Secrets,
                protocols: ["a", "b", "c"],
                homeserver: "https://example.org",
            };
            await channel.secureSend(payload);
            expect(mockSession.send).toHaveBeenCalled();
            expect(opponentChannel.decrypt(mocked(mockSession.send).mock.calls[0][0])).toBe(JSON.stringify(payload));
        });

        it("should be able to securely receive encrypted payloads", async () => {
            const payload = {
                type: PayloadType.Secrets,
                protocols: ["a", "b", "c"],
                homeserver: "https://example.org",
            };
            const ciphertext = opponentChannel.encrypt(JSON.stringify(payload));
            mocked(mockSession.receive).mockResolvedValue(ciphertext);
            await expect(channel.secureReceive()).resolves.toEqual(payload);
        });
    });
});
