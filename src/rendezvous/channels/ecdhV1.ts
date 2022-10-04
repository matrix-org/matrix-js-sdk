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

import * as ed from '@noble/ed25519';

import { logger } from '../../logger';
import { MatrixClient } from '../../matrix';
import { RendezvousError } from '../error';
import {
    RendezvousCancellationReason, RendezvousTransport, RendezvousChannel, RendezvousCode, RendezvousTransportDetails,
} from '../index';
import { SecureRendezvousChannelAlgorithm } from '.';
import { encodeBase64, decodeBase64 } from '../../crypto/olmlib';
import { decryptAESGCM, encryptAESGCM } from '../../crypto/aesGcm';

const subtleCrypto = (typeof window !== "undefined" && window.crypto) ?
    (window.crypto.subtle || window.crypto.webkitSubtle) : null;

export interface ECDHv1RendezvousCode extends RendezvousCode {
    rendezvous: {
        transport: RendezvousTransportDetails;
        algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1;
        key: string;
    };
}

// n.b. this is a copy and paste of:
// https://github.com/matrix-org/matrix-js-sdk/blob/75204d5cd04d67be100fca399f83b1a66ffb8118/src/crypto/verification/SAS.ts#L54-L68
function generateDecimalSas(sasBytes: number[]): [number, number, number] {
    /**
     *      +--------+--------+--------+--------+--------+
     *      | Byte 0 | Byte 1 | Byte 2 | Byte 3 | Byte 4 |
     *      +--------+--------+--------+--------+--------+
     * bits: 87654321 87654321 87654321 87654321 87654321
     *       \____________/\_____________/\____________/
     *         1st number    2nd number     3rd number
     */
    return [
        (sasBytes[0] << 5 | sasBytes[1] >> 3) + 1000,
        ((sasBytes[1] & 0x7) << 10 | sasBytes[2] << 2 | sasBytes[3] >> 6) + 1000,
        ((sasBytes[3] & 0x3f) << 7 | sasBytes[4] >> 1) + 1000,
    ];
}

// salt for HKDF, with 8 bytes of zeros
const zeroSalt = new Uint8Array(8);

async function calculateChecksum(sharedSecret: Uint8Array, info: String): Promise<string> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }

    const hkdfkey = await subtleCrypto.importKey(
        'raw',
        sharedSecret,
        { name: "HKDF" },
        false,
        ["deriveBits"],
    );

    const mac = await subtleCrypto.deriveBits(
        {
            name: "HKDF",
            salt: zeroSalt,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/879
            info: (new TextEncoder().encode(info)),
            hash: "SHA-256",
        },
        hkdfkey,
        40,
    );

    return generateDecimalSas(Array.from(new Uint8Array(mac))).join('-');
}

export class ECDHv1RendezvousChannel implements RendezvousChannel {
    private ourPrivateKey: Uint8Array;
    private _ourPublicKey?: Uint8Array;
    private sharedSecret?: Uint8Array;
    private aesInfo?: string;
    public onCancelled?: (reason: RendezvousCancellationReason) => void;

    constructor(
        public transport: RendezvousTransport,
        private cli?: MatrixClient,
        private theirPublicKey?: Uint8Array,
    ) {
        this.ourPrivateKey = ed.utils.randomPrivateKey();
    }

    private async getPublicKey(): Promise<Uint8Array> {
        if (!this._ourPublicKey) {
            this._ourPublicKey = await ed.getPublicKey(this.ourPrivateKey);
        }

        return this._ourPublicKey;
    }

    public async generateCode(): Promise<ECDHv1RendezvousCode> {
        if (this.transport.ready) {
            throw new Error('Code already generated');
        }

        const data = {
            "algorithm": SecureRendezvousChannelAlgorithm.ECDH_V1,
            "key": encodeBase64(await this.getPublicKey()),
        };

        await this.send(data);

        const rendezvous: ECDHv1RendezvousCode = {
            "rendezvous": {
                transport: await this.transport.details(),
                ...data,
            },
        };

        if (this.cli) {
            rendezvous.user = this.cli.getUserId() ?? undefined;
        }

        return rendezvous;
    }

    async connect(): Promise<string> {
        const isInitiator = !this.theirPublicKey;
        const ourPublicKey = await this.getPublicKey();

        if (this.cli && this.theirPublicKey) {
            await this.send({
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(ourPublicKey),
            });
        }

        if (this.cli || !this.theirPublicKey) {
            logger.info('Waiting for other device to send their public key');
            const res = await this.receive(); // ack
            if (!res) {
                throw new Error('No response from other device');
            }
            const { key, algorithm } = res;

            if (algorithm !== SecureRendezvousChannelAlgorithm.ECDH_V1 || !key) {
                throw new RendezvousError(
                    'Unsupported algorithm: ' + algorithm,
                    RendezvousCancellationReason.UnsupportedAlgorithm,
                );
            }

            if (this.theirPublicKey) {
                // check that the same public key was at the rendezvous point
                if (key !== encodeBase64(this.theirPublicKey)) {
                    throw new RendezvousError(
                        'Secure rendezvous key mismatch',
                        RendezvousCancellationReason.DataMismatch,
                    );
                }
            } else {
                this.theirPublicKey = decodeBase64(key);
            }
        }

        if (!this.cli) {
            await this.send({
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(ourPublicKey),
            });
        }

        this.sharedSecret = await ed.getSharedSecret(this.ourPrivateKey, this.theirPublicKey);

        const initiatorKey = isInitiator ? ourPublicKey : this.theirPublicKey;
        const recipientKey = isInitiator ? this.theirPublicKey : ourPublicKey;

        let aesInfo = SecureRendezvousChannelAlgorithm.ECDH_V1.toString();
        aesInfo += `|${encodeBase64(initiatorKey)}`;
        aesInfo += `|${encodeBase64(recipientKey)}`;

        this.aesInfo = aesInfo;

        return await calculateChecksum(this.sharedSecret, aesInfo);
    }

    public async send(data: any) {
        const stringifiedData = JSON.stringify(data);

        if (this.sharedSecret && this.aesInfo) {
            logger.info(`Encrypting: ${stringifiedData}`);
            const body = JSON.stringify(await encryptAESGCM(
                stringifiedData, this.sharedSecret, this.aesInfo,
            ));
            await this.transport.send('application/json', body);
        } else {
            await this.transport.send('application/json', stringifiedData);
        }
    }

    public async receive(): Promise<any> {
        const data = await this.transport.receive();
        logger.info(`Received data: ${JSON.stringify(data)}`);
        if (!data) {
            return data;
        }

        if (data.ciphertext) {
            if (!this.sharedSecret || !this.aesInfo) {
                throw new Error('Shared secret not set up');
            }
            const decrypted = await decryptAESGCM(data, this.sharedSecret, this.aesInfo);
            logger.info(`Decrypted data: ${decrypted}`);
            return JSON.parse(decrypted);
        } else if (this.sharedSecret) {
            throw new Error('Data received but no ciphertext');
        }

        return data;
    }
}
