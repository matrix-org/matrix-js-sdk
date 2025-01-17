/*
Copyright 2022 - 2023 The Matrix.org Foundation C.I.C.

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

import { MockedObject } from "jest-mock";

import type { DeviceInfoMap } from "../../../../src/crypto/DeviceList";
import "../../../olm-loader";
import type { OutboundGroupSession } from "@matrix-org/olm";
import * as algorithms from "../../../../src/crypto/algorithms";
import { MemoryCryptoStore } from "../../../../src/crypto/store/memory-crypto-store";
import * as testUtils from "../../../test-utils/test-utils";
import { OlmDevice } from "../../../../src/crypto/OlmDevice";
import { Crypto, IncomingRoomKeyRequest } from "../../../../src/crypto";
import { logger } from "../../../../src/logger";
import { MatrixEvent } from "../../../../src/models/event";
import { Room } from "../../../../src/models/room";
import * as olmlib from "../../../../src/crypto/olmlib";
import { MatrixClient, RoomMember } from "../../../../src";
import { DeviceInfo } from "../../../../src/crypto/deviceinfo";
import { DeviceTrustLevel } from "../../../../src/crypto/CrossSigning";
import { MegolmEncryption as MegolmEncryptionClass } from "../../../../src/crypto/algorithms/megolm";
import { sleep } from "../../../../src/utils";

const MegolmDecryption = algorithms.DECRYPTION_CLASSES.get("m.megolm.v1.aes-sha2")!;
const MegolmEncryption = algorithms.ENCRYPTION_CLASSES.get("m.megolm.v1.aes-sha2")!;

const ROOM_ID = "!ROOM:ID";

const Olm = globalThis.Olm;

describe("MegolmDecryption", function () {
    if (!globalThis.Olm) {
        logger.warn("Not running megolm unit tests: libolm not present");
        return;
    }

    beforeAll(function () {
        return Olm.init();
    });

    let megolmDecryption: algorithms.DecryptionAlgorithm;
    let mockOlmLib: MockedObject<typeof olmlib>;
    let mockCrypto: MockedObject<Crypto>;
    let mockBaseApis: MockedObject<MatrixClient>;

    beforeEach(async function () {
        mockCrypto = testUtils.mock(Crypto, "Crypto") as MockedObject<Crypto>;

        // @ts-ignore assigning to readonly prop
        mockCrypto.backupManager = {
            backupGroupSession: () => {},
        };

        mockBaseApis = {
            claimOneTimeKeys: jest.fn(),
            sendToDevice: jest.fn(),
            queueToDevice: jest.fn(),
        } as unknown as MockedObject<MatrixClient>;

        const cryptoStore = new MemoryCryptoStore();

        const olmDevice = new OlmDevice(cryptoStore);

        megolmDecryption = new MegolmDecryption({
            userId: "@user:id",
            crypto: mockCrypto,
            olmDevice: olmDevice,
            baseApis: mockBaseApis,
            roomId: ROOM_ID,
        });

        // we stub out the olm encryption bits
        mockOlmLib = {
            encryptMessageForDevice: jest.fn().mockResolvedValue(undefined),
            ensureOlmSessionsForDevices: jest.fn(),
        } as unknown as MockedObject<typeof olmlib>;

        // @ts-ignore illegal assignment that makes these tests work :/
        megolmDecryption.olmlib = mockOlmLib;

        jest.clearAllMocks();
    });

    describe("receives some keys:", function () {
        let groupSession: OutboundGroupSession;
        beforeEach(async function () {
            groupSession = new globalThis.Olm.OutboundGroupSession();
            groupSession.create();

            // construct a fake decrypted key event via the use of a mocked
            // 'crypto' implementation.
            const event = new MatrixEvent({
                type: "m.room.encrypted",
            });
            const decryptedData = {
                clearEvent: {
                    type: "m.room_key",
                    content: {
                        algorithm: "m.megolm.v1.aes-sha2",
                        room_id: ROOM_ID,
                        session_id: groupSession.session_id(),
                        session_key: groupSession.session_key(),
                    },
                },
                senderCurve25519Key: "SENDER_CURVE25519",
                claimedEd25519Key: "SENDER_ED25519",
            };
            event.getWireType = () => "m.room.encrypted";
            event.getWireContent = () => {
                return {
                    algorithm: "m.olm.v1.curve25519-aes-sha2",
                };
            };

            const mockCrypto = {
                decryptEvent: function () {
                    return Promise.resolve(decryptedData);
                },
            } as unknown as Crypto;

            await event.attemptDecryption(mockCrypto).then(() => {
                megolmDecryption.onRoomKeyEvent(event);
            });
        });

        it("can decrypt an event", function () {
            const event = new MatrixEvent({
                type: "m.room.encrypted",
                room_id: ROOM_ID,
                content: {
                    algorithm: "m.megolm.v1.aes-sha2",
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                    ciphertext: groupSession.encrypt(
                        JSON.stringify({
                            room_id: ROOM_ID,
                            content: "testytest",
                        }),
                    ),
                },
            });

            return megolmDecryption.decryptEvent(event).then((res) => {
                expect(res.clearEvent.content).toEqual("testytest");
            });
        });

        it("can respond to a key request event", function () {
            const keyRequest: IncomingRoomKeyRequest = {
                requestId: "123",
                share: jest.fn(),
                userId: "@alice:foo",
                deviceId: "alidevice",
                requestBody: {
                    algorithm: "",
                    room_id: ROOM_ID,
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                },
            };

            return megolmDecryption
                .hasKeysForKeyRequest(keyRequest)
                .then((hasKeys) => {
                    expect(hasKeys).toBe(true);

                    // set up some pre-conditions for the share call
                    const deviceInfo = {} as DeviceInfo;
                    mockCrypto.getStoredDevice.mockReturnValue(deviceInfo);

                    mockOlmLib.ensureOlmSessionsForDevices.mockResolvedValue(
                        new Map([
                            [
                                "@alice:foo",
                                new Map([
                                    [
                                        "alidevice",
                                        {
                                            sessionId: "alisession",
                                            device: new DeviceInfo("alidevice"),
                                        },
                                    ],
                                ]),
                            ],
                        ]),
                    );

                    const awaitEncryptForDevice = new Promise<void>((res, rej) => {
                        mockOlmLib.encryptMessageForDevice.mockImplementation(() => {
                            res();
                            return Promise.resolve();
                        });
                    });

                    mockBaseApis.sendToDevice.mockReset();
                    mockBaseApis.queueToDevice.mockReset();

                    // do the share
                    megolmDecryption.shareKeysWithDevice(keyRequest);

                    // it's asynchronous, so we have to wait a bit
                    return awaitEncryptForDevice;
                })
                .then(() => {
                    // check that it called encryptMessageForDevice with
                    // appropriate args.
                    expect(mockOlmLib.encryptMessageForDevice).toHaveBeenCalledTimes(1);

                    const call = mockOlmLib.encryptMessageForDevice.mock.calls[0];
                    const payload = call[6];

                    expect(payload.type).toEqual("m.forwarded_room_key");
                    expect(payload.content).toMatchObject({
                        sender_key: "SENDER_CURVE25519",
                        sender_claimed_ed25519_key: "SENDER_ED25519",
                        session_id: groupSession.session_id(),
                        chain_index: 0,
                        forwarding_curve25519_key_chain: [],
                    });
                    expect(payload.content.session_key).toBeDefined();
                });
        });

        it("can detect replay attacks", function () {
            // trying to decrypt two different messages (marked by different
            // event IDs or timestamps) using the same (sender key, session id,
            // message index) triple should result in an exception being thrown
            // as it should be detected as a replay attack.
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(
                JSON.stringify({
                    room_id: ROOM_ID,
                    content: "testytest",
                }),
            );
            const event1 = new MatrixEvent({
                type: "m.room.encrypted",
                room_id: ROOM_ID,
                content: {
                    algorithm: "m.megolm.v1.aes-sha2",
                    sender_key: "SENDER_CURVE25519",
                    session_id: sessionId,
                    ciphertext: cipherText,
                },
                event_id: "$event1",
                origin_server_ts: 1507753886000,
            });

            const successHandler = jest.fn();
            const failureHandler = jest.fn((err) => {
                expect(err.toString()).toMatch(/Duplicate message index, possible replay attack/);
            });

            return megolmDecryption
                .decryptEvent(event1)
                .then((res) => {
                    const event2 = new MatrixEvent({
                        type: "m.room.encrypted",
                        room_id: ROOM_ID,
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            sender_key: "SENDER_CURVE25519",
                            session_id: sessionId,
                            ciphertext: cipherText,
                        },
                        event_id: "$event2",
                        origin_server_ts: 1507754149000,
                    });

                    return megolmDecryption.decryptEvent(event2);
                })
                .then(successHandler, failureHandler)
                .then(() => {
                    expect(successHandler).not.toHaveBeenCalled();
                    expect(failureHandler).toHaveBeenCalled();
                });
        });

        it("allows re-decryption of the same event", function () {
            // in contrast with the previous test, if the event ID and
            // timestamp are the same, then it should not be considered a
            // replay attack
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(
                JSON.stringify({
                    room_id: ROOM_ID,
                    content: "testytest",
                }),
            );
            const event = new MatrixEvent({
                type: "m.room.encrypted",
                room_id: ROOM_ID,
                content: {
                    algorithm: "m.megolm.v1.aes-sha2",
                    sender_key: "SENDER_CURVE25519",
                    session_id: sessionId,
                    ciphertext: cipherText,
                },
                event_id: "$event1",
                origin_server_ts: 1507753886000,
            });

            return megolmDecryption.decryptEvent(event).then((res) => {
                return megolmDecryption.decryptEvent(event);
                // test is successful if no exception is thrown
            });
        });

        describe("session reuse and key reshares", () => {
            const rotationPeriodMs = 999 * 24 * 60 * 60 * 1000; // 999 days, so we don't have to deal with it

            let megolmEncryption: MegolmEncryptionClass;
            let aliceDeviceInfo: DeviceInfo;
            let mockRoom: Room;
            let olmDevice: OlmDevice;

            beforeEach(async () => {
                const cryptoStore = new MemoryCryptoStore();

                olmDevice = new OlmDevice(cryptoStore);
                olmDevice.verifySignature = jest.fn();
                await olmDevice.init();

                mockBaseApis.claimOneTimeKeys.mockResolvedValue({
                    failures: {},
                    one_time_keys: {
                        "@alice:home.server": {
                            aliceDevice: {
                                "signed_curve25519:flooble": {
                                    key: "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI",
                                    signatures: {
                                        "@alice:home.server": {
                                            "ed25519:aliceDevice": "totally valid",
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
                mockBaseApis.sendToDevice.mockResolvedValue({});
                mockBaseApis.queueToDevice.mockResolvedValue(undefined);

                aliceDeviceInfo = {
                    deviceId: "aliceDevice",
                    isBlocked: jest.fn().mockReturnValue(false),
                    isUnverified: jest.fn().mockReturnValue(false),
                    getIdentityKey: jest.fn().mockReturnValue("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE"),
                    getFingerprint: jest.fn().mockReturnValue(""),
                } as unknown as DeviceInfo;

                mockCrypto.downloadKeys.mockReturnValue(
                    Promise.resolve(new Map([["@alice:home.server", new Map([["aliceDevice", aliceDeviceInfo]])]])),
                );

                mockCrypto.checkDeviceTrust.mockReturnValue({
                    isVerified: () => false,
                } as DeviceTrustLevel);

                megolmEncryption = new MegolmEncryption({
                    userId: "@user:id",
                    deviceId: "12345",
                    crypto: mockCrypto,
                    olmDevice: olmDevice,
                    baseApis: mockBaseApis,
                    roomId: ROOM_ID,
                    config: {
                        algorithm: "m.megolm.v1.aes-sha2",
                        rotation_period_ms: rotationPeriodMs,
                    },
                }) as MegolmEncryptionClass;

                // Splice the real method onto the mock object as megolm uses this method
                // on the crypto class in order to encrypt / start sessions
                // @ts-ignore Mock
                mockCrypto.encryptAndSendToDevices = Crypto.prototype.encryptAndSendToDevices;
                // @ts-ignore Mock
                mockCrypto.olmDevice = olmDevice;
                // @ts-ignore Mock
                mockCrypto.baseApis = mockBaseApis;

                mockRoom = {
                    roomId: ROOM_ID,
                    getEncryptionTargetMembers: jest.fn().mockReturnValue([{ userId: "@alice:home.server" }]),
                    getBlacklistUnverifiedDevices: jest.fn().mockReturnValue(false),
                    shouldEncryptForInvitedMembers: jest.fn().mockReturnValue(false),
                } as unknown as Room;
            });

            it("should use larger otkTimeout when preparing to encrypt room", async () => {
                megolmEncryption.prepareToEncrypt(mockRoom);
                await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });
                expect(mockRoom.getEncryptionTargetMembers).toHaveBeenCalled();

                expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                    [["@alice:home.server", "aliceDevice"]],
                    "signed_curve25519",
                    10000,
                );
            });

            it("should generate a new session if this one needs rotation", async () => {
                // @ts-ignore - private method access
                const session = await megolmEncryption.prepareNewSession(false);
                session.creationTime -= rotationPeriodMs + 10000; // a smidge over the rotation time
                // Inject expired session which needs rotation
                // @ts-ignore - private field access
                megolmEncryption.setupPromise = Promise.resolve(session);

                // @ts-ignore - private method access
                const prepareNewSessionSpy = jest.spyOn(megolmEncryption, "prepareNewSession");
                await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });
                expect(prepareNewSessionSpy).toHaveBeenCalledTimes(1);
            });

            it("re-uses sessions for sequential messages", async function () {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });
                expect(mockRoom.getEncryptionTargetMembers).toHaveBeenCalled();

                // this should have claimed a key for alice as it's starting a new session
                expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                    [["@alice:home.server", "aliceDevice"]],
                    "signed_curve25519",
                    2000,
                );
                expect(mockCrypto.downloadKeys).toHaveBeenCalledWith(["@alice:home.server"], false);
                expect(mockBaseApis.queueToDevice).toHaveBeenCalled();
                expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                    [["@alice:home.server", "aliceDevice"]],
                    "signed_curve25519",
                    2000,
                );

                mockBaseApis.claimOneTimeKeys.mockReset();

                const ct2 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some more text",
                });

                // this should *not* have claimed a key as it should be using the same session
                expect(mockBaseApis.claimOneTimeKeys).not.toHaveBeenCalled();

                // likewise they should show the same session ID
                expect(ct2.session_id).toEqual(ct1.session_id);
            });

            it("re-shares keys to devices it's already sent to", async function () {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });

                mockBaseApis.sendToDevice.mockClear();
                await megolmEncryption.reshareKeyWithDevice!(
                    olmDevice.deviceCurve25519Key!,
                    ct1.session_id,
                    "@alice:home.server",
                    aliceDeviceInfo,
                );

                expect(mockBaseApis.sendToDevice).toHaveBeenCalled();
            });

            it("does not re-share keys to devices whose keys have changed", async function () {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });

                aliceDeviceInfo.getIdentityKey = jest
                    .fn()
                    .mockReturnValue("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWI");

                mockBaseApis.queueToDevice.mockClear();
                await megolmEncryption.reshareKeyWithDevice!(
                    olmDevice.deviceCurve25519Key!,
                    ct1.session_id,
                    "@alice:home.server",
                    aliceDeviceInfo,
                );

                expect(mockBaseApis.queueToDevice).not.toHaveBeenCalled();
            });

            it("shouldn't wedge the setup promise if sharing a room key fails", async () => {
                // @ts-ignore - private field access
                const initialSetupPromise = await megolmEncryption.setupPromise;
                expect(initialSetupPromise).toBe(null);

                // @ts-ignore - private field access
                megolmEncryption.prepareSession = () => {
                    throw new Error("Can't prepare session");
                };

                await expect(() =>
                    // @ts-ignore - private field access
                    megolmEncryption.ensureOutboundSession(mockRoom, {}, {}, true),
                ).rejects.toThrow();

                // @ts-ignore - private field access
                const finalSetupPromise = await megolmEncryption.setupPromise;
                expect(finalSetupPromise).toBe(null);
            });
        });
    });

    describe("prepareToEncrypt", () => {
        let megolm: MegolmEncryptionClass;
        let room: jest.Mocked<Room>;

        const deviceMap: DeviceInfoMap = new Map([
            [
                "user-a",
                new Map([
                    ["device-a", new DeviceInfo("device-a")],
                    ["device-b", new DeviceInfo("device-b")],
                    ["device-c", new DeviceInfo("device-c")],
                ]),
            ],
            [
                "user-b",
                new Map([
                    ["device-d", new DeviceInfo("device-d")],
                    ["device-e", new DeviceInfo("device-e")],
                    ["device-f", new DeviceInfo("device-f")],
                ]),
            ],
            [
                "user-c",
                new Map([
                    ["device-g", new DeviceInfo("device-g")],
                    ["device-h", new DeviceInfo("device-h")],
                    ["device-i", new DeviceInfo("device-i")],
                ]),
            ],
        ]);

        beforeEach(() => {
            room = testUtils.mock(Room, "Room") as jest.Mocked<Room>;
            room.getEncryptionTargetMembers.mockImplementation(async () => [
                new RoomMember(room.roomId, "@user:example.org"),
            ]);
            room.getBlacklistUnverifiedDevices.mockReturnValue(false);

            mockCrypto.downloadKeys.mockImplementation(async () => deviceMap);

            mockCrypto.checkDeviceTrust.mockImplementation(() => new DeviceTrustLevel(true, true, true, true));

            const olmDevice = new OlmDevice(new MemoryCryptoStore());
            megolm = new MegolmEncryptionClass({
                userId: "@user:id",
                deviceId: "12345",
                crypto: mockCrypto,
                olmDevice,
                baseApis: mockBaseApis,
                roomId: room.roomId,
                config: {
                    algorithm: "m.megolm.v1.aes-sha2",
                    rotation_period_ms: 9_999_999,
                },
            });
        });

        it("checks each device", async () => {
            megolm.prepareToEncrypt(room);
            //@ts-ignore private member access, gross
            await megolm.encryptionPreparation?.promise;

            for (const [userId, devices] of deviceMap) {
                for (const deviceId of devices.keys()) {
                    expect(mockCrypto.checkDeviceTrust).toHaveBeenCalledWith(userId, deviceId);
                }
            }
        });

        it("is cancellable", async () => {
            const stop = megolm.prepareToEncrypt(room);

            const before = mockCrypto.checkDeviceTrust.mock.calls.length;
            stop();

            // Ensure that no more devices were checked after cancellation.
            await sleep(10);
            expect(mockCrypto.checkDeviceTrust).toHaveBeenCalledTimes(before);
        });
    });
});
