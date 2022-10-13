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
import { RendezvousIntent } from "../../../src/rendezvous";
import { MSC3903ECDHv1RendezvousChannel } from '../../../src/rendezvous/channels';
import { decodeBase64 } from '../../../src/crypto/olmlib';
import { setCrypto } from '../../../src/utils';
import { DummyTransport } from './DummyTransport';

describe("ECDHv1", function() {
    beforeAll(async function() {
        setCrypto(crypto);
        await global.Olm.init();
    });

    it("initiator wants to sign in", async function() {
        const aliceTransport = new DummyTransport({ type: 'dummy' });
        const bobTransport = new DummyTransport({ type: 'dummy' });
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is signing in initiates and generates a code
        const alice = new MSC3903ECDHv1RendezvousChannel(aliceTransport);
        const aliceCode = await alice.generateCode(RendezvousIntent.LOGIN_ON_NEW_DEVICE);
        const bob = new MSC3903ECDHv1RendezvousChannel(bobTransport, decodeBase64(aliceCode.rendezvous.key));

        const bobChecksum = await bob.connect();
        const aliceChecksum = await alice.connect();

        expect(aliceChecksum).toEqual(bobChecksum);

        const message = "hello world";
        await alice.send(message);
        const bobReceive = await bob.receive();
        expect(bobReceive).toEqual(message);
    });

    it("initiator wants to reciprocate", async function() {
        const aliceTransport = new DummyTransport({ type: 'dummy' });
        const bobTransport = new DummyTransport({ type: 'dummy' });
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is signing in initiates and generates a code
        const alice = new MSC3903ECDHv1RendezvousChannel(aliceTransport);
        const aliceCode = await alice.generateCode(RendezvousIntent.LOGIN_ON_NEW_DEVICE);
        const bob = new MSC3903ECDHv1RendezvousChannel(bobTransport, decodeBase64(aliceCode.rendezvous.key));

        const bobChecksum = await bob.connect();
        const aliceChecksum = await alice.connect();

        expect(aliceChecksum).toEqual(bobChecksum);

        const message = "hello world";
        await bob.send(message);
        const aliceReceive = await alice.receive();
        expect(aliceReceive).toEqual(message);
    });
});
