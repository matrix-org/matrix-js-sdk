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

import crypto from 'crypto';

import '../../olm-loader';
import {
    RendezvousFailureListener,
    RendezvousFailureReason,
    RendezvousIntent,
    RendezvousTransport,
    RendezvousTransportDetails,
} from "../../../src/rendezvous";
import { ECDHv1RendezvousChannel } from '../../../src/rendezvous/channels';
import { decodeBase64 } from '../../../src/crypto/olmlib';
import { setCrypto, sleep } from '../../../src/utils';

class DummyTransport implements RendezvousTransport {
    otherParty?: DummyTransport;
    etag?: string;
    data = null;

    ready = false;

    onCancelled?: RendezvousFailureListener;

    details(): Promise<RendezvousTransportDetails> {
        return Promise.resolve({
            type: 'dummy',
        });
    }

    async send(contentType: string, data: any): Promise<void> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (!this.etag || this.otherParty?.etag === this.etag) {
                this.data = data;
                this.etag = Math.random().toString();
                return;
            }
            await sleep(100);
        }
    }

    async receive(): Promise<any> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (!this.etag || this.otherParty?.etag !== this.etag) {
                this.etag = this.otherParty?.etag;
                return this.otherParty?.data ? JSON.parse(this.otherParty.data) : undefined;
            }
            await sleep(100);
        }
    }

    cancel(reason: RendezvousFailureReason): Promise<void> {
        throw new Error("Method not implemented.");
    }
}

describe("ECDHv1", function() {
    beforeAll(async function() {
        setCrypto(crypto);
        await global.Olm.init();
    });

    it("initiator wants to sign in", async function() {
        const aliceTransport = new DummyTransport();
        const bobTransport = new DummyTransport();
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is signing in initiates and generates a code
        const alice = new ECDHv1RendezvousChannel(aliceTransport);
        const aliceCode = await alice.generateCode(RendezvousIntent.LOGIN_ON_NEW_DEVICE);
        const bob = new ECDHv1RendezvousChannel(bobTransport, decodeBase64(aliceCode.rendezvous.key));

        const bobChecksum = await bob.connect();
        const aliceChecksum = await alice.connect();

        expect(aliceChecksum).toEqual(bobChecksum);

        const message = "hello world";
        await alice.send(message);
        const bobReceive = await bob.receive();
        expect(bobReceive).toEqual(message);
    });

    it("initiator wants to reciprocate", async function() {
        const aliceTransport = new DummyTransport();
        const bobTransport = new DummyTransport();
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is signing in initiates and generates a code
        const alice = new ECDHv1RendezvousChannel(aliceTransport);
        const aliceCode = await alice.generateCode(RendezvousIntent.LOGIN_ON_NEW_DEVICE);
        const bob = new ECDHv1RendezvousChannel(bobTransport, decodeBase64(aliceCode.rendezvous.key));

        const bobChecksum = await bob.connect();
        const aliceChecksum = await alice.connect();

        expect(aliceChecksum).toEqual(bobChecksum);

        const message = "hello world";
        await bob.send(message);
        const aliceReceive = await alice.receive();
        expect(aliceReceive).toEqual(message);
    });
});
