/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import "../../olm-loader";
import {
    MSC3906Rendezvous,
    RendezvousCode,
    RendezvousFailureReason,
    RendezvousIntent,
    SETUP_ADDITIONAL_DEVICE_FLOW_V2,
} from "../../../src/rendezvous";
import {
    ECDHv2RendezvousCode as ECDHRendezvousCode,
    MSC3903ECDHPayload,
    MSC3903ECDHv2RendezvousChannel as MSC3903ECDHRendezvousChannel,
} from "../../../src/rendezvous/channels";
import { MatrixClient } from "../../../src";
import {
    MSC3886SimpleHttpRendezvousTransport,
    MSC3886SimpleHttpRendezvousTransportDetails,
} from "../../../src/rendezvous/transports";
import { DummyTransport } from "./DummyTransport";
import { decodeBase64 } from "../../../src/crypto/olmlib";
import { logger } from "../../../src/logger";
import { DeviceInfo } from "../../../src/crypto/deviceinfo";

interface MockClientOpts {
    userId: string;
    deviceId: string;
    deviceKey?: string;
    msc3882Enabled: boolean;
    msc3886Enabled: boolean;
    devices?: Record<string, Partial<DeviceInfo>>;
    verificationFunction?: (
        userId: string,
        deviceId: string,
        verified: boolean,
        blocked: boolean,
        known: boolean,
    ) => void;
    crossSigningIds?: Record<string, string>;
}

function makeMockClient(opts: MockClientOpts): MatrixClient {
    return {
        getVersions() {
            return {
                unstable_features: {
                    "org.matrix.msc3882": opts.msc3882Enabled,
                    "org.matrix.msc3886": opts.msc3886Enabled,
                },
            };
        },
        getUserId() {
            return opts.userId;
        },
        getDeviceId() {
            return opts.deviceId;
        },
        getDeviceEd25519Key() {
            return opts.deviceKey;
        },
        baseUrl: "https://example.com",
        crypto: {
            getStoredDevice(userId: string, deviceId: string) {
                return opts.devices?.[deviceId] ?? null;
            },
            setDeviceVerification: opts.verificationFunction,
            crossSigningInfo: {
                getId(key: string) {
                    return opts.crossSigningIds?.[key];
                },
            },
        },
    } as unknown as MatrixClient;
}

function makeTransport(name: string, uri = "https://test.rz/123456") {
    return new DummyTransport<any, MSC3903ECDHPayload>(name, { type: "http.v1", uri });
}

describe("RendezvousV2", function () {
    beforeAll(async function () {
        await global.Olm.init();
    });

    let httpBackend: MockHttpBackend;
    let fetchFn: typeof global.fetch;
    let transports: DummyTransport<any, MSC3903ECDHPayload>[];

    beforeEach(function () {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
        transports = [];
    });

    afterEach(function () {
        transports.forEach((x) => x.cleanup());
    });

    async function setupRendezvous(aliceOpts: Partial<MockClientOpts> = {}) {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signed in and generates a code
        const aliceOnFailure = jest.fn();
        const alice = makeMockClient({
            userId: "alice",
            deviceId: "ALICE",
            msc3882Enabled: true,
            msc3886Enabled: false,
            ...aliceOpts,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(
            aliceEcdh,
            alice,
            undefined,
            "org.matrix.msc3906.setup.additional_device.v2",
        );
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob wants to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        return {
            alice,
            aliceTransport,
            aliceStartProm,
            aliceEcdh,
            aliceRz,
            aliceOnFailure,
            bobTransport,
            bobEcdh,
            bobOnFailure,
        };
    }

    async function completeToProtocolsPayload(
        next: (x: any, protocolsPayload: any) => Promise<void>,
        aliceOpts: Partial<MockClientOpts> = {},
    ) {
        const x = await setupRendezvous(aliceOpts);
        const { bobEcdh, aliceStartProm } = x;
        const bobStartPromise = (async () => {
            await bobEcdh.connect();

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob received protocols: ${JSON.stringify(protocols)}`);

            await next(x, protocols);
        })();

        await aliceStartProm;
        await bobStartPromise;

        return x;
    }

    async function completeToSendingProtocolPayload(protocolPayload: any, aliceOpts: Partial<MockClientOpts> = {}) {
        const x = await completeToProtocolsPayload(
            async ({ bobEcdh }: { bobEcdh: MSC3903ECDHRendezvousChannel<any> }, protocolsPayload) => {
                expect(protocolsPayload).toEqual({
                    type: "m.login.protocols",
                    protocols: ["org.matrix.msc3906.login_token"],
                });
                await bobEcdh.send(protocolPayload);
            },
            aliceOpts,
        );

        return x;
    }

    it("generate and cancel", async function () {
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
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport);
        const aliceRz = new MSC3906Rendezvous(
            aliceEcdh,
            alice,
            undefined,
            "org.matrix.msc3906.setup.additional_device.v2",
        );

        expect(aliceRz.code).toBeUndefined();

        const codePromise = aliceRz.generateCode();
        await httpBackend.flush("");

        await aliceRz.generateCode();

        expect(typeof aliceRz.code).toBe("string");

        await codePromise;

        const code = JSON.parse(aliceRz.code!) as RendezvousCode;

        expect(code.intent).toEqual(RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE);
        expect(code.flow).toEqual(SETUP_ADDITIONAL_DEVICE_FLOW_V2.name);
        expect(code.rendezvous?.algorithm).toEqual("org.matrix.msc3903.rendezvous.v2.curve25519-aes-sha256");
        expect(code.rendezvous?.transport.type).toEqual("org.matrix.msc3886.http.v1");
        expect((code.rendezvous?.transport as MSC3886SimpleHttpRendezvousTransportDetails).uri).toEqual(
            "https://fallbackserver/rz/123",
        );

        httpBackend.when("DELETE", "https://fallbackserver/rz").response = {
            body: null,
            response: {
                statusCode: 204,
                headers: {},
            },
        };

        const cancelPromise = aliceRz.cancel(RendezvousFailureReason.UserDeclined);
        await httpBackend.flush("");
        expect(cancelPromise).resolves.toBeUndefined();
        httpBackend.verifyNoOutstandingExpectation();
        httpBackend.verifyNoOutstandingRequests();

        await aliceRz.close();
    });

    it("no protocols", async function () {
        await completeToProtocolsPayload(
            async (_, protocolsPayload) => {
                expect(protocolsPayload).toEqual({
                    type: "m.login.failure",
                    reason: "unsupported",
                });
            },
            {
                msc3882Enabled: false,
                msc3886Enabled: false,
            },
        );
    });

    it("other device already signed in", async function () {
        const { aliceOnFailure } = await completeToSendingProtocolPayload({
            type: "m.login.failure",
            reason: "incompatible_intent",
            intent: RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE,
        });
        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.OtherDeviceAlreadySignedIn);
    });

    it("invalid payload after protocols", async function () {
        const { aliceOnFailure } = await completeToSendingProtocolPayload({ type: "invalid" });
        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.Unknown);
    });

    it("new device declines protocol with reason unsupported", async function () {
        const { aliceOnFailure } = await completeToSendingProtocolPayload({
            type: "m.login.failure",
            reason: "unsupported",
        });
        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UnsupportedAlgorithm);
    });

    it("new device requests an invalid protocol", async function () {
        const { aliceOnFailure } = await completeToSendingProtocolPayload({
            type: "m.login.protocol",
            protocol: "bad protocol",
        });

        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UnsupportedAlgorithm);
    });

    it("decline on existing device", async function () {
        const { aliceRz, bobEcdh } = await completeToSendingProtocolPayload({
            type: "m.login.protocol",
            protocol: "org.matrix.msc3906.login_token",
        });

        await aliceRz.declineLoginOnExistingDevice();
        const loginToken = await bobEcdh.receive();
        expect(loginToken).toEqual({ type: "m.login.declined" });
    });

    it("approve on existing device + no verification", async function () {
        const { aliceRz, bobEcdh, alice } = await completeToSendingProtocolPayload({
            type: "m.login.protocol",
            protocol: "org.matrix.msc3906.login_token",
        });

        const confirmProm = aliceRz.approveLoginOnExistingDevice("token");

        const bobCompleteProm = (async () => {
            const loginToken = await bobEcdh.receive();
            expect(loginToken).toEqual({ type: "m.login.approved", login_token: "token", homeserver: alice.baseUrl });
            await bobEcdh.send({ type: "m.login.success" });
        })();

        await confirmProm;
        await bobCompleteProm;
    });

    async function completeLogin(devices: Record<string, Partial<DeviceInfo>>) {
        const aliceVerification = jest.fn();
        const { aliceRz, bobEcdh, alice, aliceEcdh, aliceTransport, bobTransport } =
            await completeToSendingProtocolPayload(
                {
                    type: "m.login.protocol",
                    protocol: "org.matrix.msc3906.login_token",
                },
                {
                    devices,
                    deviceKey: "aaaa",
                    verificationFunction: aliceVerification,
                    crossSigningIds: {
                        master: "mmmmm",
                    },
                },
            );

        const confirmProm = aliceRz.approveLoginOnExistingDevice("token");

        const bobLoginProm = (async () => {
            const loginToken = await bobEcdh.receive();
            expect(loginToken).toEqual({ type: "m.login.approved", login_token: "token", homeserver: alice.baseUrl });
            await bobEcdh.send({ type: "m.login.success", device_id: "BOB", device_key: "bbbb" });
        })();

        expect(await confirmProm).toEqual("BOB");
        await bobLoginProm;

        return {
            aliceTransport,
            aliceEcdh,
            aliceRz,
            bobTransport,
            bobEcdh,
        };
    }

    it("approve on existing device + verification", async function () {
        const { bobEcdh, aliceRz } = await completeLogin({
            BOB: {
                getFingerprint: () => "bbbb",
            },
        });
        const verifyProm = aliceRz.verifyNewDeviceOnExistingDevice();

        const bobVerifyProm = (async () => {
            const verified = await bobEcdh.receive();
            expect(verified).toEqual({
                type: "m.login.verified",
                verifying_device_id: "ALICE",
                verifying_device_key: "aaaa",
                master_key: "mmmmm",
            });
        })();

        await verifyProm;
        await bobVerifyProm;
    });

    it("device not online within timeout", async function () {
        const { aliceRz } = await completeLogin({});
        expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow();
    });

    it("device appears online within timeout", async function () {
        const devices: Record<string, Partial<DeviceInfo>> = {};
        const { aliceRz } = await completeLogin(devices);
        // device appears after 1 second
        setTimeout(() => {
            devices.BOB = {
                getFingerprint: () => "bbbb",
            };
        }, 1000);
        await aliceRz.verifyNewDeviceOnExistingDevice(2000);
    });

    it("device appears online after timeout", async function () {
        const devices: Record<string, Partial<DeviceInfo>> = {};
        const { aliceRz } = await completeLogin(devices);
        // device appears after 1 second
        setTimeout(() => {
            devices.BOB = {
                getFingerprint: () => "bbbb",
            };
        }, 1500);
        expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow();
    });

    it("mismatched device key", async function () {
        const { aliceRz } = await completeLogin({
            BOB: {
                getFingerprint: () => "XXXX",
            },
        });
        expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow(/different key/);
    });
});
