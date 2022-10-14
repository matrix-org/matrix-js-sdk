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
import { buildChannelFromCode, MSC3906Rendezvous, RendezvousFailureReason } from "../../../src/rendezvous";
import { DummyTransport } from "./DummyTransport";
import { MSC3903ECDHv1RendezvousChannel } from "../../../src/rendezvous/channels";
import { MatrixClient } from "../../../src";

function makeMockClient(opts: { userId: string, deviceId: string, msc3882Enabled: boolean}): MatrixClient {
    return {
        doesServerSupportUnstableFeature(feature: string) {
            return Promise.resolve(opts.msc3882Enabled && feature === "org.matrix.msc3882");
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
    let transports: DummyTransport<any>[];

    beforeEach(function() {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
        transports = [];
    });

    afterEach(function() {
        transports.forEach(x => x.cleanup());
    });

    describe("buildChannelFromCode", function() {
        it("non-JSON", function() {
            expect(buildChannelFromCode("xyz", () => {}, fetchFn)).rejects.toThrow("Invalid code");
        });

        it("invalid JSON", function() {
            expect(buildChannelFromCode(JSON.stringify({}), () => {}, fetchFn))
                .rejects.toThrow("Unsupported transport");
        });

        it("invalid transport type", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "foo" } },
            }), () => {}, fetchFn)).rejects.toThrow("Unsupported transport");
        });

        it("missing URI", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1" } },
            }), () => {}, fetchFn)).rejects.toThrow("Invalid code");
        });

        it("invalid URI field", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1", uri: false } },
            }), () => {}, fetchFn)).rejects.toThrow("Invalid code");
        });

        it("missing intent", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1", uri: "something" } },
            }), () => {}, fetchFn)).rejects.toThrow("Invalid intent");
        });

        it("invalid intent", function() {
            expect(buildChannelFromCode(JSON.stringify({
                intent: 'asd',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {}, fetchFn)).rejects.toThrow("Invalid intent");
        });

        it("login.reciprocate", async function() {
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.reciprocate',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {}, fetchFn);
            expect(x.intent).toBe("login.reciprocate");
        });

        it("login.start", async function() {
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.start',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {}, fetchFn);
            expect(x.intent).toBe("login.start");
        });

        it("parse and get", async function() {
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.start',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "https://rz.server/123456" },
                },
            }), () => {}, fetchFn);
            expect(x.intent).toBe("login.start");

            const prom = x.channel.receive();
            httpBackend.when("GET", "https://rz.server/123456").response = {
                body: {},
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toStrictEqual({});
        });
    });

    describe("end-to-end", function() {
        it("generate on new device and scan on existing - decline", async function() {
            const aliceTransport = new DummyTransport('Alice', { type: 'http.v1', uri: 'https://test.rz/123456' });
            const bobTransport = new DummyTransport('Bob', { type: 'http.v1', uri: 'https://test.rz/999999' });
            transports.push(aliceTransport, bobTransport);
            aliceTransport.otherParty = bobTransport;
            bobTransport.otherParty = aliceTransport;
            try {
                // alice is signing in initiates and generates a code
                const aliceEcdh = new MSC3903ECDHv1RendezvousChannel(aliceTransport);
                const aliceRz = new MSC3906Rendezvous(aliceEcdh);
                const aliceOnFailure = jest.fn();
                aliceTransport.onCancelled = aliceOnFailure;
                await aliceRz.generateCode();
                const aliceStartProm = aliceRz.startAfterShowingCode();

                // bob is already signed in and scans the code
                const bob = makeMockClient({ userId: "bob", deviceId: "BOB", msc3882Enabled: true });
                const {
                    channel: bobEcdh,
                    intent: aliceIntentAsSeenByBob,
                } = await buildChannelFromCode(aliceRz.code!, () => {}, fetchFn);
                // we override the channel to set to dummy transport:
                (bobEcdh as unknown as MSC3903ECDHv1RendezvousChannel).transport = bobTransport;
                const bobRz = new MSC3906Rendezvous(bobEcdh, bob);
                const bobStartProm = bobRz.startAfterScanningCode(aliceIntentAsSeenByBob);

                // check that the two sides are talking to each other with same checksum
                const aliceChecksum = await aliceStartProm;
                const bobChecksum = await bobStartProm;
                expect(aliceChecksum).toEqual(bobChecksum);

                const aliceCompleteProm = aliceRz.completeLoginOnNewDevice();
                await bobRz.declineLoginOnExistingDevice();

                await aliceCompleteProm;
                expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UserDeclined);
            } finally {
                aliceTransport.cleanup();
                bobTransport.cleanup();
            }
        });

        it("generate on existing device and scan on new device - decline", async function() {
            const aliceTransport = new DummyTransport('Alice', { type: 'http.v1', uri: 'https://test.rz/123456' });
            const bobTransport = new DummyTransport('Bob', { type: 'http.v1', uri: 'https://test.rz/999999' });
            transports.push(aliceTransport, bobTransport);
            aliceTransport.otherParty = bobTransport;
            bobTransport.otherParty = aliceTransport;
            try {
                // bob is already signed initiates and generates a code
                const bob = makeMockClient({ userId: "bob", deviceId: "BOB", msc3882Enabled: true });
                const bobEcdh = new MSC3903ECDHv1RendezvousChannel(bobTransport);
                const bobRz = new MSC3906Rendezvous(bobEcdh, bob);
                await bobRz.generateCode();
                const bobStartProm = bobRz.startAfterShowingCode();

                // alice wants to sign in and scans the code
                const aliceOnFailure = jest.fn();
                const {
                    channel: aliceEcdh,
                    intent: bobsIntentAsSeenByAlice,
                } = await buildChannelFromCode(bobRz.code!, aliceOnFailure, fetchFn);
                // we override the channel to set to dummy transport:
                (aliceEcdh as unknown as MSC3903ECDHv1RendezvousChannel).transport = aliceTransport;
                const aliceRz = new MSC3906Rendezvous(aliceEcdh, undefined, aliceOnFailure);
                const aliceStartProm = aliceRz.startAfterScanningCode(bobsIntentAsSeenByAlice);

                // check that the two sides are talking to each other with same checksum
                const bobChecksum = await bobStartProm;
                const aliceChecksum = await aliceStartProm;
                expect(aliceChecksum).toEqual(bobChecksum);

                const aliceCompleteProm = aliceRz.completeLoginOnNewDevice();
                await bobRz.declineLoginOnExistingDevice();

                await aliceCompleteProm;
                expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UserDeclined);
            } finally {
                aliceTransport.cleanup();
                bobTransport.cleanup();
            }
        });

        it("no protocol available", async function() {
            const aliceTransport = new DummyTransport('Alice', { type: 'http.v1', uri: 'https://test.rz/123456' });
            const bobTransport = new DummyTransport('Bob', { type: 'http.v1', uri: 'https://test.rz/999999' });
            transports.push(aliceTransport, bobTransport);
            aliceTransport.otherParty = bobTransport;
            bobTransport.otherParty = aliceTransport;
            try {
                // alice is signing in initiates and generates a code
                const aliceOnFailure = jest.fn();
                const aliceEcdh = new MSC3903ECDHv1RendezvousChannel(aliceTransport);
                const aliceRz = new MSC3906Rendezvous(aliceEcdh, undefined, aliceOnFailure);
                aliceTransport.onCancelled = aliceOnFailure;
                await aliceRz.generateCode();
                const aliceStartProm = aliceRz.startAfterShowingCode();

                // bob is already signed in and scans the code
                const bob = makeMockClient({ userId: "bob", deviceId: "BOB", msc3882Enabled: false });
                const {
                    channel: bobEcdh,
                    intent: aliceIntentAsSeenByBob,
                } = await buildChannelFromCode(aliceRz.code!, () => {}, fetchFn);
                // we override the channel to set to dummy transport:
                (bobEcdh as unknown as MSC3903ECDHv1RendezvousChannel).transport = bobTransport;
                const bobRz = new MSC3906Rendezvous(bobEcdh, bob);
                const bobStartProm = bobRz.startAfterScanningCode(aliceIntentAsSeenByBob);

                // check that the two sides are talking to each other with same checksum
                const aliceChecksum = await aliceStartProm;
                const bobChecksum = await bobStartProm;
                expect(bobChecksum).toBeUndefined();
                expect(aliceChecksum).toBeUndefined();

                expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UnsupportedAlgorithm);
                // await aliceRz.completeLoginOnNewDevice();
            } finally {
                aliceTransport.cleanup();
                bobTransport.cleanup();
            }
        });
    });
});
