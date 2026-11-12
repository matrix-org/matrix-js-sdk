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

import { QrCodeData, QrCodeIntent } from "@matrix-org/matrix-sdk-crypto-wasm";

import { ClientPrefix, type IHttpOpts, type MatrixClient, MatrixHttpApi } from "../../../src";
import { decodeBase64, encodeUnpaddedBase64 } from "../../../src/base64.ts";
import { MSC4388SecureChannel } from "../../../src/rendezvous/channels/MSC4388SecureChannel.ts";
import {
    decodeMSC4388QrCode,
    encodeMSC4388QrCode,
    MSC4388QrCodeIntent,
    QR_CODE_PREFIX_STABLE,
    QR_CODE_PREFIX_UNSTABLE,
} from "../../../src/rendezvous/channels/MSC4388QrCode.ts";
import { MSC4388RendezvousSession } from "../../../src/rendezvous/transports/MSC4388RendezvousSession.ts";
import { type MSC4108v2025Payload, PayloadType } from "../../../src/rendezvous/MSC4108v2025SignInWithQR.ts";
import { cleanroom, type Established, type Implementation, wasm } from "../../test-utils/msc4388/implementations.ts";
import {
    buildAdditionalAuthenticationData,
    FakeRendezvousServer,
    ScanningDevice,
} from "../../test-utils/msc4388/rendezvous.ts";

/**
 * These tests check that the implementation of the MSC4388 QR code format and secure channel in
 * `src/rendezvous/channels`, which was written from the text of the MSC (referred to as "cleanroom" below),
 * interoperates with the one in `@matrix-org/matrix-sdk-crypto-wasm` (referred to as "wasm" below).
 */
describe("MSC4388 interoperability", () => {
    function hex(input: string): Uint8Array {
        return Uint8Array.from(input.match(/[0-9a-fA-F]{2}/g)!, (byte) => parseInt(byte, 16));
    }

    describe("QR code format", () => {
        // The examples from the MSC
        const publicKey = decodeBase64("2IZoarIZe3gOMAqdSiFHSAcA15KfOasxueUUNwJI7Ws");
        const rendezvousId = "e8da6355-550b-4a32-a193-1619d9830668";
        const baseUrl = "https://matrix-client.matrix.org";
        const exampleBody = `
            d8 86 68 6a b2 19 7b 78 0e 30 0a 9d 4a 21 47 48 07 00 d7 92 9f 39 ab 31 b9 e5 14 37 02 48 ed 6b
            24
            65 38 64 61 36 33 35 35 2D 35 35 30 62 2D 34 61 33 32 2D 61 31 39 33 2D 31 36 31 39 64 39 38 33 30 36 36 38
            20
            68 74 74 70 73 3A 2F 2F 6D 61 74 72 69 78 2D 63 6C 69 65 6E 74 2E 6d 61 74 72 69 78 2e 6f 72 67`;
        const stablePrefix = "4D 41 54 52 49 58";
        const unstablePrefix = "49 4F 5F 45 4C 45 4D 45 4E 54 5F 4D 53 43 34 33 38 38";

        describe.each([
            {
                name: "new device, stable",
                bytes: hex(`${stablePrefix} 03 00 ${exampleBody}`),
                prefix: QR_CODE_PREFIX_STABLE,
                intent: MSC4388QrCodeIntent.NewDevice,
            },
            {
                name: "existing device, stable",
                bytes: hex(`${stablePrefix} 03 01 ${exampleBody}`),
                prefix: QR_CODE_PREFIX_STABLE,
                intent: MSC4388QrCodeIntent.ExistingDevice,
            },
            {
                name: "existing device, unstable",
                bytes: hex(`${unstablePrefix} 03 01 ${exampleBody}`),
                prefix: QR_CODE_PREFIX_UNSTABLE,
                intent: MSC4388QrCodeIntent.ExistingDevice,
            },
        ] as const)("example from the MSC: $name", ({ bytes, prefix, intent }) => {
            it("is encoded by cleanroom", () => {
                expect(encodeMSC4388QrCode({ prefix, intent, publicKey, rendezvousId, baseUrl })).toEqual(bytes);
            });

            it("is decoded by cleanroom", () => {
                expect(decodeMSC4388QrCode(bytes)).toEqual({ prefix, intent, publicKey, rendezvousId, baseUrl });
            });
        });

        it("the unstable example from the MSC is decoded by wasm", () => {
            const contents = wasm.decodeQrCode(hex(`${unstablePrefix} 03 01 ${exampleBody}`));
            expect(contents.intent).toBe(MSC4388QrCodeIntent.ExistingDevice);
            expect(contents.publicKey).toEqual(publicKey);
            expect(contents.rendezvousId).toBe(rendezvousId);
            // see "known divergence" below
            expect(contents.baseUrl).toBe(baseUrl + "/");
        });

        /**
         * The MSC says that the base URL is put in the additional authentication data of the secure channel exactly
         * as it is encoded in the QR code. wasm instead parses it as a URL, both when encoding and when decoding a QR
         * code, which changes it if it is not already in the form that the URL parser produces. A device which scans
         * a QR code containing such a base URL using wasm will fail to establish the secure channel with a device
         * that follows the MSC to the letter.
         *
         * `MSC4388SecureChannel` avoids the problem by only generating QR codes with a base URL that wasm leaves
         * alone. These tests are here to record the behaviour and to notice when it changes: if they fail after an
         * upgrade of `@matrix-org/matrix-sdk-crypto-wasm` (see
         * https://github.com/matrix-org/matrix-sdk-crypto-wasm/pull/364) then delete them, move their base URLs to
         * the list of the tests below, and consider removing the workaround from `MSC4388SecureChannel`.
         */
        describe.each([
            { url: "https://matrix-client.matrix.org", normalised: "https://matrix-client.matrix.org/" },
            { url: "https://example.com:8448", normalised: "https://example.com:8448/" },
            { url: "https://EXAMPLE.com:443/base/path", normalised: "https://example.com/base/path" },
        ])("known divergence: wasm normalises the base URL $url", ({ url, normalised }) => {
            const contents = { intent: MSC4388QrCodeIntent.ExistingDevice, publicKey, rendezvousId, baseUrl: url };

            it("when encoding a QR code", () => {
                expect(cleanroom.decodeQrCode(cleanroom.encodeQrCode(contents)).baseUrl).toBe(url);
                expect(cleanroom.decodeQrCode(wasm.encodeQrCode(contents)).baseUrl).toBe(normalised);
            });

            it("when decoding a QR code", () => {
                expect(wasm.decodeQrCode(cleanroom.encodeQrCode(contents)).baseUrl).toBe(normalised);
            });

            it("in the same way as MSC4388SecureChannel does", () => {
                expect(new URL(url).href).toBe(normalised);
            });
        });

        it.each([
            ["a truncated public key", `${unstablePrefix} 03 01 d8 86 68`],
            ["a truncated base URL", `${unstablePrefix} 03 01 ${exampleBody}`.slice(0, -3)],
            ["trailing data", `${unstablePrefix} 03 01 ${exampleBody} 00`],
            ["an unknown prefix", `4D 41 54 52 49 59 03 01 ${exampleBody}`],
            ["an unknown type", `${unstablePrefix} 02 01 ${exampleBody}`],
            ["an unknown intent", `${unstablePrefix} 03 02 ${exampleBody}`],
        ])("cleanroom rejects a QR code with %s", (_name, input) => {
            expect(() => decodeMSC4388QrCode(hex(input))).toThrow();
        });

        it("cleanroom rejects contents which cannot be encoded", () => {
            const qrCode = {
                prefix: QR_CODE_PREFIX_UNSTABLE,
                intent: MSC4388QrCodeIntent.NewDevice,
                publicKey,
                rendezvousId,
                baseUrl,
            } as const;
            expect(() => encodeMSC4388QrCode({ ...qrCode, publicKey: publicKey.slice(1) })).toThrow();
            expect(() => encodeMSC4388QrCode({ ...qrCode, rendezvousId: "x".repeat(256) })).toThrow();
            expect(() => encodeMSC4388QrCode({ ...qrCode, baseUrl: `https://${"x".repeat(248)}` })).toThrow();
        });

        describe.each([
            { name: "new device", intent: MSC4388QrCodeIntent.NewDevice },
            { name: "existing device", intent: MSC4388QrCodeIntent.ExistingDevice },
        ])("for intent: $name", ({ intent }) => {
            describe.each([
                "https://matrix-client.matrix.org/",
                "https://example.com:8448/",
                "https://example.com/base/path",
                "https://example.com/base/path/",
            ])("and base URL %s", (url) => {
                const contents = { intent, publicKey, rendezvousId, baseUrl: url };

                it("wasm and cleanroom encode the QR code identically", () => {
                    expect(wasm.encodeQrCode(contents)).toEqual(cleanroom.encodeQrCode(contents));
                });

                it("cleanroom decodes the QR code from wasm", () => {
                    const bytes = wasm.encodeQrCode(contents);
                    // n.b. compare with what wasm says it put in the QR code
                    expect(cleanroom.decodeQrCode(bytes)).toEqual(wasm.decodeQrCode(bytes));
                });

                it("wasm decodes the QR code from cleanroom", () => {
                    expect(wasm.decodeQrCode(cleanroom.encodeQrCode(contents))).toEqual(contents);
                });
            });
        });
    });

    describe("secure channel", () => {
        const aadFor = (sequenceToken: string): Uint8Array =>
            buildAdditionalAuthenticationData("https://example.com/", "01M6H5ZT1YQTBE4FNCW5H535GH", sequenceToken);

        /** Flips a bit in the last byte of a message. */
        function tamper(message: string): string {
            const bytes = decodeBase64(message);
            bytes[bytes.length - 1] ^= 0x01;
            return encodeUnpaddedBase64(bytes);
        }

        describe.each([
            // the two that matter: each implementation in each role against the other
            { deviceG: cleanroom, deviceS: wasm },
            { deviceG: wasm, deviceS: cleanroom },
            // and as a sanity check of the tests, each implementation against itself
            { deviceG: cleanroom, deviceS: cleanroom },
            { deviceG: wasm, deviceS: wasm },
        ])("with $deviceG.name as Device G and $deviceS.name as Device S", ({ deviceG, deviceS }) => {
            async function establish(): Promise<{ g: Established; s: Established }> {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(
                    recipient.publicKey,
                    "MATRIX_QR_CODE_LOGIN_INITIATE",
                    aadFor("1"),
                );
                const unidirectional = await recipient.establishChannel(sender.message, aadFor("1"));
                expect(unidirectional.message).toBe("MATRIX_QR_CODE_LOGIN_INITIATE");

                const response = await unidirectional.respond("MATRIX_QR_CODE_LOGIN_OK", aadFor("2"));
                const completed = await sender.complete(response.initialResponse, aadFor("2"));
                expect(completed.initialResponse).toBe("MATRIX_QR_CODE_LOGIN_OK");

                return { g: response.channel, s: completed.channel };
            }

            it("establishes a channel with matching check codes", async () => {
                // the check code is only two digits, so repeat to be sure that a match is not by chance
                for (let i = 0; i < 20; i++) {
                    const { g, s } = await establish();
                    expect(s.checkCode).toMatch(/^[1-9][0-9]$/);
                    expect(g.checkCode).toBe(s.checkCode);
                }
            });

            it("exchanges payloads in both directions", async () => {
                const { g, s } = await establish();

                // more than one payload in each direction, to check that the nonces advance in step
                const exchanges: { from: Established; to: Established; plaintext: string }[] = [
                    // Device G can send twice in a row: its response and then its first payload
                    { from: g, to: s, plaintext: '{"type":"m.login.protocols"}' },
                    { from: s, to: g, plaintext: '{"type":"m.login.protocol"}' },
                    { from: g, to: s, plaintext: '{"type":"m.login.protocol_accepted"}' },
                    { from: s, to: g, plaintext: "" },
                    { from: s, to: g, plaintext: "Ünïcödé ✅ 🔐" },
                    { from: g, to: s, plaintext: "x".repeat(3000) },
                    { from: g, to: s, plaintext: "Ünïcödé ✅ 🔐" },
                    { from: s, to: g, plaintext: '{"type":"m.login.success"}' },
                ];
                let sequenceToken = 3;
                for (const { from, to, plaintext } of exchanges) {
                    const aad = aadFor(String(sequenceToken++));
                    const message = await from.seal(plaintext, aad);
                    expect(message).toMatch(/^[A-Za-z0-9+/]+$/);
                    expect(await to.open(message, aad)).toBe(plaintext);
                }
            });

            it("supports empty additional authentication data", async () => {
                const { g, s } = await establish();
                const empty = new Uint8Array();
                expect(await s.open(await g.seal("from G", empty), empty)).toBe("from G");
                expect(await g.open(await s.seal("from S", empty), empty)).toBe("from S");
            });

            it("Device G rejects an initial message bound to different additional authentication data", async () => {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                await expect(recipient.establishChannel(sender.message, aadFor("2"))).rejects.toThrow();
            });

            it("Device G rejects an initial message which has been tampered with", async () => {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                await expect(recipient.establishChannel(tamper(sender.message), aadFor("1"))).rejects.toThrow();
            });

            it("Device G rejects an initial message for a different public key", async () => {
                const recipient = await deviceG.createRecipient();
                const otherRecipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(otherRecipient.publicKey, "INITIATE", aadFor("1"));
                await expect(recipient.establishChannel(sender.message, aadFor("1"))).rejects.toThrow();
            });

            it("Device S rejects a response bound to different additional authentication data", async () => {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                const unidirectional = await recipient.establishChannel(sender.message, aadFor("1"));
                const response = await unidirectional.respond("OK", aadFor("2"));
                await expect(sender.complete(response.initialResponse, aadFor("3"))).rejects.toThrow();
            });

            it("Device S rejects a response which has been tampered with", async () => {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                const unidirectional = await recipient.establishChannel(sender.message, aadFor("1"));
                const response = await unidirectional.respond("OK", aadFor("2"));
                await expect(sender.complete(tamper(response.initialResponse), aadFor("2"))).rejects.toThrow();
            });

            it("Device S rejects a response to a different initial message", async () => {
                const recipient = await deviceG.createRecipient();
                const sender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                const otherSender = await deviceS.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
                const unidirectional = await recipient.establishChannel(otherSender.message, aadFor("1"));
                const response = await unidirectional.respond("OK", aadFor("2"));
                await expect(sender.complete(response.initialResponse, aadFor("2"))).rejects.toThrow();
            });

            it("rejects payloads bound to different additional authentication data", async () => {
                const { g, s } = await establish();
                await expect(s.open(await g.seal("from G", aadFor("3")), aadFor("4"))).rejects.toThrow();
                await expect(g.open(await s.seal("from S", aadFor("3")), aadFor("4"))).rejects.toThrow();
            });

            it("rejects payloads which have been tampered with", async () => {
                const { g, s } = await establish();
                await expect(s.open(tamper(await g.seal("from G", aadFor("3"))), aadFor("3"))).rejects.toThrow();
                await expect(g.open(tamper(await s.seal("from S", aadFor("3"))), aadFor("3"))).rejects.toThrow();
            });

            it("rejects payloads which are replayed or reflected", async () => {
                const { g, s } = await establish();
                const fromG = await g.seal("from G", aadFor("3"));
                const fromS = await s.seal("from S", aadFor("3"));
                expect(await s.open(fromG, aadFor("3"))).toBe("from G");
                expect(await g.open(fromS, aadFor("3"))).toBe("from S");

                // replayed to the device that has already received it
                await expect(s.open(fromG, aadFor("3"))).rejects.toThrow();
                await expect(g.open(fromS, aadFor("3"))).rejects.toThrow();
                // reflected back to the device that sent it
                await expect(g.open(fromG, aadFor("3"))).rejects.toThrow();
                await expect(s.open(fromS, aadFor("3"))).rejects.toThrow();
            });
        });

        it("cleanroom Device G accepts at most one initial message", async () => {
            const recipient = await cleanroom.createRecipient();
            const sender = await cleanroom.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));

            // whether the first one was rejected...
            await expect(recipient.establishChannel(sender.message, aadFor("2"))).rejects.toThrow();
            await expect(recipient.establishChannel(sender.message, aadFor("1"))).rejects.toThrow("discarded");

            // ...or accepted
            const otherRecipient = await cleanroom.createRecipient();
            const otherSender = await cleanroom.establishSender(otherRecipient.publicKey, "INITIATE", aadFor("1"));
            await otherRecipient.establishChannel(otherSender.message, aadFor("1"));
            await expect(otherRecipient.establishChannel(otherSender.message, aadFor("1"))).rejects.toThrow(
                "discarded",
            );
        });

        it.each([
            ["padded base64", (message: string) => message + "=".repeat((4 - (message.length % 4)) % 4 || 4)],
            ["URL-safe base64", (message: string) => message.replace(/[+/]/g, "") + "-_"],
            ["a message that is too short", (message: string) => message.slice(0, 60)],
        ])("cleanroom rejects %s", async (_name, mangle) => {
            const recipient = await cleanroom.createRecipient();
            const sender = await cleanroom.establishSender(recipient.publicKey, "INITIATE", aadFor("1"));
            await expect(recipient.establishChannel(mangle(sender.message), aadFor("1"))).rejects.toThrow();
        });
    });

    describe("MSC4388SecureChannel and MSC4388RendezvousSession as the device generating the QR code", () => {
        function makeClient(server: FakeRendezvousServer): MatrixClient {
            let txnCounter = 0;
            const client = {
                baseUrl: server.baseUrl,
                makeTxnId: () => `txnG${txnCounter++}`,
            } as unknown as MatrixClient;
            client.http = new MatrixHttpApi<IHttpOpts & { onlyData: true }>(client, {
                baseUrl: server.baseUrl,
                prefix: ClientPrefix.Unstable,
                onlyData: true,
                fetchFn: server.fetch,
            });
            return client;
        }

        async function setup(
            scanningImplementation: Implementation,
            baseUrl: string,
            intent: QrCodeIntent,
        ): Promise<{ server: FakeRendezvousServer; channel: MSC4388SecureChannel; deviceS: ScanningDevice }> {
            const server = new FakeRendezvousServer(baseUrl);
            const session = new MSC4388RendezvousSession({ client: makeClient(server) });
            const channel = new MSC4388SecureChannel(session, intent);

            // this is what the SDK does to start the flow: create the rendezvous session and generate the QR code
            await session.send("");
            const qrCodeBytes = await channel.generateCode();

            const deviceS = new ScanningDevice(scanningImplementation, qrCodeBytes, server.fetch);
            expect(deviceS.qrCode.rendezvousId).toBe(session.id);

            return { server, channel, deviceS };
        }

        const protocols: MSC4108v2025Payload & Record<string, unknown> = {
            type: PayloadType.Protocols,
            protocols: ["device_authorization_grant"],
            base_url: "https://example.com",
        };
        const protocol: MSC4108v2025Payload & Record<string, unknown> = {
            type: PayloadType.Protocol,
            protocol: "device_authorization_grant",
            device_id: "ABCDEFGH",
        };
        const protocolAccepted: MSC4108v2025Payload = { type: PayloadType.ProtocolAccepted };
        const success: MSC4108v2025Payload = { type: PayloadType.Success };

        describe.each([wasm, cleanroom])("with $name as the device scanning the QR code", (implementation) => {
            describe.each([
                // FIXME: only test base URLs which URL parsing leaves unchanged for now, as the wasm scanning device
                // normalises the base URL from the QR code
                // "https://example.com",
                "https://example.com/",
                // "https://example.com:8448",
                "https://example.com/base/path",
                "https://example.com/base/path/",
            ])("and base URL %s", (baseUrl) => {
                it("generates the QR code that wasm would", async () => {
                    const { channel, deviceS } = await setup(implementation, baseUrl, QrCodeIntent.Reciprocate);
                    const qrCodeBytes = await channel.generateCode();

                    // both implementations agree on what is in it
                    expect(wasm.decodeQrCode(qrCodeBytes)).toEqual(cleanroom.decodeQrCode(qrCodeBytes));
                    expect(QrCodeData.fromBytes(qrCodeBytes).mode).toBe(QrCodeIntent.Reciprocate);
                    // and it is byte for byte what wasm generates for the same session
                    expect(qrCodeBytes).toEqual(wasm.encodeQrCode({ ...deviceS.qrCode, baseUrl }));
                    // generating the QR code again gives the same one, with the same key
                    expect(await channel.generateCode()).toEqual(qrCodeBytes);

                    await channel.close();
                });

                it("the existing device generates the QR code and the new device scans it", async () => {
                    const { server, channel, deviceS } = await setup(implementation, baseUrl, QrCodeIntent.Reciprocate);
                    expect(deviceS.qrCode.intent).toBe(MSC4388QrCodeIntent.ExistingDevice);

                    await deviceS.sendLoginInitiate();
                    await channel.connect();
                    const checkCode = await deviceS.receiveLoginOk();
                    expect(checkCode).toMatch(/^[1-9][0-9]$/);
                    expect(channel.getCheckCode()).toBe(checkCode);

                    // Device G sends twice in a row: LoginOkMessage and then its first payload
                    await channel.secureSend(protocols);
                    expect(await deviceS.secureReceive()).toEqual(protocols);

                    await deviceS.secureSend(protocol);
                    expect(await channel.secureReceive()).toEqual(protocol);

                    await channel.secureSend(protocolAccepted);
                    expect(await deviceS.secureReceive()).toEqual(protocolAccepted);

                    await deviceS.secureSend(success);
                    expect(await channel.secureReceive()).toEqual(success);

                    // nothing was rejected by the homeserver, e.g. for a stale sequence token
                    expect(server.requests.filter(({ status }) => status !== 200)).toEqual([]);
                    // POST by G, then: PUT by S, PUT by G (establishment), PUT by G, PUT by S, PUT by G, PUT by S
                    expect(
                        server.requests.filter(({ method }) => method !== "GET").map(({ method }) => method),
                    ).toEqual(["POST", ...Array(6).fill("PUT")]);

                    await channel.close();
                });

                it("the new device generates the QR code and the existing device scans it", async () => {
                    const { server, channel, deviceS } = await setup(implementation, baseUrl, QrCodeIntent.Login);
                    expect(deviceS.qrCode.intent).toBe(MSC4388QrCodeIntent.NewDevice);

                    await deviceS.sendLoginInitiate();
                    await channel.connect();
                    const checkCode = await deviceS.receiveLoginOk();
                    expect(checkCode).toMatch(/^[1-9][0-9]$/);
                    expect(channel.getCheckCode()).toBe(checkCode);

                    // Device S sends first this time
                    await deviceS.secureSend(protocols);
                    expect(await channel.secureReceive()).toEqual(protocols);

                    await channel.secureSend(protocol);
                    expect(await deviceS.secureReceive()).toEqual(protocol);

                    await deviceS.secureSend(protocolAccepted);
                    expect(await channel.secureReceive()).toEqual(protocolAccepted);

                    await channel.secureSend(success);
                    expect(await deviceS.secureReceive()).toEqual(success);

                    expect(server.requests.filter(({ status }) => status !== 200)).toEqual([]);

                    await channel.close();
                });
            });
        });
    });
});
