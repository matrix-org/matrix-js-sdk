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

import "../../olm-loader";
import {
    MSC3906Rendezvous,
    RendezvousCode,
    LegacyRendezvousFailureReason as RendezvousFailureReason,
    RendezvousIntent,
} from "../../../src/rendezvous";
import {
    ECDHv2RendezvousCode as ECDHRendezvousCode,
    MSC3903ECDHPayload,
    MSC3903ECDHv2RendezvousChannel as MSC3903ECDHRendezvousChannel,
} from "../../../src/rendezvous/channels";
import { Device, MatrixClient } from "../../../src";
import {
    MSC3886SimpleHttpRendezvousTransport,
    MSC3886SimpleHttpRendezvousTransportDetails,
} from "../../../src/rendezvous/transports";
import { DummyTransport } from "./DummyTransport";
import { decodeBase64 } from "../../../src/base64";
import { logger } from "../../../src/logger";
import { CrossSigningKey, OwnDeviceKeys } from "../../../src/crypto-api";

type UserID = string;
type DeviceID = string;
type Fingerprint = string;
type SimpleDeviceMap = Record<UserID, Record<DeviceID, Fingerprint>>;

function mockDevice(userId: UserID, deviceId: DeviceID, fingerprint: Fingerprint): Device {
    return {
        deviceId,
        userId,
        getFingerprint: () => fingerprint,
    } as unknown as Device;
}

function mockDeviceMap(
    userId: UserID,
    deviceId: DeviceID,
    deviceKey?: Fingerprint,
    otherDevices: SimpleDeviceMap = {},
): Map<string, Map<string, Device>> {
    const deviceMap: Map<string, Map<string, Device>> = new Map();

    const myDevices: Map<string, Device> = new Map();
    if (deviceKey) {
        myDevices.set(deviceId, mockDevice(userId, deviceId, deviceKey));
    }
    deviceMap.set(userId, myDevices);

    for (const u in otherDevices) {
        let userDevices = deviceMap.get(u);
        if (!userDevices) {
            userDevices = new Map();
            deviceMap.set(u, userDevices);
        }
        for (const d in otherDevices[u]) {
            userDevices.set(d, mockDevice(u, d, otherDevices[u][d]));
        }
    }

    return deviceMap;
}

function makeMockClient(opts: {
    userId: UserID;
    deviceId: DeviceID;
    deviceKey?: Fingerprint;
    getLoginTokenEnabled: boolean;
    msc3882r0Only: boolean;
    msc3886Enabled: boolean;
    devices?: SimpleDeviceMap;
    verificationFunction?: (
        userId: string,
        deviceId: string,
        verified: boolean,
        blocked: boolean,
        known: boolean,
    ) => void;
    crossSigningIds?: Partial<Record<CrossSigningKey, string>>;
}): [MatrixClient, Map<string, Map<string, Device>>] {
    const deviceMap = mockDeviceMap(opts.userId, opts.deviceId, opts.deviceKey, opts.devices);
    return [
        {
            doesServerSupportUnstableFeature: jest.fn().mockImplementation((feature) => {
                if (feature === "org.matrix.msc3886") {
                    return opts.msc3886Enabled;
                } else if (feature === "org.matrix.msc3882") {
                    return opts.getLoginTokenEnabled;
                } else {
                    return false;
                }
            }),
            getVersions() {
                return {
                    unstable_features: {
                        "org.matrix.msc3882": opts.getLoginTokenEnabled,
                        "org.matrix.msc3886": opts.msc3886Enabled,
                    },
                };
            },
            getCachedCapabilities() {
                return opts.msc3882r0Only
                    ? {}
                    : {
                          capabilities: {
                              "m.get_login_token": {
                                  enabled: opts.getLoginTokenEnabled,
                              },
                          },
                      };
            },
            getUserId() {
                return opts.userId;
            },
            getSafeUserId() {
                return opts.userId;
            },
            getDeviceId() {
                return opts.deviceId;
            },
            baseUrl: "https://example.com",
            getCrypto() {
                return {
                    getUserDeviceInfo(
                        [userId]: string[],
                        downloadUncached?: boolean,
                    ): Promise<Map<string, Map<string, Device>>> {
                        return Promise.resolve(deviceMap);
                    },
                    getCrossSigningKeyId(key: CrossSigningKey): string | null {
                        return opts.crossSigningIds?.[key] ?? null;
                    },
                    setDeviceVerified(userId: string, deviceId: string, verified: boolean): Promise<void> {
                        return Promise.resolve();
                    },
                    crossSignDevice(deviceId: string): Promise<void> {
                        return Promise.resolve();
                    },
                    getOwnDeviceKeys(): Promise<OwnDeviceKeys> {
                        return Promise.resolve({
                            ed25519: opts.deviceKey!,
                            curve25519: "aaaa",
                        });
                    },
                };
            },
        } as unknown as MatrixClient,
        deviceMap,
    ];
}

function makeTransport(name: string, uri = "https://test.rz/123456") {
    return new DummyTransport<any, MSC3903ECDHPayload>(name, { type: "http.v1", uri });
}

describe("Rendezvous", function () {
    beforeAll(async function () {
        await global.Olm.init();
    });

    let httpBackend: MockHttpBackend;
    let fetchFn: typeof global.fetch;
    let transports: DummyTransport<any, MSC3903ECDHPayload>[];
    const userId: UserID = "@user:example.com";

    beforeEach(function () {
        httpBackend = new MockHttpBackend();
        fetchFn = httpBackend.fetchFn as typeof global.fetch;
        transports = [];
    });

    afterEach(function () {
        transports.forEach((x) => x.cleanup());
    });

    it("generate and cancel", async function () {
        const [alice] = makeMockClient({
            userId,
            deviceId: "ALICE",
            msc3886Enabled: false,
            getLoginTokenEnabled: true,
            msc3882r0Only: true,
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
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);

        expect(aliceRz.code).toBeUndefined();

        const codePromise = aliceRz.generateCode();
        await httpBackend.flush("");

        await aliceRz.generateCode();

        expect(typeof aliceRz.code).toBe("string");

        await codePromise;

        const code = JSON.parse(aliceRz.code!) as RendezvousCode;

        expect(code.intent).toEqual(RendezvousIntent.RECIPROCATE_LOGIN_ON_EXISTING_DEVICE);
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
        await expect(cancelPromise).resolves.toBeUndefined();
        httpBackend.verifyNoOutstandingExpectation();
        httpBackend.verifyNoOutstandingRequests();

        await aliceRz.close();
    });

    async function testNoProtocols({
        getLoginTokenEnabled,
        msc3882r0Only,
    }: {
        getLoginTokenEnabled: boolean;
        msc3882r0Only: boolean;
    }) {
        const aliceTransport = makeTransport("Alice");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const [alice] = makeMockClient({
            userId,
            deviceId: "ALICE",
            msc3886Enabled: false,
            getLoginTokenEnabled,
            msc3882r0Only,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.finish",
                outcome: "unsupported",
            });
        })();

        await aliceStartProm;
        await bobStartPromise;
    }

    it("no protocols - r0", async function () {
        await testNoProtocols({ getLoginTokenEnabled: false, msc3882r0Only: true });
    });

    it("no protocols - stable", async function () {
        await testNoProtocols({ getLoginTokenEnabled: false, msc3882r0Only: false });
    });

    it("new device declines protocol with outcome unsupported", async function () {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const [alice] = makeMockClient({
            userId,
            deviceId: "ALICE",
            getLoginTokenEnabled: true,
            msc3882r0Only: false,
            msc3886Enabled: false,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.progress",
                protocols: ["org.matrix.msc3906.login_token"],
            });

            await bobEcdh.send({ type: "m.login.finish", outcome: "unsupported" });
        })();

        await aliceStartProm;
        await bobStartPromise;

        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UnsupportedAlgorithm);
    });

    it("new device requests an invalid protocol", async function () {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const [alice] = makeMockClient({
            userId,
            deviceId: "ALICE",
            getLoginTokenEnabled: true,
            msc3882r0Only: false,
            msc3886Enabled: false,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.progress",
                protocols: ["org.matrix.msc3906.login_token"],
            });

            await bobEcdh.send({ type: "m.login.progress", protocol: "bad protocol" });
        })();

        await aliceStartProm;
        await bobStartPromise;

        expect(aliceOnFailure).toHaveBeenCalledWith(RendezvousFailureReason.UnsupportedAlgorithm);
    });

    it("decline on existing device", async function () {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const [alice] = makeMockClient({
            userId: "alice",
            deviceId: "ALICE",
            getLoginTokenEnabled: true,
            msc3882r0Only: false,
            msc3886Enabled: false,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.progress",
                protocols: ["org.matrix.msc3906.login_token"],
            });

            await bobEcdh.send({ type: "m.login.progress", protocol: "org.matrix.msc3906.login_token" });
        })();

        await aliceStartProm;
        await bobStartPromise;

        await aliceRz.declineLoginOnExistingDevice();
        const loginToken = await bobEcdh.receive();
        expect(loginToken).toEqual({ type: "m.login.finish", outcome: "declined" });
    });

    it("approve on existing device + no verification", async function () {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const [alice] = makeMockClient({
            userId: "alice",
            deviceId: "ALICE",
            getLoginTokenEnabled: true,
            msc3882r0Only: false,
            msc3886Enabled: false,
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.progress",
                protocols: ["org.matrix.msc3906.login_token"],
            });

            await bobEcdh.send({ type: "m.login.progress", protocol: "org.matrix.msc3906.login_token" });
        })();

        await aliceStartProm;
        await bobStartPromise;

        const confirmProm = aliceRz.approveLoginOnExistingDevice("token");

        const bobCompleteProm = (async () => {
            const loginToken = await bobEcdh.receive();
            expect(loginToken).toEqual({ type: "m.login.progress", login_token: "token", homeserver: alice.baseUrl });
            await bobEcdh.send({ type: "m.login.finish", outcome: "success" });
        })();

        await confirmProm;
        await bobCompleteProm;
    });

    async function completeLogin(devices: SimpleDeviceMap) {
        const aliceTransport = makeTransport("Alice", "https://test.rz/123456");
        const bobTransport = makeTransport("Bob", "https://test.rz/999999");
        transports.push(aliceTransport, bobTransport);
        aliceTransport.otherParty = bobTransport;
        bobTransport.otherParty = aliceTransport;

        // alice is already signs in and generates a code
        const aliceOnFailure = jest.fn();
        const aliceVerification = jest.fn();
        const [alice, deviceMap] = makeMockClient({
            userId,
            deviceId: "ALICE",
            getLoginTokenEnabled: true,
            msc3882r0Only: false,
            msc3886Enabled: false,
            devices,
            deviceKey: "aaaa",
            verificationFunction: aliceVerification,
            crossSigningIds: {
                master: "mmmmm",
            },
        });
        const aliceEcdh = new MSC3903ECDHRendezvousChannel(aliceTransport, undefined, aliceOnFailure);
        const aliceRz = new MSC3906Rendezvous(aliceEcdh, alice);
        aliceTransport.onCancelled = aliceOnFailure;
        await aliceRz.generateCode();
        const code = JSON.parse(aliceRz.code!) as ECDHRendezvousCode;

        expect(code.rendezvous.key).toBeDefined();

        const aliceStartProm = aliceRz.startAfterShowingCode();

        // bob is try to sign in and scans the code
        const bobOnFailure = jest.fn();
        const bobEcdh = new MSC3903ECDHRendezvousChannel(
            bobTransport,
            decodeBase64(code.rendezvous.key), // alice's public key
            bobOnFailure,
        );

        const bobStartPromise = (async () => {
            const bobChecksum = await bobEcdh.connect();
            logger.info(`Bob checksums is ${bobChecksum} now sending intent`);
            // await bobEcdh.send({ type: 'm.login.progress', intent: RendezvousIntent.LOGIN_ON_NEW_DEVICE });

            // wait for protocols
            logger.info("Bob waiting for protocols");
            const protocols = await bobEcdh.receive();

            logger.info(`Bob protocols: ${JSON.stringify(protocols)}`);

            expect(protocols).toEqual({
                type: "m.login.progress",
                protocols: ["org.matrix.msc3906.login_token"],
            });

            await bobEcdh.send({ type: "m.login.progress", protocol: "org.matrix.msc3906.login_token" });
        })();

        await aliceStartProm;
        await bobStartPromise;

        const confirmProm = aliceRz.approveLoginOnExistingDevice("token");

        const bobLoginProm = (async () => {
            const loginToken = await bobEcdh.receive();
            expect(loginToken).toEqual({ type: "m.login.progress", login_token: "token", homeserver: alice.baseUrl });
            await bobEcdh.send({ type: "m.login.finish", outcome: "success", device_id: "BOB", device_key: "bbbb" });
        })();

        expect(await confirmProm).toEqual("BOB");
        await bobLoginProm;

        return {
            aliceTransport,
            aliceEcdh,
            aliceRz,
            bobTransport,
            bobEcdh,
            deviceMap,
        };
    }

    it("approve on existing device + verification", async function () {
        const { bobEcdh, aliceRz } = await completeLogin({
            [userId]: {
                BOB: "bbbb",
            },
        });
        const verifyProm = aliceRz.verifyNewDeviceOnExistingDevice();

        const bobVerifyProm = (async () => {
            const verified = await bobEcdh.receive();
            expect(verified).toEqual({
                type: "m.login.finish",
                outcome: "verified",
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
        await expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow();
    });

    it("device appears online within timeout", async function () {
        const devices: SimpleDeviceMap = {};
        const { aliceRz, deviceMap } = await completeLogin(devices);
        // device appears before the timeout
        setTimeout(() => {
            deviceMap.get(userId)!.set("BOB", mockDevice(userId, "BOB", "bbbb"));
        }, 1000);
        await aliceRz.verifyNewDeviceOnExistingDevice(2000);
    });

    it("device appears online after timeout", async function () {
        const devices: SimpleDeviceMap = {};
        const { aliceRz, deviceMap } = await completeLogin(devices);
        // device appears after the timeout
        setTimeout(() => {
            deviceMap.get(userId)!.set("BOB", mockDevice(userId, "BOB", "bbbb"));
        }, 1500);
        await expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow();
    });

    it("mismatched device key", async function () {
        const { aliceRz } = await completeLogin({
            [userId]: {
                BOB: "XXXX",
            },
        });
        await expect(aliceRz.verifyNewDeviceOnExistingDevice(1000)).rejects.toThrow(/different key/);
    });
});
