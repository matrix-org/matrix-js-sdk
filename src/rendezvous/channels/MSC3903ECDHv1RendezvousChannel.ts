/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { SAS } from '@matrix-org/olm';
import { TextEncoder } from 'util';

import {
    RendezvousError,
    RendezvousCode,
    RendezvousIntent,
    RendezvousChannel,
    RendezvousTransportDetails,
    RendezvousTransport,
    RendezvousFailureReason,
    RendezvousChannelAlgorithm,
} from '..';
import { encodeBase64, decodeBase64 } from '../../crypto/olmlib';
import { getCrypto } from '../../utils';
import { generateDecimalSas } from '../../crypto/verification/SASDecimal';

const subtleCrypto = (typeof window !== "undefined" && window.crypto) ?
    (window.crypto.subtle || window.crypto.webkitSubtle) : null;

export interface ECDHv1RendezvousCode extends RendezvousCode {
    rendezvous: {
        transport: RendezvousTransportDetails;
        algorithm: RendezvousChannelAlgorithm.ECDH_V1;
        key: string;
    };
}

interface ECDHPayload {
    algorithm?: RendezvousChannelAlgorithm.ECDH_V1;
    key?: string;
    iv?: string;
    ciphertext?: string;
}

async function importKey(key: Uint8Array): Promise<CryptoKey | Uint8Array> {
    if (getCrypto()) {
        return key;
    }

    if (!subtleCrypto) {
        throw new Error('Neither Web Crypto nor Node.js crypto are available');
    }

    const imported = subtleCrypto.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );

    return imported;
}

/**
 * Implementation of the unstable [MSC3903](https://github.com/matrix-org/matrix-spec-proposals/pull/3903)
 * X25519/ECDH key agreement based secure rendezvous channel.
 * Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC3903ECDHv1RendezvousChannel implements RendezvousChannel {
    private olmSAS?: SAS;
    private ourPublicKey: Uint8Array;
    private aesKey?: CryptoKey | Uint8Array;

    public constructor(
        public transport: RendezvousTransport,
        private theirPublicKey?: Uint8Array,
        public onFailure?: (reason: RendezvousFailureReason) => void,
    ) {
        this.olmSAS = new global.Olm.SAS();
        this.ourPublicKey = decodeBase64(this.olmSAS.get_pubkey());
    }

    public async generateCode(intent: RendezvousIntent): Promise<ECDHv1RendezvousCode> {
        if (this.transport.ready) {
            throw new Error('Code already generated');
        }

        await this.send({ algorithm: RendezvousChannelAlgorithm.ECDH_V1 });

        const rendezvous: ECDHv1RendezvousCode = {
            "rendezvous": {
                algorithm: RendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(this.ourPublicKey),
                transport: await this.transport.details(),
            },
            intent,
        };

        return rendezvous;
    }

    public async connect(): Promise<string> {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const isInitiator = !this.theirPublicKey;

        if (isInitiator) {
            // wait for the other side to send us their public key
            const res = await this.receive() as ECDHPayload | undefined;
            if (!res) {
                throw new Error('No response from other device');
            }
            const { key, algorithm } = res;

            if (algorithm !== RendezvousChannelAlgorithm.ECDH_V1 || !key) {
                throw new RendezvousError(
                    'Unsupported algorithm: ' + algorithm,
                    RendezvousFailureReason.UnsupportedAlgorithm,
                );
            }

            this.theirPublicKey = decodeBase64(key);
        } else {
            // send our public key unencrypted
            await this.send({
                algorithm: RendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(this.ourPublicKey),
            });
        }

        this.olmSAS.set_their_key(encodeBase64(this.theirPublicKey!));

        const initiatorKey = isInitiator ? this.ourPublicKey : this.theirPublicKey!;
        const recipientKey = isInitiator ? this.theirPublicKey! : this.ourPublicKey;
        let aesInfo = RendezvousChannelAlgorithm.ECDH_V1.toString();
        aesInfo += `|${encodeBase64(initiatorKey)}`;
        aesInfo += `|${encodeBase64(recipientKey)}`;

        const aesKeyBytes = this.olmSAS.generate_bytes(aesInfo, 32);

        this.aesKey = await importKey(aesKeyBytes);

        const rawChecksum = this.olmSAS.generate_bytes(aesInfo, 5);
        return generateDecimalSas(Array.from(rawChecksum)).join('-');
    }

    private async encrypt(data: string): Promise<ECDHPayload> {
        if (this.aesKey instanceof Uint8Array) {
            const crypto = getCrypto();

            const iv = crypto.randomBytes(32);
            const cipher = crypto.createCipheriv("aes-256-gcm", this.aesKey as Uint8Array, iv, { authTagLength: 16 });
            const ciphertext = Buffer.concat([
                cipher.update(data, "utf8"),
                cipher.final(),
                cipher.getAuthTag(),
            ]);

            return {
                iv: encodeBase64(iv),
                ciphertext: encodeBase64(ciphertext),
            };
        }

        if (!subtleCrypto) {
            throw new Error('Neither Web Crypto nor Node.js crypto are available');
        }

        const iv = new Uint8Array(32);
        window.crypto.getRandomValues(iv);

        const encodedData = new TextEncoder().encode(data);

        const ciphertext = await subtleCrypto.encrypt(
            {
                name: "AES-GCM",
                iv,
                tagLength: 128,
            },
            this.aesKey as CryptoKey,
            encodedData,
        );

        return {
            iv: encodeBase64(iv),
            ciphertext: encodeBase64(ciphertext),
        };
    }

    public async send(payload: object) {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const data = this.aesKey ? await this.encrypt(JSON.stringify(payload)) : payload;

        await this.transport.send(data);
    }

    private async decrypt({ iv, ciphertext }: ECDHPayload): Promise<ECDHPayload> {
        if (!ciphertext || !iv) {
            throw new Error('Missing ciphertext and/or iv');
        }

        const ciphertextBytes = decodeBase64(ciphertext);

        if (this.aesKey instanceof Uint8Array) {
            const crypto = getCrypto();
            // in contrast to Web Crypto API, Node's crypto needs the auth tag split off the cipher text
            const ciphertextOnly = ciphertextBytes.slice(0, ciphertextBytes.length - 16);
            const authTag = ciphertextBytes.slice(ciphertextBytes.length - 16);
            const decipher = crypto.createDecipheriv(
                "aes-256-gcm", this.aesKey as Uint8Array, decodeBase64(iv), { authTagLength: 16 },
            );
            decipher.setAuthTag(authTag);
            return JSON.parse(
                decipher.update(encodeBase64(ciphertextOnly), "base64", "utf-8") + decipher.final("utf-8"),
            );
        }

        if (!subtleCrypto) {
            throw new Error('Neither Web Crypto nor Node.js crypto are available');
        }

        const plaintext = await subtleCrypto.decrypt(
            {
                name: "AES-GCM",
                iv: decodeBase64(iv),
                tagLength: 128,
            },
            this.aesKey as CryptoKey,
            ciphertextBytes,
        );

        return JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)));
    }

    public async receive(): Promise<object> {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const data = await this.transport.receive() as ECDHPayload | undefined;
        if (!data) {
            return undefined;
        }

        if (data.ciphertext) {
            if (!this.aesKey) {
                throw new Error('Shared secret not set up');
            }
            return this.decrypt(data);
        } else if (this.aesKey) {
            throw new Error('Data received but no ciphertext');
        }

        return data;
    }

    public async close() {
        if (this.olmSAS) {
            this.olmSAS.free();
            this.olmSAS = undefined;
        }
    }

    public async cancel(reason: RendezvousFailureReason) {
        try {
            await this.transport.cancel(reason);
        } finally {
            await this.close();
        }
    }
}
