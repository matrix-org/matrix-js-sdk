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

import { xchacha20poly1305 } from "@noble/ciphers/chacha"; // PROTOTYPE: we should use chacha implementation that will be exposed from the matrix rust crypto module

import { RendezvousError, RendezvousIntent, RendezvousFailureReason, MSC4108Payload } from "..";
import { encodeUnpaddedBase64, decodeBase64 } from "../../base64";
import { TextEncoder } from "../../crypto/crypto";
import { QRCodeData } from "../../crypto/verification/QRCode";
import { MSC4108RendezvousSession } from "../transports/MSC4108RendezvousSession";
import { logger } from "../../logger";

function makeNonce(input: number): Uint8Array {
    const nonce = new Uint8Array(24);
    nonce.set([input], 23);
    return nonce;
}

export class MSC4108SecureChannel {
    private ephemeralKeyPair?: CryptoKeyPair;
    private connected = false;
    private EncKey?: CryptoKey;
    private OurNonce = 0;
    private TheirNonce = 0;

    public constructor(
        private rendezvousSession: MSC4108RendezvousSession,
        private theirPublicKey?: CryptoKey,
        public onFailure?: (reason: RendezvousFailureReason) => void,
    ) {}

    public async getKeyPair(): Promise<CryptoKeyPair> {
        if (!this.ephemeralKeyPair) {
            this.ephemeralKeyPair = await global.crypto.subtle.generateKey(
                {
                    name: "ECDH",
                    namedCurve: "P-256", // PROTOTYPE: This should be "Curve25519"
                },
                true,
                ["deriveBits"],
            );
        }

        return this.ephemeralKeyPair;
    }

    public async generateCode(intent: RendezvousIntent, homeserverBaseUrl?: string): Promise<Buffer> {
        const { url } = this.rendezvousSession;

        if (!url) {
            throw new Error("No rendezvous session URL");
        }

        const ephemeralKeyPair = await this.getKeyPair();

        return QRCodeData.createForRendezvous(intent, ephemeralKeyPair.publicKey, url, homeserverBaseUrl);
    }

    public async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Channel already connected");
        }

        const ephemeralKeyPair = await this.getKeyPair();

        const isScanningDevice = this.theirPublicKey;

        if (isScanningDevice) {
            /**
                Secure Channel step 4. Device S sends the initial message

                Nonce := 0
                SH := ECDH(Ss, Gp)
                EncKey := HKDF_SHA256(SH, "MATRIX_QR_CODE_LOGIN|" || Gp || "|" || Sp, 0, 32)
                TaggedCiphertext := ChaCha20Poly1305_Encrypt(EncKey, Nonce, "MATRIX_QR_CODE_LOGIN_INITIATE")
                Nonce := Nonce + 2
                LoginInitiateMessage := UnpaddedBase64(TaggedCiphertext) || "|" || UnpaddedBase64(Sp)
            */
            const Ss = ephemeralKeyPair.privateKey;
            const Sp = ephemeralKeyPair.publicKey;
            const Gp = this.theirPublicKey;
            this.OurNonce = 0;
            this.TheirNonce = 1;

            const SHBits = await global.crypto.subtle.deriveBits(
                {
                    name: "ECDH",
                    public: Gp,
                },
                Ss,
                256,
            );

            const SH = await global.crypto.subtle.importKey(
                "raw",
                SHBits,
                {
                    name: "HKDF",
                    length: 256,
                },
                false,
                ["deriveKey"],
            );

            this.EncKey = await global.crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    hash: "SHA-256",
                    salt: new Uint8Array(0),
                    info: new Int8Array([
                        ...new TextEncoder().encode("MATRIX_QR_CODE_LOGIN|"),
                        ...new Uint8Array(await global.crypto.subtle.exportKey("raw", Gp!)),
                        ...new TextEncoder().encode("|"),
                        ...new Uint8Array(await global.crypto.subtle.exportKey("raw", Sp!)),
                    ]).buffer,
                },
                SH,
                {
                    name: "AES-GCM",
                    length: 256,
                },
                true,
                ["encrypt"],
            );
            {
                const TaggedCiphertext = await this.encrypt(new TextEncoder().encode("MATRIX_QR_CODE_LOGIN_INITIATE"));
                const LoginInitiateMessage =
                    encodeUnpaddedBase64(TaggedCiphertext) +
                    "|" +
                    encodeUnpaddedBase64(await global.crypto.subtle.exportKey("raw", Sp!));
                logger.info("Sending LoginInitiateMessage");
                await this.rendezvousSession.send(LoginInitiateMessage);
            }

            /**
                Secure Channel step 6. Verification by Device S

                Nonce_G := 1
                (TaggedCiphertext, Sp) := Unpack(Message)
                Plaintext := ChaCha20Poly1305_Decrypt(EncKey, Nonce_G, TaggedCiphertext)
                Nonce_G := Nonce_G + 2

                unless Plaintext == "MATRIX_QR_CODE_LOGIN_OK":
                    FAIL

             */
            {
                logger.info("Waiting for LoginOkMessage");
                const TaggedCiphertext = await this.rendezvousSession.receive();

                if (!TaggedCiphertext) {
                    throw new RendezvousError("No response from other device", RendezvousFailureReason.Unknown);
                }
                const CandidateLoginOkMessage = await this.decrypt(decodeBase64(TaggedCiphertext));

                if (new TextDecoder().decode(CandidateLoginOkMessage) !== "MATRIX_QR_CODE_LOGIN_OK") {
                    throw new RendezvousError(
                        "Invalid response from other device",
                        RendezvousFailureReason.DataMismatch,
                    );
                }

                // Step 6 is now complete. We trust the channel
            }
        } else {
            /**
                Secure Channel step 5. Device G confirms

                Nonce_S := 0
                (TaggedCiphertext, Sp) := Unpack(LoginInitiateMessage)
                SH := ECDH(Gs, Sp)
                EncKey := HKDF_SHA256(SH, "MATRIX_QR_CODE_LOGIN|" || Gp || "|" || Sp, 0, 32)
                Plaintext := ChaCha20Poly1305_Decrypt(EncKey, Nonce_S, TaggedCiphertext)
                Nonce_S := Nonce_S + 2

             */
            // wait for the other side to send us their public key
            this.OurNonce = 1;
            this.TheirNonce = 0;
            logger.info("Waiting for LoginInitiateMessage");
            const LoginInitiateMessage = await this.rendezvousSession.receive();
            if (!LoginInitiateMessage) {
                throw new Error("No response from other device");
            }
            const Gs = ephemeralKeyPair.privateKey;
            const Gp = ephemeralKeyPair.publicKey;

            const [TaggedCipherTextEncoded, SpEncoded] = LoginInitiateMessage.split("|");
            const TaggedCiphertext = decodeBase64(TaggedCipherTextEncoded);
            const Sp = await global.crypto.subtle.importKey(
                "raw",
                decodeBase64(SpEncoded),
                { name: "ECDH", namedCurve: "P-256" }, // PROTOTYPE: this should be Curve25519
                true,
                [],
            );

            const SHBits = await global.crypto.subtle.deriveBits(
                {
                    name: "ECDH",
                    public: Sp,
                },
                Gs,
                256,
            );

            const SH = await global.crypto.subtle.importKey(
                "raw",
                SHBits,
                {
                    name: "HKDF",
                    length: 256,
                },
                false,
                ["deriveKey"],
            );

            this.EncKey = await global.crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    hash: "SHA-256",
                    salt: new Uint8Array(0),
                    info: new Int8Array([
                        ...new TextEncoder().encode("MATRIX_QR_CODE_LOGIN|"),
                        ...new Uint8Array(await global.crypto.subtle.exportKey("raw", Gp!)),
                        ...new TextEncoder().encode("|"),
                        ...new Uint8Array(await global.crypto.subtle.exportKey("raw", Sp!)),
                    ]).buffer,
                },
                SH,
                {
                    name: "AES-GCM",
                    length: 256,
                },
                true,
                ["encrypt"],
            );
            const CandidateLoginInitiateMessage = await this.decrypt(TaggedCiphertext);

            if (new TextDecoder().decode(CandidateLoginInitiateMessage) !== "MATRIX_QR_CODE_LOGIN_INITIATE") {
                throw new RendezvousError("Invalid response from other device", RendezvousFailureReason.DataMismatch);
            }

            this.theirPublicKey = Sp;

            logger.info("LoginInitiateMessage received");

            const LoginOkMessage = encodeUnpaddedBase64(
                await this.encrypt(new TextEncoder().encode("MATRIX_QR_CODE_LOGIN_OK")),
            );
            logger.info("Sending LoginOkMessage");
            await this.rendezvousSession.send(LoginOkMessage);

            // Step 5 is complete. We don't yet trust the channel

            // next step will be for the user to confirm that they see a checkmark on the other device
        }

        this.connected = true;
    }

    private async decrypt(TaggedCiphertext: Uint8Array): Promise<Uint8Array> {
        if (!this.EncKey) {
            throw new Error("Shared secret not set up");
        }
        logger.info(`Decrypting with nonce ${this.TheirNonce}`);
        const chacha = xchacha20poly1305(
            new Uint8Array(await global.crypto.subtle.exportKey("raw", this.EncKey)),
            makeNonce(this.TheirNonce),
        );
        this.TheirNonce += 2;
        return chacha.decrypt(TaggedCiphertext);
    }

    private async encrypt(Plaintext: Uint8Array): Promise<Uint8Array> {
        if (!this.EncKey) {
            throw new Error("Shared secret not set up");
        }
        logger.info(`Encrypting with nonce ${this.OurNonce}`);
        const chacha = xchacha20poly1305(
            new Uint8Array(await global.crypto.subtle.exportKey("raw", this.EncKey)),
            makeNonce(this.OurNonce),
        );
        this.OurNonce += 2;
        return chacha.encrypt(Plaintext);
    }

    public async secureSend(payload: MSC4108Payload): Promise<void> {
        if (!this.connected) {
            throw new Error("Channel closed");
        }

        logger.info(`=> ${JSON.stringify(payload)}`);

        await this.rendezvousSession.send(
            encodeUnpaddedBase64(await this.encrypt(new TextEncoder().encode(JSON.stringify(payload)))),
        );
    }

    public async secureReceive(): Promise<Partial<MSC4108Payload> | undefined> {
        if (!this.EncKey) {
            throw new Error("Shared secret not set up");
        }

        const rawData = await this.rendezvousSession.receive();
        if (!rawData) {
            return undefined;
        }
        const ciphertext = decodeBase64(rawData);
        const plaintext = await this.decrypt(ciphertext);

        const json = JSON.parse(new TextDecoder().decode(plaintext));

        logger.info(`<= ${JSON.stringify(json)}`);
        return json as any as Partial<MSC4108Payload>;
    }

    public async close(): Promise<void> {}

    public async cancel(reason: RendezvousFailureReason): Promise<void> {
        try {
            await this.rendezvousSession.cancel(reason);
        } finally {
            await this.close();
        }
    }
}
