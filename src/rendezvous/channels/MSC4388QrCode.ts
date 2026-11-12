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
 * Clean-room implementation of the QR code format from
 * [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4388).
 *
 * This is written from the text of the MSC alone, rather than by reference to the implementation in
 * `@matrix-org/matrix-sdk-crypto-wasm`, so that the two can be used to test the interoperability of each other.
 */

/** The QR code prefix from the "QR code format" section of the MSC. */
export const QR_CODE_PREFIX_STABLE = "MATRIX";
/** The QR code prefix from the "Unstable QR code format" section of the MSC. */
export const QR_CODE_PREFIX_UNSTABLE = "IO_ELEMENT_MSC4388";

/** The QR code type allocated by the MSC. */
const QR_CODE_TYPE = 0x03;

/** The length in bytes of a Curve25519 public key. */
const PUBLIC_KEY_LENGTH = 32;

/**
 * The intent of the device which generated an MSC4388 QR code.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export enum MSC4388QrCodeIntent {
    /** `0x00`: a new device wishing to log in and self-verify. */
    NewDevice = 0x00,
    /** `0x01`: an existing device wishing to facilitate the login of a new device and self-verify that other device. */
    ExistingDevice = 0x01,
}

/**
 * The information carried by an MSC4388 QR code.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export interface MSC4388QrCode {
    /** The prefix that distinguishes the stable and unstable formats. */
    prefix: typeof QR_CODE_PREFIX_STABLE | typeof QR_CODE_PREFIX_UNSTABLE;
    /** The intent of the device generating the QR code. */
    intent: MSC4388QrCodeIntent;
    /** **Gp**: the ephemeral Curve25519 public key of the device generating the QR code, as 32 bytes. */
    publicKey: Uint8Array;
    /** The rendezvous session ID. */
    rendezvousId: string;
    /**
     * The base URL of the homeserver, exactly as it appears in the QR code. This is the value which must be used in
     * the additional authentication data of the secure channel.
     */
    baseUrl: string;
}

/**
 * One byte indicating the length in bytes of the input as a UTF-8 string, followed by the input as a UTF-8 string.
 */
function encodeLengthPrefixedString(input: string, what: string): Uint8Array {
    const utf8 = new TextEncoder().encode(input);
    if (utf8.length > 0xff) {
        throw new Error(`The ${what} is ${utf8.length} bytes which is too long to encode in a QR code`);
    }
    const result = new Uint8Array(1 + utf8.length);
    result[0] = utf8.length;
    result.set(utf8, 1);
    return result;
}

/**
 * Encodes the contents of an MSC4388 QR code as the binary string to be displayed.
 *
 * The base URL is encoded exactly as given: it is not normalised in any way.
 *
 * @throws if the public key is not 32 bytes, or the rendezvous session ID or base URL is longer than 255 bytes
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export function encodeMSC4388QrCode(qrCode: MSC4388QrCode): Uint8Array {
    if (qrCode.publicKey.length !== PUBLIC_KEY_LENGTH) {
        throw new Error(`Public key must be ${PUBLIC_KEY_LENGTH} bytes`);
    }
    const parts = [
        new TextEncoder().encode(qrCode.prefix),
        Uint8Array.of(QR_CODE_TYPE, qrCode.intent),
        qrCode.publicKey,
        encodeLengthPrefixedString(qrCode.rendezvousId, "rendezvous session ID"),
        encodeLengthPrefixedString(qrCode.baseUrl, "base URL"),
    ];
    const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

/**
 * Decodes the binary string read from an MSC4388 QR code.
 *
 * @throws if the bytes are not exactly one well-formed MSC4388 QR code, in either the stable or unstable format
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export function decodeMSC4388QrCode(bytes: Uint8Array): MSC4388QrCode {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;

    const take = (length: number, what: string): Uint8Array => {
        if (offset + length > bytes.length) {
            throw new Error(`QR code is truncated: expected ${length} more byte(s) for the ${what}`);
        }
        const result = bytes.subarray(offset, offset + length);
        offset += length;
        return result;
    };
    const takeString = (what: string): string => {
        const [length] = take(1, `length of the ${what}`);
        return utf8Decoder.decode(take(length, what));
    };

    const prefix = ([QR_CODE_PREFIX_UNSTABLE, QR_CODE_PREFIX_STABLE] as const).find((candidate) => {
        const candidateBytes = new TextEncoder().encode(candidate);
        return bytes.length >= candidateBytes.length && candidateBytes.every((byte, index) => bytes[index] === byte);
    });
    if (!prefix) {
        throw new Error("QR code does not start with a recognised prefix");
    }
    offset += prefix.length;

    const [type] = take(1, "type");
    if (type !== QR_CODE_TYPE) {
        throw new Error(`Unsupported QR code type ${type}`);
    }

    const [intent] = take(1, "intent");
    if (intent !== MSC4388QrCodeIntent.NewDevice && intent !== MSC4388QrCodeIntent.ExistingDevice) {
        throw new Error(`Unknown QR code intent ${intent}`);
    }

    const publicKey = take(PUBLIC_KEY_LENGTH, "public key").slice();
    const rendezvousId = takeString("rendezvous session ID");
    const baseUrl = takeString("base URL");

    if (offset !== bytes.length) {
        throw new Error(`QR code has ${bytes.length - offset} unexpected trailing byte(s)`);
    }

    return { prefix, intent, publicKey, rendezvousId, baseUrl };
}
