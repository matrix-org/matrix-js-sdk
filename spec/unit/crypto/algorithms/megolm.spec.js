try {
    global.Olm = require('olm');
} catch (e) {
    console.warn("unable to run megolm tests: libolm not available");
}

import expect from 'expect';

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
        mockOlmLib.encryptMessageForDevice = expect.createSpy();
        megolmDecryption.olmlib = mockOlmLib;
    });

    describe('receives some keys:', function() {
        let groupSession;
        beforeEach(function() {
            groupSession = new global.Olm.OutboundGroupSession();
            groupSession.create();

            const event = new MatrixEvent({});
            event.setClearData(
                {
                    type: 'm.room_key',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        room_id: ROOM_ID,
                        session_id: groupSession.session_id(),
                        session_key: groupSession.session_key(),
                    },
                },
                "SENDER_CURVE25519",
                "SENDER_ED25519",
            );

            megolmDecryption.onRoomKeyEvent(event);
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

            megolmDecryption.decryptEvent(event);
            expect(event.getContent()).toEqual('testytest');
        });
    });
});
