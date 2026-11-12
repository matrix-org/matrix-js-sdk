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
 * A common interface to the two implementations of the MSC4388 QR code format and secure channel that are available
 * to this SDK, so that tests can pair them up in each role:
 *
 *  - "wasm": the one in `@matrix-org/matrix-sdk-crypto-wasm`, which is what other Matrix clients built on the Rust
 *    SDK use.
 *  - "cleanroom": the one in `src/rendezvous/channels`, written from the text of the MSC, which is what
 *    `MSC4388SecureChannel` uses.
 */

import * as wasmBindings from "@matrix-org/matrix-sdk-crypto-wasm";

import { decodeBase64, encodeUnpaddedBase64 } from "../../../src/base64.ts";
import * as cleanroomChannel from "../../../src/rendezvous/channels/MSC4388HpkeChannel.ts";
import {
    decodeMSC4388QrCode,
    encodeMSC4388QrCode,
    MSC4388QrCodeIntent,
    QR_CODE_PREFIX_UNSTABLE,
} from "../../../src/rendezvous/channels/MSC4388QrCode.ts";

/** The contents of a QR code, less the prefix. */
export interface QrCodeContents {
    intent: MSC4388QrCodeIntent;
    publicKey: Uint8Array;
    rendezvousId: string;
    /** When decoding, this is the base URL that the implementation says was in the QR code. */
    baseUrl: string;
}

/** An established channel. */
export interface Established {
    checkCode: string;
    seal(plaintext: string, aad: Uint8Array): Promise<string>;
    open(message: string, aad: Uint8Array): Promise<string>;
}

/** Device G once it has opened the initial message. */
export interface UnidirectionalRecipient {
    /** The plaintext of the initial message. */
    message: string;
    /** Seals the response. Returns the encoded response and the established channel. */
    respond(initialResponse: string, aad: Uint8Array): Promise<{ initialResponse: string; channel: Established }>;
}

/** Device G: has a key pair and is waiting for the initial message. */
export interface Recipient {
    publicKey: Uint8Array;
    establishChannel(initialMessage: string, aad: Uint8Array): Promise<UnidirectionalRecipient>;
}

/** Device S once it has sealed the initial message. */
export interface UnidirectionalSender {
    /** The encoded initial message. */
    message: string;
    /** Opens the response. Returns the plaintext of the response and the established channel. */
    complete(initialResponse: string, aad: Uint8Array): Promise<{ initialResponse: string; channel: Established }>;
}

export interface Implementation {
    name: string;
    /** Encodes a QR code in the unstable format. */
    encodeQrCode(contents: QrCodeContents): Uint8Array;
    decodeQrCode(bytes: Uint8Array): QrCodeContents;
    /** Device G: generates a key pair. */
    createRecipient(): Promise<Recipient>;
    /** Device S: seals the initial message for the given public key. */
    establishSender(theirPublicKey: Uint8Array, initialMessage: string, aad: Uint8Array): Promise<UnidirectionalSender>;
}

function wrapWasm(channel: wasmBindings.EstablishedHpkeChannel): Established {
    return {
        // this is how the check code is formatted for display when using this implementation
        checkCode: String(channel.checkCode.to_digit()).padStart(2, "0"),
        seal: async (plaintext, aad) => channel.seal(plaintext, aad),
        open: async (message, aad) => channel.open(message, aad),
    };
}

function toWasmPublicKey(publicKey: Uint8Array): wasmBindings.Curve25519PublicKey {
    return new wasmBindings.Curve25519PublicKey(encodeUnpaddedBase64(publicKey));
}

export const wasm: Implementation = {
    name: "wasm",
    encodeQrCode({ intent, publicKey, rendezvousId, baseUrl }) {
        return wasmBindings.QrCodeData.newMsc4388(
            toWasmPublicKey(publicKey),
            rendezvousId,
            baseUrl,
            intent === MSC4388QrCodeIntent.NewDevice
                ? wasmBindings.QrCodeIntent.Login
                : wasmBindings.QrCodeIntent.Reciprocate,
        ).toBytes();
    },
    decodeQrCode(bytes) {
        const qrCodeData = wasmBindings.QrCodeData.fromBytes(bytes);
        const { rendezvousId, baseUrl } = qrCodeData.intentData.msc4388!;
        return {
            intent:
                qrCodeData.mode === wasmBindings.QrCodeIntent.Login
                    ? MSC4388QrCodeIntent.NewDevice
                    : MSC4388QrCodeIntent.ExistingDevice,
            publicKey: decodeBase64(qrCodeData.publicKey.toBase64()),
            rendezvousId,
            baseUrl,
        };
    },
    async createRecipient() {
        const recipient = new wasmBindings.HpkeRecipientChannel();
        return {
            publicKey: decodeBase64(recipient.publicKey.toBase64()),
            async establishChannel(initialMessage, aad) {
                const { message, channel: unidirectional } = recipient.establishChannel(initialMessage, aad);
                return {
                    message,
                    async respond(initialResponse, responseAad) {
                        const result = unidirectional.establishBidirectionalChannel(initialResponse, responseAad);
                        return { initialResponse: result.initialResponse, channel: wrapWasm(result.channel) };
                    },
                };
            },
        };
    },
    async establishSender(theirPublicKey, initialMessage, aad) {
        const { message, channel: unidirectional } = new wasmBindings.HpkeSenderChannel().establishChannel(
            toWasmPublicKey(theirPublicKey),
            initialMessage,
            aad,
        );
        return {
            message,
            async complete(initialResponse, responseAad) {
                const result = unidirectional.establishBidirectionalChannel(initialResponse, responseAad);
                return { initialResponse: result.initialResponse, channel: wrapWasm(result.channel) };
            },
        };
    },
};

export const cleanroom: Implementation = {
    name: "cleanroom",
    encodeQrCode(contents) {
        return encodeMSC4388QrCode({ prefix: QR_CODE_PREFIX_UNSTABLE, ...contents });
    },
    decodeQrCode(bytes) {
        const { intent, publicKey, rendezvousId, baseUrl } = decodeMSC4388QrCode(bytes);
        return { intent, publicKey, rendezvousId, baseUrl };
    },
    async createRecipient() {
        const recipient = await cleanroomChannel.HpkeRecipientChannel.create();
        return {
            publicKey: recipient.publicKey,
            async establishChannel(initialMessage, aad) {
                const { message, channel: unidirectional } = await recipient.establishChannel(initialMessage, aad);
                return {
                    message,
                    async respond(initialResponse, responseAad) {
                        return unidirectional.establishBidirectionalChannel(initialResponse, responseAad);
                    },
                };
            },
        };
    },
    async establishSender(theirPublicKey, initialMessage, aad) {
        const { message, channel: unidirectional } = await new cleanroomChannel.HpkeSenderChannel().establishChannel(
            theirPublicKey,
            initialMessage,
            aad,
        );
        return {
            message,
            async complete(initialResponse, responseAad) {
                return unidirectional.establishBidirectionalChannel(initialResponse, responseAad);
            },
        };
    },
};
