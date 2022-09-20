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

import { decryptAES, encryptAES } from '../../crypto/aes';
import { logger } from '../../logger';
import { MatrixClient } from '../../matrix';
import { RendezvousError } from '../error';
import {
    RendezvousCancellationReason, RendezvousTransport, RendezvousChannel, RendezvousCode, RendezvousTransportDetails,
} from '../index';
import { SecureRendezvousChannelAlgorithm } from '.';
import { decodeBase64, encodeBase64 } from '../../crypto/olmlib';

export interface ECDHv1RendezvousCode extends RendezvousCode {
    rendezvous: {
        transport: RendezvousTransportDetails;
        algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1;
        key: {
            x: string;
        };
    };
}

export class ECDHv1RendezvousChannel implements RendezvousChannel {
    private ourPrivateKey: Uint8Array;
    private ourPublicKey: Uint8Array;
    private sharedSecret?: Uint8Array;
    public onCancelled?: (reason: RendezvousCancellationReason) => void;

    constructor(
        public transport: RendezvousTransport,
        private cli?: MatrixClient,
        private theirPublicKey?: Uint8Array,
    ) {
        this.ourPrivateKey = ed.utils.randomPrivateKey();
        this.ourPublicKey = ed.curve25519.scalarMultBase(this.ourPrivateKey);
    }

    public async generateCode(): Promise<ECDHv1RendezvousCode> {
        if (this.transport.ready) {
            throw new Error('Code already generated');
        }

        const data = {
            "algorithm": SecureRendezvousChannelAlgorithm.ECDH_V1,
            "key": {
                "x": encodeBase64(this.ourPublicKey),
            },
        };

        await this.send(data);

        const rendezvous: ECDHv1RendezvousCode = {
            "rendezvous": {
                transport: await this.transport.details(),
                ...data,
            },
        };

        if (this.cli) {
            rendezvous.user = this.cli.getUserId();
        }

        return rendezvous;
    }

    private async digits(): Promise<string> {
        const hashArray = Array.from(new Uint8Array(this.sharedSecret));
        const hashHex = hashArray.map((bytes) => bytes.toString(16)).join('').toUpperCase();
        return `${hashHex.slice(0, 3)}-${hashHex.slice(3, 6)}-${hashHex.slice(6, 9)}-${hashHex.slice(9, 12)}`;
    }

    async connect(): Promise<string> {
        if (this.cli && this.theirPublicKey) {
            await this.send({
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: { x: encodeBase64(this.ourPublicKey) },
            });
        }

        if (this.cli || !this.theirPublicKey) {
            logger.info('Waiting for other device to send their public key');
            const res = await this.receive(); // ack
            if (!res) {
                return undefined;
            }
            const { key, algorithm } = res;

            if (algorithm !== SecureRendezvousChannelAlgorithm.ECDH_V1 || !key?.x) {
                throw new RendezvousError(
                    'Unsupported algorithm: ' + algorithm,
                    RendezvousCancellationReason.UnsupportedAlgorithm,
                );
            }

            if (this.theirPublicKey) {
                // check that the same public key was at the rendezvous point
                if (key.x !== encodeBase64(this.theirPublicKey)) {
                    throw new RendezvousError(
                        'Secure rendezvous key mismatch',
                        RendezvousCancellationReason.DataMismatch,
                    );
                }
            } else {
                this.theirPublicKey = decodeBase64(key.x);
            }
        }

        if (!this.cli) {
            await this.send({
                algorithm: SecureRendezvousChannelAlgorithm.ECDH_V1,
                key: { x: encodeBase64(this.ourPublicKey) },
            });
        }

        this.sharedSecret = ed.curve25519.scalarMult(this.ourPrivateKey, this.theirPublicKey);

        return await this.digits();
    }

    public async send(data: any) {
        const stringifiedData = JSON.stringify(data);

        const body = this.sharedSecret ?
            JSON.stringify(await encryptAES(
                stringifiedData, this.sharedSecret, SecureRendezvousChannelAlgorithm.ECDH_V1,
            )) : stringifiedData;

        await this.transport.send('application/json', body);
    }

    public async receive(): Promise<any> {
        const data = await this.transport.receive();
        logger.info(`Received data: ${JSON.stringify(data)}`);
        if (!data) {
            return data;
        }

        if (data.ciphertext) {
            if (!this.sharedSecret) {
                throw new Error('Shared secret not set up');
            }
            const decrypted = await decryptAES(data, this.sharedSecret, SecureRendezvousChannelAlgorithm.ECDH_V1);
            logger.info(`Decrypted data: ${decrypted}`);
            return JSON.parse(decrypted);
        } else if (this.sharedSecret) {
            throw new Error('Data received but no ciphertext');
        }

        return data;
    }
}
