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

import { MatrixClient } from '..';
import { RendezvousCancellationFunction, RendezvousCancellationReason } from './cancellationReason';
import { RendezvousChannel } from './channel';
import { RendezvousCode } from './code';
import { RendezvousError } from './error';
import { SimpleHttpRendezvousTransport, SimpleHttpRendezvousTransportDetails } from './transports';
import { decodeBase64 } from '../crypto/olmlib';
import { ECDHv1RendezvousChannel, ECDHv1RendezvousCode } from './channels';

export * from './code';
export * from './cancellationReason';
export * from './transport';
export * from './channel';

export async function buildChannelFromCode(
    code: string,
    onCancelled: RendezvousCancellationFunction,
    cli?: MatrixClient,
): Promise<RendezvousChannel> {
    let parsed: RendezvousCode;
    try {
        parsed = JSON.parse(code) as RendezvousCode;
    } catch (err) {
        throw new RendezvousError('Invalid code', RendezvousCancellationReason.InvalidCode);
    }

    if (parsed.rendezvous?.transport.type !== 'http.v1') {
        throw new RendezvousError('Unsupported transport', RendezvousCancellationReason.UnsupportedTransport);
    }

    const transportDetails = parsed.rendezvous.transport as SimpleHttpRendezvousTransportDetails;

    if (typeof transportDetails.uri !== 'string') {
        throw new RendezvousError('Invalid code', RendezvousCancellationReason.InvalidCode);
    }

    const transport = new SimpleHttpRendezvousTransport(onCancelled, undefined, transportDetails.uri);

    if (parsed.rendezvous?.algorithm !=="m.rendezvous.v1.x25519-aes-sha256") {
        throw new RendezvousError('Unsupported transport', RendezvousCancellationReason.UnsupportedAlgorithm);
    }

    const ecdhCode = parsed as ECDHv1RendezvousCode;

    const theirPublicKey = decodeBase64(ecdhCode.rendezvous.key.x);

    return new ECDHv1RendezvousChannel(transport, cli, theirPublicKey);
}
