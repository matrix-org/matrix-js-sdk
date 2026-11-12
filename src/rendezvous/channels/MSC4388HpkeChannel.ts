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

/*
 * Clean-room implementation of the secure channel from
 * [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4388).
 *
 * This is written from the text of the MSC alone, rather than by reference to the implementation in
 * `@matrix-org/matrix-sdk-crypto-wasm`, so that the two can be used to test the interoperability of each other. The
 * shape of the API follows the HPKE channel classes of that package so that one can be swapped for the other, except
 * that everything here is asynchronous.
 *
 * HPKE itself is not implemented here: the KEM, key schedule, encryption contexts and secret export all come from the
 * [`hpke`](https://github.com/panva/hpke) package, with the primitives (X25519, HKDF-SHA256 and ChaCha20-Poly1305)
 * coming from `@panva/hpke-noble` so that this works in runtimes where the Web Cryptography API lacks them. The only
 * thing done by hand is the Oblivious HTTP style response context ({@link ResponseContext}), which `hpke` has no API
 * to construct; it uses the same KDF and AEAD and follows the nonce computation of RFC 9180 section 5.2.
 */

import * as HPKE from "hpke";
import { AEAD_ChaCha20Poly1305, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from "@panva/hpke-noble";

import { decodeBase64, encodeUnpaddedBase64 } from "../../base64.ts";

/** The length in bytes of a Curve25519 public key, and so of the encapsulated key **Sp**. */
const PUBLIC_KEY_LENGTH = 32;
/** The length in bytes of the **ResponseNonce**. */
const RESPONSE_NONCE_LENGTH = 32;
/** The length in bytes of a ChaCha20-Poly1305 authentication tag. */
const TAG_LENGTH = 16;

/** The `info` used in the HPKE key schedule. */
const INFO = HPKE.encode("MATRIX_QR_CODE_LOGIN");
/** The exporter context used to derive the secret for the response context. */
const RESPONSE_EXPORTER_CONTEXT = HPKE.encode("MATRIX_QR_CODE_LOGIN_RESPONSE");
/** The prefix of the exporter context used to derive the check code. */
const CHECK_CODE_EXPORTER_CONTEXT_PREFIX = HPKE.encode("MATRIX_QR_CODE_LOGIN_CHECKCODE");

/** HPKE in base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305. */
const suite = new HPKE.CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_ChaCha20Poly1305);
const kdf = KDF_HKDF_SHA256();
const aead = AEAD_ChaCha20Poly1305();

function encodeUtf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * The reverse of `UnpaddedBase64` from the MSC.
 *
 * @throws if the input is not unpadded base64 using the standard alphabet
 */
function decodeUnpaddedBase64(encoded: string): Uint8Array {
    if (!/^[A-Za-z0-9+/]*$/.test(encoded) || encoded.length % 4 === 1) {
        throw new Error("Not unpadded base64");
    }
    return decodeBase64(encoded);
}

/**
 * Splits a decoded message in to its leading fixed length part (**Sp** or **ResponseNonce**) and the
 * **TaggedCiphertext** which follows it.
 */
function unpack(message: string, headLength: number): [head: Uint8Array, taggedCiphertext: Uint8Array] {
    const bytes = decodeUnpaddedBase64(message);
    if (bytes.length < headLength + TAG_LENGTH) {
        throw new Error("Message is too short");
    }
    return [bytes.subarray(0, headLength), bytes.subarray(headLength)];
}

/**
 * The context for the direction from Device G to Device S: **Context_DeviceG_Send** on Device G and
 * **Context_DeviceS_Receive** on Device S.
 *
 * ```
 * Secret := Context.Export("MATRIX_QR_CODE_LOGIN_RESPONSE", 32)
 * Salt := Sp || ResponseNonce
 *
 * AeadKey := HKDF_SHA256(Secret, "key", salt=Salt, size=32)
 * AeadNonce := HKDF_SHA256(Secret, "nonce", salt=Salt, size=12)
 * ExporterSecret := [0; 32]
 *
 * Context := Context<ROLE>(AeadKey, AeadNonce, 0, ExporterSecret)
 * ```
 *
 * This is an HPKE encryption context as per RFC 9180 section 5.2, minus the exporter interface which the MSC says
 * MUST NOT be used.
 */
class ResponseContext {
    /**
     * @param primaryContext - **Context_DeviceG_Receive** on Device G or **Context_DeviceS_Send** on Device S
     * @param sp - Device S's ephemeral public key, i.e. the encapsulated key
     * @param responseNonce - the random nonce chosen by Device G
     */
    public static async derive(
        primaryContext: Pick<HPKE.SenderContext, "Export">,
        sp: Uint8Array,
        responseNonce: Uint8Array,
    ): Promise<ResponseContext> {
        const secret = await primaryContext.Export(RESPONSE_EXPORTER_CONTEXT, 32);
        const salt = HPKE.concat(sp, responseNonce);
        const prk = await kdf.Extract(salt, secret);
        const key = await kdf.Expand(prk, HPKE.encode("key"), aead.Nk);
        const baseNonce = await kdf.Expand(prk, HPKE.encode("nonce"), aead.Nn);
        return new ResponseContext(key, baseNonce);
    }

    /** The sequence number: the count of messages successfully sealed or opened so far. */
    private seq = 0;
    /** Ensures that calls are processed one at a time, in the order they are made. */
    private queue: Promise<unknown> = Promise.resolve();

    private constructor(
        private readonly key: Uint8Array,
        private readonly baseNonce: Uint8Array,
    ) {}

    /** `ComputeNonce(seq)`: the base nonce XORed with the sequence number as a big-endian integer. */
    private computeNonce(): Uint8Array {
        const seqBytes = HPKE.I2OSP(this.seq, aead.Nn);
        return this.baseNonce.map((byte, index) => byte ^ seqBytes[index]);
    }

    /** Runs the AEAD operation with the nonce for the current sequence number, which is incremented on success. */
    private next(operation: (nonce: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
        const result = this.queue.then(async () => {
            const output = await operation(this.computeNonce());
            this.seq++;
            return output;
        });
        this.queue = result.catch(() => {});
        return result;
    }

    public seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
        return this.next((nonce) => aead.Seal(this.key, nonce, aad, plaintext));
    }

    public open(aad: Uint8Array, taggedCiphertext: Uint8Array): Promise<Uint8Array> {
        return this.next((nonce) => aead.Open(this.key, nonce, aad, taggedCiphertext));
    }
}

/**
 * ```
 * CheckBytes := Context.Export("MATRIX_QR_CODE_LOGIN_CHECKCODE" || Gp || Sp , size=2)
 * CheckCode := NumToString((CheckBytes[0] % 9) + 1) || NumToString(CheckBytes[1] % 10)
 * ```
 *
 * @param primaryContext - **Context_DeviceG_Receive** on Device G or **Context_DeviceS_Send** on Device S
 */
async function deriveCheckCode(
    primaryContext: Pick<HPKE.SenderContext, "Export">,
    gp: Uint8Array,
    sp: Uint8Array,
): Promise<string> {
    const checkBytes = await primaryContext.Export(HPKE.concat(CHECK_CODE_EXPORTER_CONTEXT_PREFIX, gp, sp), 2);
    return String((checkBytes[0] % 9) + 1) + String(checkBytes[1] % 10);
}

/**
 * The fully established, bidirectional secure channel.
 */
export class EstablishedHpkeChannel {
    /**
     * @param checkCode - the two digit **CheckCode** in the range 10 to 99
     * @param sealBytes - `Seal()` of the context for the direction this device sends in
     * @param openBytes - `Open()` of the context for the direction this device receives in
     */
    public constructor(
        public readonly checkCode: string,
        private readonly sealBytes: (aad: Uint8Array, plaintext: Uint8Array) => Promise<Uint8Array>,
        private readonly openBytes: (aad: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>,
    ) {}

    /** Encrypts a payload for the other device, giving the `data` to send to the rendezvous session. */
    public async seal(plaintext: string, aad: Uint8Array): Promise<string> {
        return encodeUnpaddedBase64(await this.sealBytes(aad, encodeUtf8(plaintext)));
    }

    /** Decrypts the `data` received from the rendezvous session. */
    public async open(message: string, aad: Uint8Array): Promise<string> {
        return decodeUtf8(await this.openBytes(aad, decodeUnpaddedBase64(message)));
    }
}

/**
 * Device S (the device scanning the QR code) before it has sent its initial payload.
 */
export class HpkeSenderChannel {
    /**
     * Step 4 of the establishment: seals the initial payload for the public key from the QR code.
     *
     * ```
     * (Sp, Context_DeviceS_Send) := SetupBaseS(Gp, info="MATRIX_QR_CODE_LOGIN")
     * TaggedCiphertext := Context_DeviceS_Send.Seal(Aad, InitialMessage)
     * LoginInitiateMessage := UnpaddedBase64(Sp || TaggedCiphertext)
     * ```
     *
     * @param theirPublicKey - **Gp**, as 32 bytes
     * @param initialMessage - the plaintext, which for the MSC is `MATRIX_QR_CODE_LOGIN_INITIATE`
     * @param aad - the additional authentication data
     */
    public async establishChannel(
        theirPublicKey: Uint8Array,
        initialMessage: string,
        aad: Uint8Array,
    ): Promise<{ message: string; channel: UnidirectionalSenderChannel }> {
        const gp = theirPublicKey.slice();
        const { encapsulatedSecret: sp, ctx } = await suite.SetupSender(await suite.DeserializePublicKey(gp), {
            info: INFO,
        });
        const taggedCiphertext = await ctx.Seal(encodeUtf8(initialMessage), aad);
        return {
            message: encodeUnpaddedBase64(HPKE.concat(sp, taggedCiphertext)),
            channel: new UnidirectionalSenderChannel(ctx, gp, sp),
        };
    }
}

/**
 * Device S once it has sent its initial payload and is waiting for the response from Device G.
 */
export class UnidirectionalSenderChannel {
    /**
     * @param context - **Context_DeviceS_Send**
     * @param gp - Device G's public key
     * @param sp - Device S's public key
     */
    public constructor(
        private readonly context: HPKE.SenderContext,
        private readonly gp: Uint8Array,
        private readonly sp: Uint8Array,
    ) {}

    /**
     * Step 6 of the establishment: opens the response from Device G.
     *
     * ```
     * (ResponseNonce, TaggedCiphertext) := Unpack(LoginOkMessage)
     * Context_DeviceS_Receive := <see ResponseContext>
     * Plaintext := Context_DeviceS_Receive.Open(Aad, TaggedCiphertext)
     * ```
     *
     * @param initialResponse - the **LoginOkMessage**
     * @param aad - the additional authentication data
     * @returns the plaintext of the response, which the caller must check, and the established channel
     */
    public async establishBidirectionalChannel(
        initialResponse: string,
        aad: Uint8Array,
    ): Promise<{ initialResponse: string; channel: EstablishedHpkeChannel }> {
        const [responseNonce, taggedCiphertext] = unpack(initialResponse, RESPONSE_NONCE_LENGTH);
        const receiveContext = await ResponseContext.derive(this.context, this.sp, responseNonce);
        const plaintext = decodeUtf8(await receiveContext.open(aad, taggedCiphertext));

        const sendContext = this.context;
        return {
            initialResponse: plaintext,
            channel: new EstablishedHpkeChannel(
                await deriveCheckCode(sendContext, this.gp, this.sp),
                (sealAad, payload) => sendContext.Seal(payload, sealAad),
                (openAad, ciphertext) => receiveContext.open(openAad, ciphertext),
            ),
        };
    }
}

/**
 * Device G (the device generating the QR code) before it has received the initial payload from Device S.
 */
export class HpkeRecipientChannel {
    /**
     * Step 1 of the establishment: generates the ephemeral key pair **(Gp, Gs)**.
     */
    public static async create(): Promise<HpkeRecipientChannel> {
        const keyPair = await suite.GenerateKeyPair();
        return new HpkeRecipientChannel(keyPair, await suite.SerializePublicKey(keyPair.publicKey));
    }

    private constructor(
        private keyPair: HPKE.KeyPair | undefined,
        /** **Gp**, as 32 bytes, for inclusion in the QR code. */
        public readonly publicKey: Uint8Array,
    ) {}

    /**
     * The first half of step 5 of the establishment: opens the initial payload from Device S.
     *
     * ```
     * (Sp, TaggedCiphertext) := Unpack(LoginInitiateMessage)
     * Context_DeviceG_Receive := SetupBaseR(Sp, Gs, info="MATRIX_QR_CODE_LOGIN")
     * Plaintext := Context_DeviceG_Receive.Open(Aad, TaggedCiphertext)
     * ```
     *
     * **Gs** is discarded, so this can be called only once whether or not it succeeds.
     *
     * @param initialMessage - the **LoginInitiateMessage**
     * @param aad - the additional authentication data
     * @returns the plaintext of the initial payload, which the caller must check, and the channel to respond with
     */
    public async establishChannel(
        initialMessage: string,
        aad: Uint8Array,
    ): Promise<{ message: string; channel: UnidirectionalRecipientChannel }> {
        const keyPair = this.keyPair;
        if (!keyPair) {
            throw new Error("The private key has been discarded: at most one initial message can be accepted");
        }
        this.keyPair = undefined;

        const [sp, taggedCiphertext] = unpack(initialMessage, PUBLIC_KEY_LENGTH);
        const context = await suite.SetupRecipient(keyPair, sp, { info: INFO });
        const plaintext = decodeUtf8(await context.Open(taggedCiphertext, aad));
        return {
            message: plaintext,
            channel: new UnidirectionalRecipientChannel(context, this.publicKey, sp.slice()),
        };
    }
}

/**
 * Device G once it has received the initial payload from Device S and has yet to respond.
 */
export class UnidirectionalRecipientChannel {
    /**
     * @param context - **Context_DeviceG_Receive**
     * @param gp - Device G's public key
     * @param sp - Device S's public key
     */
    public constructor(
        private readonly context: HPKE.RecipientContext,
        private readonly gp: Uint8Array,
        private readonly sp: Uint8Array,
    ) {}

    /**
     * The second half of step 5 of the establishment: seals the response to Device S.
     *
     * ```
     * ResponseNonce := random(32)
     * Context_DeviceG_Send := <see ResponseContext>
     * TaggedCiphertext := Context_DeviceG_Send.Seal(Aad, InitialResponse)
     * LoginOkMessage := UnpaddedBase64Encode(ResponseNonce || TaggedCiphertext)
     * ```
     *
     * @param initialResponse - the plaintext, which for the MSC is `MATRIX_QR_CODE_LOGIN_OK`
     * @param aad - the additional authentication data
     * @returns the **LoginOkMessage** and the established channel
     */
    public async establishBidirectionalChannel(
        initialResponse: string,
        aad: Uint8Array,
    ): Promise<{ initialResponse: string; channel: EstablishedHpkeChannel }> {
        const responseNonce = globalThis.crypto.getRandomValues(new Uint8Array(RESPONSE_NONCE_LENGTH));
        const sendContext = await ResponseContext.derive(this.context, this.sp, responseNonce);
        const taggedCiphertext = await sendContext.seal(aad, encodeUtf8(initialResponse));

        const receiveContext = this.context;
        return {
            initialResponse: encodeUnpaddedBase64(HPKE.concat(responseNonce, taggedCiphertext)),
            channel: new EstablishedHpkeChannel(
                await deriveCheckCode(receiveContext, this.gp, this.sp),
                (sealAad, payload) => sendContext.seal(sealAad, payload),
                (openAad, ciphertext) => receiveContext.Open(ciphertext, openAad),
            ),
        };
    }
}
