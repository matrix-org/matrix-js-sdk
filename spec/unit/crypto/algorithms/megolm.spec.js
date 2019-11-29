import '../../../olm-loader';

import Promise from 'bluebird';

import sdk from '../../../..';
import algorithms from '../../../../lib/crypto/algorithms';
import MemoryCryptoStore from '../../../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../../../MockStorageApi';
import testUtils from '../../../test-utils';
import OlmDevice from '../../../../lib/crypto/OlmDevice';
import Crypto from '../../../../lib/crypto';
import logger from '../../../../src/logger';

const MatrixEvent = sdk.MatrixEvent;
const MegolmDecryption = algorithms.DECRYPTION_CLASSES['m.megolm.v1.aes-sha2'];
const MegolmEncryption = algorithms.ENCRYPTION_CLASSES['m.megolm.v1.aes-sha2'];

const ROOM_ID = '!ROOM:ID';

const Olm = global.Olm;

describe("MegolmDecryption", function() {
    if (!global.Olm) {
        logger.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return Olm.init();
    });

    let megolmDecryption;
    let mockOlmLib;
    let mockCrypto;
    let mockBaseApis;

    beforeEach(async function() {
        mockCrypto = testUtils.mock(Crypto, 'Crypto');
        mockBaseApis = {};

        const mockStorage = new MockStorageApi();
        const cryptoStore = new MemoryCryptoStore(mockStorage);

        const olmDevice = new OlmDevice(cryptoStore);

        megolmDecryption = new MegolmDecryption({
            userId: '@user:id',
            crypto: mockCrypto,
            olmDevice: olmDevice,
            baseApis: mockBaseApis,
            roomId: ROOM_ID,
        });


        // we stub out the olm encryption bits
        mockOlmLib = {};
        mockOlmLib.ensureOlmSessionsForDevices = jest.fn();
        mockOlmLib.encryptMessageForDevice =
            jest.fn().mockReturnValue(Promise.resolve());
        megolmDecryption.olmlib = mockOlmLib;
    });

    describe('receives some keys:', function() {
        let groupSession;
        beforeEach(async function() {
            groupSession = new global.Olm.OutboundGroupSession();
            groupSession.create();

            // construct a fake decrypted key event via the use of a mocked
            // 'crypto' implementation.
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
            });
            const decryptedData = {
                clearEvent: {
                    type: 'm.room_key',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        room_id: ROOM_ID,
                        session_id: groupSession.session_id(),
                        session_key: groupSession.session_key(),
                    },
                },
                senderCurve25519Key: "SENDER_CURVE25519",
                claimedEd25519Key: "SENDER_ED25519",
            };

            const mockCrypto = {
                decryptEvent: function() {
                    return Promise.resolve(decryptedData);
                },
            };

            await event.attemptDecryption(mockCrypto).then(() => {
                megolmDecryption.onRoomKeyEvent(event);
            });
        });

        it('can decrypt an event', function() {
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                    ciphertext: groupSession.encrypt(JSON.stringify({
                        room_id: ROOM_ID,
                        content: 'testytest',
                    })),
                },
            });

            return megolmDecryption.decryptEvent(event).then((res) => {
                expect(res.clearEvent.content).toEqual('testytest');
            });
        });

        it('can respond to a key request event', function() {
            const keyRequest = {
                userId: '@alice:foo',
                deviceId: 'alidevice',
                requestBody: {
                    room_id: ROOM_ID,
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                },
            };

            return megolmDecryption.hasKeysForKeyRequest(
                keyRequest,
            ).then((hasKeys) => {
                expect(hasKeys).toBe(true);

                // set up some pre-conditions for the share call
                const deviceInfo = {};
                mockCrypto.getStoredDevice.mockReturnValue(deviceInfo);

                mockOlmLib.ensureOlmSessionsForDevices.mockReturnValue(
                    Promise.resolve({'@alice:foo': {'alidevice': {
                        sessionId: 'alisession',
                    }}}),
                );

                const awaitEncryptForDevice = new Promise((res, rej) => {
                    mockOlmLib.encryptMessageForDevice.mockImplementation(() => {
                        res();
                        return Promise.resolve();
                    });
                });

                mockBaseApis.sendToDevice = jest.fn();

                // do the share
                megolmDecryption.shareKeysWithDevice(keyRequest);

                // it's asynchronous, so we have to wait a bit
                return awaitEncryptForDevice;
            }).then(() => {
                // check that it called encryptMessageForDevice with
                // appropriate args.
                expect(mockOlmLib.encryptMessageForDevice).toBeCalledTimes(1);

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

        it("can detect replay attacks", function() {
            // trying to decrypt two different messages (marked by different
            // event IDs or timestamps) using the same (sender key, session id,
            // message index) triple should result in an exception being thrown
            // as it should be detected as a replay attack.
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(JSON.stringify({
                room_id: ROOM_ID,
                content: 'testytest',
            }));
            const event1 = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    sender_key: "SENDER_CURVE25519",
                    session_id: sessionId,
                    ciphertext: cipherText,
                },
                event_id: "$event1",
                origin_server_ts: 1507753886000,
            });

            const successHandler = jest.fn();
            const failureHandler = jest.fn((err) => {
                expect(err.toString()).toMatch(
                    /Duplicate message index, possible replay attack/,
                );
            });

            return megolmDecryption.decryptEvent(event1).then((res) => {
                const event2 = new MatrixEvent({
                    type: 'm.room.encrypted',
                    room_id: ROOM_ID,
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        sender_key: "SENDER_CURVE25519",
                        session_id: sessionId,
                        ciphertext: cipherText,
                    },
                    event_id: "$event2",
                    origin_server_ts: 1507754149000,
                });

                return megolmDecryption.decryptEvent(event2);
            }).then(
                successHandler,
                failureHandler,
            ).then(() => {
                expect(successHandler).not.toHaveBeenCalled();
                expect(failureHandler).toHaveBeenCalled();
            });
        });

        it("allows re-decryption of the same event", function() {
            // in contrast with the previous test, if the event ID and
            // timestamp are the same, then it should not be considered a
            // replay attack
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(JSON.stringify({
                room_id: ROOM_ID,
                content: 'testytest',
            }));
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
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

        it("re-uses sessions for sequential messages", async function() {
            const mockStorage = new MockStorageApi();
            const cryptoStore = new MemoryCryptoStore(mockStorage);

            const olmDevice = new OlmDevice(cryptoStore);
            olmDevice.verifySignature = jest.fn();
            await olmDevice.init();

            mockBaseApis.claimOneTimeKeys = jest.fn().mockReturnValue(Promise.resolve({
                one_time_keys: {
                    '@alice:home.server': {
                        aliceDevice: {
                            'signed_curve25519:flooble': {
                                key: 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI',
                                signatures: {
                                    '@alice:home.server': {
                                        'ed25519:aliceDevice': 'totally valid',
                                    },
                                },
                            },
                        },
                    },
                },
            }));
            mockBaseApis.sendToDevice = jest.fn().mockReturnValue(Promise.resolve());

            mockCrypto.downloadKeys.mockReturnValue(Promise.resolve({
                '@alice:home.server': {
                    aliceDevice: {
                        deviceId: 'aliceDevice',
                        isBlocked: jest.fn().mockReturnValue(false),
                        isUnverified: jest.fn().mockReturnValue(false),
                        getIdentityKey: jest.fn().mockReturnValue(
                            'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE',
                        ),
                        getFingerprint: jest.fn().mockReturnValue(''),
                    },
                },
            }));

            const megolmEncryption = new MegolmEncryption({
                userId: '@user:id',
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: mockBaseApis,
                roomId: ROOM_ID,
                config: {
                    rotation_period_ms: 9999999999999,
                },
            });
            const mockRoom = {
                getEncryptionTargetMembers: jest.fn().mockReturnValue(
                    [{userId: "@alice:home.server"}],
                ),
                getBlacklistUnverifiedDevices: jest.fn().mockReturnValue(false),
            };
            const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                body: "Some text",
            });
            expect(mockRoom.getEncryptionTargetMembers).toHaveBeenCalled();

            // this should have claimed a key for alice as it's starting a new session
            expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                [['@alice:home.server', 'aliceDevice']], 'signed_curve25519',
            );
            expect(mockCrypto.downloadKeys).toHaveBeenCalledWith(
                ['@alice:home.server'], false,
            );
            expect(mockBaseApis.sendToDevice).toHaveBeenCalled();
            expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                [['@alice:home.server', 'aliceDevice']], 'signed_curve25519',
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
    });
});
