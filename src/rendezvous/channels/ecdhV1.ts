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

import { logger } from '../../logger';
import { RendezvousError } from '../error';
import {
    RendezvousCode,
    RendezvousIntent,
    RendezvousChannel,
    RendezvousTransportDetails,
    RendezvousTransport,
    RendezvousCancellationReason,
} from '../index';
import { SecureRendezvousChannelAlgorithm } from '.';
import { encodeBase64, decodeBase64 } from '../../crypto/olmlib';
import { decryptAESGCM, encryptAESGCM } from '../../crypto/aesGcm';

export interface ECDHv1RendezvousCode extends RendezvousCode {
    rendezvous: {
        transport: RendezvousTransportDetails;
        algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1;
        key: string;
    };
}

// The underlying algorithm is the same as:
// https://github.com/matrix-org/matrix-js-sdk/blob/75204d5cd04d67be100fca399f83b1a66ffb8118/src/crypto/verification/SAS.ts#L54-L68
function generateDecimalSas(sasBytes: number[]): string {
    /**
     *      +--------+--------+--------+--------+--------+
     *      | Byte 0 | Byte 1 | Byte 2 | Byte 3 | Byte 4 |
     *      +--------+--------+--------+--------+--------+
     * bits: 87654321 87654321 87654321 87654321 87654321
     *       \____________/\_____________/\____________/
     *         1st number    2nd number     3rd number
     */
    const digits = [
        (sasBytes[0] << 5 | sasBytes[1] >> 3) + 1000,
        ((sasBytes[1] & 0x7) << 10 | sasBytes[2] << 2 | sasBytes[3] >> 6) + 1000,
        ((sasBytes[3] & 0x3f) << 7 | sasBytes[4] >> 1) + 1000,
    ];

    return digits.join('-');
}

export class ECDHv1RendezvousChannel implements RendezvousChannel {
    private olmSAS?: SAS;
    private ourPublicKey: Uint8Array;
    private aesKey: Uint8Array;
    public onCancelled?: (reason: RendezvousCancellationReason) => void;

    constructor(
        public transport: RendezvousTransport,
        private theirPublicKey?: Uint8Array,
    ) {
        this.olmSAS = new global.Olm.SAS();
        this.ourPublicKey = decodeBase64(this.olmSAS.get_pubkey());
    }

    public async generateCode(intent: RendezvousIntent): Promise<ECDHv1RendezvousCode> {
        if (this.transport.ready) {
            throw new Error('Code already generated');
        }

        const data = {
            "algorithm": SecureRendezvousChannelAlgorithm.ECDH_V1,
        };

        await this.send({ algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1 });

        const rendezvous: ECDHv1RendezvousCode = {
            "rendezvous": {
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(this.ourPublicKey),
                transport: await this.transport.details(),
                ...data,
            },
            intent,
        };

        return rendezvous;
    }

    async connect(): Promise<string> {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const isInitiator = !this.theirPublicKey;

        if (isInitiator) {
            // wait for the other side to send us their public key
            logger.info('Waiting for other device to send their public key');
            const res = await this.receive();
            if (!res) {
                throw new Error('No response from other device');
            }
            const { key, algorithm } = res;

            if (algorithm !== SecureRendezvousChannelAlgorithm.ECDH_V1 || (isInitiator && !key)) {
                throw new RendezvousError(
                    'Unsupported algorithm: ' + algorithm,
                    RendezvousCancellationReason.UnsupportedAlgorithm,
                );
            }

            this.theirPublicKey = decodeBase64(key);
        } else {
            // send our public key unencrypted
            await this.send({
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: encodeBase64(this.ourPublicKey),
            });
        }

        this.olmSAS.set_their_key(encodeBase64(this.theirPublicKey));

        const initiatorKey = isInitiator ? this.ourPublicKey : this.theirPublicKey;
        const recipientKey = isInitiator ? this.theirPublicKey : this.ourPublicKey;
        let aesInfo = SecureRendezvousChannelAlgorithm.ECDH_V1.toString();
        aesInfo += `|${encodeBase64(initiatorKey)}`;
        aesInfo += `|${encodeBase64(recipientKey)}`;

        this.aesKey = this.olmSAS.generate_bytes(aesInfo, 32);

        logger.debug(`Our public key: ${encodeBase64(this.ourPublicKey)}`);
        logger.debug(`Their public key: ${encodeBase64(this.theirPublicKey)}`);
        logger.debug(`AES info: ${aesInfo}`);
        logger.debug(`AES key: ${encodeBase64(this.aesKey)}`);

        const rawChecksum = this.olmSAS.generate_bytes(aesInfo, 5);
        return generateDecimalSas(Array.from(rawChecksum));
    }

    public async send(data: any) {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const stringifiedData = JSON.stringify(data);

        if (this.aesKey) {
            logger.info(`Encrypting: ${stringifiedData}`);
            const body = JSON.stringify(await encryptAESGCM(
                stringifiedData, this.aesKey,
            ));
            await this.transport.send('application/json', body);
        } else {
            await this.transport.send('application/json', stringifiedData);
        }
    }

    public async receive(): Promise<any> {
        if (!this.olmSAS) {
            throw new Error('Channel closed');
        }

        const data = await this.transport.receive();
        logger.info(`Received data: ${JSON.stringify(data)}`);
        if (!data) {
            return data;
        }

        if (data.ciphertext) {
            if (!this.aesKey) {
                throw new Error('Shared secret not set up');
            }
            const decrypted = await decryptAESGCM(data, this.aesKey);
            logger.info(`Decrypted data: ${decrypted}`);
            return JSON.parse(decrypted);
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

    public async cancel(reason: RendezvousCancellationReason) {
        try {
            await this.transport.cancel(reason);
        } finally {
            await this.close();
        }
    }
}
