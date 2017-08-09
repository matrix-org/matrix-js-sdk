try {
    global.Olm = require('olm');
} catch (e) {
    console.warn("unable to run megolm tests: libolm not available");
}

import expect from 'expect';
import Promise from 'bluebird';

import sdk from '../../../..';
import algorithms from '../../../../lib/crypto/algorithms';
import WebStorageSessionStore from '../../../../lib/store/session/webstorage';
import MockStorageApi from '../../../MockStorageApi';
import testUtils from '../../../test-utils';

// Crypto and OlmDevice won't import unless we have global.Olm
let OlmDevice;
let Crypto;
if (global.Olm) {
    OlmDevice = require('../../../../lib/crypto/OlmDevice');
    Crypto = require('../../../../lib/crypto');
}

const MatrixEvent = sdk.MatrixEvent;
const MegolmDecryption = algorithms.DECRYPTION_CLASSES['m.megolm.v1.aes-sha2'];

const ROOM_ID = '!ROOM:ID';

describe("MegolmDecryption", function() {
    if (!global.Olm) {
        console.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    let megolmDecryption;
    let mockOlmLib;
    let mockCrypto;
    let mockBaseApis;

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        mockCrypto = testUtils.mock(Crypto, 'Crypto');
        mockBaseApis = {};

        const mockStorage = new MockStorageApi();
        const sessionStore = new WebStorageSessionStore(mockStorage);

        const olmDevice = new OlmDevice(sessionStore);

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
        beforeEach(function() {
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

            return event.attemptDecryption(mockCrypto).then(() => {
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

                const awaitEnsureSessions = new Promise((res, rej) => {
                    mockOlmLib.ensureOlmSessionsForDevices.andCall(() => {
                        res();
                        return Promise.resolve({'@alice:foo': {'alidevice': {
                            sessionId: 'alisession',
                        }}});
                    });
                });

                mockBaseApis.sendToDevice = expect.createSpy();

                // do the share
                megolmDecryption.shareKeysWithDevice(keyRequest);

                // it's asynchronous, so we have to wait a bit
                return awaitEnsureSessions;
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
    });
});
