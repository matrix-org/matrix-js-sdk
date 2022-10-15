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

import MockHttpBackend from "matrix-mock-request";

import '../../olm-loader';
import { MSC3906Rendezvous, RendezvousCode, RendezvousIntent } from "../../../src/rendezvous";
import { MSC3903ECDHv1RendezvousChannel } from "../../../src/rendezvous/channels";
import { MatrixClient } from "../../../src";
import {
    MSC3886SimpleHttpRendezvousTransport,
    MSC3886SimpleHttpRendezvousTransportDetails,
} from "../../../src/rendezvous/transports";

function makeMockClient(opts: {
    userId: string;
    deviceId: string;
    msc3882Enabled: boolean;
    msc3886Enabled: boolean;
}): MatrixClient {
    return {
        doesServerSupportUnstableFeature(feature: string) {
            switch (feature) {
                case "org.matrix.msc3882": return opts.msc3882Enabled;
                case "org.matrix.msc3886": return opts.msc3886Enabled;
                default: return false;
            }
        },
        getUserId() { return opts.userId; },
        getDeviceId() { return opts.deviceId; },
        requestLoginToken() {
            return Promise.resolve({ login_token: "token" });
        },
        baseUrl: "https://example.com",
    } as unknown as MatrixClient;
}

describe("Rendezvous", function() {
    beforeAll(async function() {
        await global.Olm.init();
    });

    let httpBackend: MockHttpBackend;
    let fetchFn: typeof global.fetchFn;

    beforeEach(function() {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
    });

    describe("end-to-end", function() {
        it("generate", async function() {
            const alice = makeMockClient({
                userId: "@alice:example.com",
                deviceId: "DEVICEID",
                msc3886Enabled: false,
                msc3882Enabled: true,
            });
            httpBackend.when("POST", "https://fallbackserver/rz").response = {
                body: null,
                response: {
                    statusCode: 201,
                    headers: {
                        location: "https://fallbackserver/rz/123",
                    },
                },
            };
            const aliceTransport = new MSC3886SimpleHttpRendezvousTransport({
                client: alice,
                fallbackRzServer: "https://fallbackserver/rz",
                fetchFn,
            });
            const aliceEcdh = new MSC3903ECDHv1RendezvousChannel(aliceTransport);
            const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);

            expect(aliceRz.code).toBeUndefined();

            const codePromise = aliceRz.generateCode();
            await httpBackend.flush('');

            await codePromise;

            expect(typeof aliceRz.code).toBe('string');

            const code = JSON.parse(aliceRz.code) as RendezvousCode;

            expect(code.intent).toEqual(RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE);
            expect(code.rendezvous.algorithm).toEqual("m.rendezvous.v1.curve25519-aes-sha256");
            expect(code.rendezvous.transport.type).toEqual("http.v1");
            expect((code.rendezvous.transport as MSC3886SimpleHttpRendezvousTransportDetails).uri)
                .toEqual("https://fallbackserver/rz/123");
        });
    });
});
