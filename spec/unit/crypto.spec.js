import 'source-map-support/register';

import '../olm-loader';

import Crypto from '../../lib/crypto';
import expect from 'expect';

import WebStorageSessionStore from '../../lib/store/session/webstorage';
import MemoryCryptoStore from '../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../MockStorageApi';

const EventEmitter = require("events").EventEmitter;

const sdk = require("../..");

const Olm = global.Olm;

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    beforeEach(function(done) {
        Olm.init().then(done);
    });

    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()[0]).toEqual(3);
    });


    describe('Session management', function() {
        const otkResponse = {
            one_time_keys: {
                '@alice:home.server': {
                    aliceDevice: {
                        'signed_curve25519:FLIBBLE': {
                            key: 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI',
                            signatures: {
                                '@alice:home.server': {
                                    'ed25519:aliceDevice': 'totally a valid signature',
                                },
                            },
                        },
                    },
                },
            },
        };
        let crypto;
        let mockBaseApis;
        let mockRoomList;

        let fakeEmitter;

        beforeEach(async function() {
            const mockStorage = new MockStorageApi();
            const sessionStore = new WebStorageSessionStore(mockStorage);
            const cryptoStore = new MemoryCryptoStore(mockStorage);

            cryptoStore.storeEndToEndDeviceData({
                devices: {
                    '@bob:home.server': {
                        'BOBDEVICE': {
                            keys: {
                                'curve25519:BOBDEVICE': 'this is a key',
                            },
                        },
                    },
                },
                trackingStatus: {},
            });

            mockBaseApis = {
                sendToDevice: expect.createSpy(),
                getKeyBackupVersion: expect.createSpy(),
                isGuest: expect.createSpy(),
            };
            mockRoomList = {};

            fakeEmitter = new EventEmitter();

            crypto = new Crypto(
                mockBaseApis,
                sessionStore,
                "@alice:home.server",
                "FLIBBLE",
                sessionStore,
                cryptoStore,
                mockRoomList,
            );
            crypto.registerEventHandlers(fakeEmitter);
            await crypto.init();
        });

        afterEach(async function() {
            await crypto.stop();
        });

        it("restarts wedged Olm sessions", async function() {
            const prom = new Promise((resolve) => {
                mockBaseApis.claimOneTimeKeys = function() {
                    resolve();
                    return otkResponse;
                };
            });

            fakeEmitter.emit('toDeviceEvent', {
                getType: expect.createSpy().andReturn('m.room.message'),
                getContent: expect.createSpy().andReturn({
                    msgtype: 'm.bad.encrypted',
                }),
                getWireContent: expect.createSpy().andReturn({
                    algorithm: 'm.olm.v1.curve25519-aes-sha2',
                    sender_key: 'this is a key',
                }),
                getSender: expect.createSpy().andReturn('@bob:home.server'),
            });

            await prom;
        });
    });
});
