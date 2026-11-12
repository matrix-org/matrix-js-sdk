/*
Copyright 2026 Element Creations Ltd.

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

import { HpkeSenderChannel, QrCodeData, QrCodeIntent } from "@matrix-org/matrix-sdk-crypto-wasm";

import { decodeMSC4388QrCode } from "../../../../src/rendezvous/channels/MSC4388QrCode.ts";
import { MSC4388SecureChannel } from "../../../../src/rendezvous/channels/MSC4388SecureChannel.ts";
import {
    encodeStringAsBytes8,
    type MSC4388RendezvousSession,
} from "../../../../src/rendezvous/transports/MSC4388RendezvousSession.ts";

describe("MSC4388SecureChannel", () => {
    const rendezvousId = "01M6H5ZT1YQTBE4FNCW5H535GH";

    /** Builds the additional authentication data the way the scanning device does, from the QR code fields. */
    function buildAad(baseUrl: string, sequenceToken: string): Uint8Array {
        const parts = [baseUrl, rendezvousId, sequenceToken].map(encodeStringAsBytes8);
        return new Uint8Array(parts.flatMap((part) => Array.from(part)));
    }

    function makeMockSession(baseUrl: string): MSC4388RendezvousSession {
        return {
            id: rendezvousId,
            baseUrl,
            send: vi.fn(),
            receive: vi.fn(),
            getAdditionalAuthenticationDataForSend: vi.fn((qrCodeBaseUrl: string) => buildAad(qrCodeBaseUrl, "1")),
            getAdditionalAuthenticationDataForReceive: vi.fn((qrCodeBaseUrl: string) => buildAad(qrCodeBaseUrl, "0")),
        } as unknown as MSC4388RendezvousSession;
    }

    it("should bind the secure channel to the base URL exactly as encoded in the QR code", async () => {
        // a base URL which URL parsing would change, by adding a trailing slash
        const mockSession = makeMockSession("https://example.com");
        const channel = new MSC4388SecureChannel(mockSession, QrCodeIntent.Reciprocate);

        const code = await channel.generateCode();

        // act as the scanning device, which uses the base URL from the QR code in the additional authentication data
        const qrCodeBaseUrl = decodeMSC4388QrCode(code).baseUrl;
        expect(qrCodeBaseUrl).toBe("https://example.com");
        const { message } = new HpkeSenderChannel().establishChannel(
            QrCodeData.fromBytes(code).publicKey,
            "MATRIX_QR_CODE_LOGIN_INITIATE",
            buildAad(qrCodeBaseUrl, "0"),
        );
        vi.mocked(mockSession.receive).mockResolvedValue(message);

        await channel.connect();

        expect(mockSession.getAdditionalAuthenticationDataForReceive).toHaveBeenCalledWith("https://example.com");
        expect(mockSession.getAdditionalAuthenticationDataForSend).toHaveBeenCalledWith("https://example.com");
        expect(mockSession.send).toHaveBeenCalled();
    });

    it("should reject a LoginInitiateMessage bound to a different base URL", async () => {
        const mockSession = makeMockSession("https://example.com");
        const channel = new MSC4388SecureChannel(mockSession, QrCodeIntent.Reciprocate);

        // act as a scanning device which normalises the base URL from the QR code, as the base URL getter of
        // @matrix-org/matrix-sdk-crypto-wasm 19.0.0 does
        const qrCodeData = QrCodeData.fromBytes(await channel.generateCode());
        const qrCodeBaseUrl = qrCodeData.intentData.msc4388!.baseUrl;
        expect(qrCodeBaseUrl).toBe("https://example.com/");
        const { message } = new HpkeSenderChannel().establishChannel(
            qrCodeData.publicKey,
            "MATRIX_QR_CODE_LOGIN_INITIATE",
            buildAad(qrCodeBaseUrl, "0"),
        );
        vi.mocked(mockSession.receive).mockResolvedValue(message);

        await expect(channel.connect()).rejects.toThrow("Invalid response from other device");
    });

    it("should refuse to connect before the QR code is generated", async () => {
        const mockSession = makeMockSession("https://example.com");
        const channel = new MSC4388SecureChannel(mockSession, QrCodeIntent.Reciprocate);
        vi.mocked(mockSession.receive).mockResolvedValue("ciphertext");

        await expect(channel.connect()).rejects.toThrow("QR code not generated");
    });
});
