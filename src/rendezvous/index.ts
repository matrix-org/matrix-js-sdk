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

import { RendezvousFailureListener, RendezvousFailureReason } from './cancellationReason';
import { RendezvousChannel } from './channel';
import { RendezvousCode, RendezvousIntent } from './code';
import { RendezvousError } from './error';
import { MSC3886SimpleHttpRendezvousTransport, MSC3886SimpleHttpRendezvousTransportDetails } from './transports';
import { decodeBase64 } from '../crypto/olmlib';
import { MSC3903ECDHv1RendezvousChannel, ECDHv1RendezvousCode, SecureRendezvousChannelAlgorithm } from './channels';
import { logger } from '../logger';

export * from './code';
export * from './cancellationReason';
export * from './transport';
export * from './channel';
export * from './rendezvous';

/**
 * Attempts to parse the given code as a rendezvous and return a channel and transport.
 * @param code The code to parse.
 * @param onCancelled the cancellation listener to use for the transport and secure channel.
 * @returns The channel and intent of the generatoer
 */
export async function buildChannelFromCode(
    code: string,
    onFailure: RendezvousFailureListener,
    fetchFn?: typeof global.fetch,
): Promise<{ channel: RendezvousChannel, intent: RendezvousIntent }> {
    let parsed: RendezvousCode;
    try {
        parsed = JSON.parse(code) as RendezvousCode;
    } catch (err) {
        throw new RendezvousError('Invalid code', RendezvousFailureReason.InvalidCode);
    }

    const { intent, rendezvous } = parsed;

    if (rendezvous?.transport.type !== 'http.v1') {
        throw new RendezvousError('Unsupported transport', RendezvousFailureReason.UnsupportedTransport);
    }

    const transportDetails = rendezvous.transport as MSC3886SimpleHttpRendezvousTransportDetails;

    if (typeof transportDetails.uri !== 'string') {
        throw new RendezvousError('Invalid code', RendezvousFailureReason.InvalidCode);
    }

    if (!intent || !Object.values(RendezvousIntent).includes(intent)) {
        throw new RendezvousError('Invalid intent', RendezvousFailureReason.InvalidCode);
    }

    const transport = new MSC3886SimpleHttpRendezvousTransport({ onFailure, rendezvousUri: transportDetails.uri, fetchFn });

    if (rendezvous?.algorithm !== SecureRendezvousChannelAlgorithm.ECDH_V1) {
        throw new RendezvousError('Unsupported transport', RendezvousFailureReason.UnsupportedAlgorithm);
    }

    const ecdhCode = parsed as ECDHv1RendezvousCode;

    const theirPublicKey = decodeBase64(ecdhCode.rendezvous.key);

    logger.info(`Building ECDHv1 rendezvous via HTTP from: ${code}`);
    return {
        channel: new MSC3903ECDHv1RendezvousChannel(transport, theirPublicKey),
        intent,
    };
}
