import '../../../olm-loader';

import expect from 'expect';
import Promise from 'bluebird';

import sdk from '../../../..';
import algorithms from '../../../../lib/crypto/algorithms';
import WebStorageSessionStore from '../../../../lib/store/session/webstorage';
import MemoryCryptoStore from '../../../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../../../MockStorageApi';
import testUtils from '../../../test-utils';
import OlmDevice from '../../../../lib/crypto/OlmDevice';
import Crypto from '../../../../lib/crypto';

const MatrixEvent = sdk.MatrixEvent;
const MegolmDecryption = algorithms.DECRYPTION_CLASSES['m.megolm.v1.aes-sha2'];
const MegolmEncryption = algorithms.ENCRYPTION_CLASSES['m.megolm.v1.aes-sha2'];

const ROOM_ID = '!ROOM:ID';

const Olm = global.Olm;

describe("MegolmDecryption", function() {
    if (!global.Olm) {
        console.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    let megolmDecryption;
    let mockOlmLib;
    let mockCrypto;
    let mockBaseApis;

    beforeEach(async function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        await Olm.init();

        mockCrypto = testUtils.mock(Crypto, 'Crypto');
        mockBaseApis = {};

        const mockStorage = new MockStorageApi();
        const sessionStore = new WebStorageSessionStore(mockStorage);
        const cryptoStore = new MemoryCryptoStore(mockStorage);

        const olmDevice = new OlmDevice(sessionStore, cryptoStore);

        megolmDecryption = new MegolmDecryption({
            userId: '@user:id',
            crypto: mockCrypto,
            olmDevice: olmDevice,
            baseApis: mockBaseApis,
            roomId: ROOM_ID,
        });


        // we stub out the olm encryption bits
        mockOlmLib = {};
        mockOlmLib.ensureOlmSessionsForDevices = expect.createSpy();
        mockOlmLib.encryptMessageForDevice =
            expect.createSpy().andReturn(Promise.resolve());
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
                mockCrypto.getStoredDevice.andReturn(deviceInfo);

                mockOlmLib.ensureOlmSessionsForDevices.andReturn(
                    Promise.resolve({'@alice:foo': {'alidevice': {
                        sessionId: 'alisession',
                    }}}),
                );

                const awaitEncryptForDevice = new Promise((res, rej) => {
                    mockOlmLib.encryptMessageForDevice.andCall(() => {
                        res();
                        return Promise.resolve();
                    });
                });

                mockBaseApis.sendToDevice = expect.createSpy();

                // do the share
                megolmDecryption.shareKeysWithDevice(keyRequest);

                // it's asynchronous, so we have to wait a bit
                return awaitEncryptForDevice;
            }).then(() => {
                // check that it called encryptMessageForDevice with
                // appropriate args.
                expect(mockOlmLib.encryptMessageForDevice.calls.length)
                    .toEqual(1);

                const call = mockOlmLib.encryptMessageForDevice.calls[0];
                const payload = call.arguments[6];

                expect(payload.type).toEqual("m.forwarded_room_key");
                expect(payload.content).toInclude({
                    sender_key: "SENDER_CURVE25519",
                    sender_claimed_ed25519_key: "SENDER_ED25519",
                    session_id: groupSession.session_id(),
                    chain_index: 0,
                    forwarding_curve25519_key_chain: [],
                });
                expect(payload.content.session_key).toExist();
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

            const successHandler = expect.createSpy();
            const failureHandler = expect.createSpy()
                .andCall((err) => {
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
                expect(successHandler).toNotHaveBeenCalled();
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
            const sessionStore = new WebStorageSessionStore(mockStorage);
            const cryptoStore = new MemoryCryptoStore(mockStorage);

            const olmDevice = new OlmDevice(sessionStore, cryptoStore);
            olmDevice.verifySignature = expect.createSpy();
            await olmDevice.init();

            mockBaseApis.claimOneTimeKeys = expect.createSpy().andReturn(Promise.resolve({
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
            mockBaseApis.sendToDevice = expect.createSpy().andReturn(Promise.resolve());

            mockCrypto.downloadKeys.andReturn(Promise.resolve({
                '@alice:home.server': {
                    aliceDevice: {
                        deviceId: 'aliceDevice',
                        isBlocked: expect.createSpy().andReturn(false),
                        isUnverified: expect.createSpy().andReturn(false),
                        getIdentityKey: expect.createSpy().andReturn(
                            'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE',
                        ),
                        getFingerprint: expect.createSpy().andReturn(''),
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
                getEncryptionTargetMembers: expect.createSpy().andReturn(
                    [{userId: "@alice:home.server"}],
                ),
                getBlacklistUnverifiedDevices: expect.createSpy().andReturn(false),
            };
            const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                body: "Some text",
            });
            expect(mockRoom.getEncryptionTargetMembers).toHaveBeenCalled();

            // this should have claimed a key for alice as it's starting a new session
            expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalled(
                [['@alice:home.server', 'aliceDevice']], 'signed_curve25519',
            );
            expect(mockCrypto.downloadKeys).toHaveBeenCalledWith(
                ['@alice:home.server'], false,
            );
            expect(mockBaseApis.sendToDevice).toHaveBeenCalled();
            expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalled(
                [['@alice:home.server', 'aliceDevice']], 'signed_curve25519',
            );

            mockBaseApis.claimOneTimeKeys.reset();

            const ct2 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                body: "Some more text",
            });

            // this should *not* have claimed a key as it should be using the same session
            expect(mockBaseApis.claimOneTimeKeys).toNotHaveBeenCalled();

            // likewise they should show the same session ID
            expect(ct2.session_id).toEqual(ct1.session_id);
        });
    });
});
