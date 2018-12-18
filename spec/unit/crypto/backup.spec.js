/*
Copyright 2018 New Vector Ltd

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

import '../../olm-loader';

import expect from 'expect';
import Promise from 'bluebird';

import sdk from '../../..';
import algorithms from '../../../lib/crypto/algorithms';
import WebStorageSessionStore from '../../../lib/store/session/webstorage';
import MemoryCryptoStore from '../../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../../MockStorageApi';
import testUtils from '../../test-utils';

import OlmDevice from '../../../lib/crypto/OlmDevice';
import Crypto from '../../../lib/crypto';

const Olm = global.Olm;

const MatrixClient = sdk.MatrixClient;
const MatrixEvent = sdk.MatrixEvent;
const MegolmDecryption = algorithms.DECRYPTION_CLASSES['m.megolm.v1.aes-sha2'];

const ROOM_ID = '!ROOM:ID';

const SESSION_ID = 'o+21hSjP+mgEmcfdslPsQdvzWnkdt0Wyo00Kp++R8Kc';
const ENCRYPTED_EVENT = new MatrixEvent({
    type: 'm.room.encrypted',
    room_id: '!ROOM:ID',
    content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        sender_key: 'SENDER_CURVE25519',
        session_id: SESSION_ID,
        ciphertext: 'AwgAEjD+VwXZ7PoGPRS/H4kwpAsMp/g+WPvJVtPEKE8fmM9IcT/N'
            + 'CiwPb8PehecDKP0cjm1XO88k6Bw3D17aGiBHr5iBoP7oSw8CXULXAMTkBl'
            + 'mkufRQq2+d0Giy1s4/Cg5n13jSVrSb2q7VTSv1ZHAFjUCsLSfR0gxqcQs',
    },
    event_id: '$event1',
    origin_server_ts: 1507753886000,
});

const KEY_BACKUP_DATA = {
    first_message_index: 0,
    forwarded_count: 0,
    is_verified: false,
    session_data: {
        ciphertext: '2z2M7CZ+azAiTHN1oFzZ3smAFFt+LEOYY6h3QO3XXGdw'
            + '6YpNn/gpHDO6I/rgj1zNd4FoTmzcQgvKdU8kN20u5BWRHxaHTZ'
            + 'Slne5RxE6vUdREsBgZePglBNyG0AogR/PVdcrv/v18Y6rLM5O9'
            + 'SELmwbV63uV9Kuu/misMxoqbuqEdG7uujyaEKtjlQsJ5MGPQOy'
            + 'Syw7XrnesSwF6XWRMxcPGRV0xZr3s9PI350Wve3EncjRgJ9IGF'
            + 'ru1bcptMqfXgPZkOyGvrphHoFfoK7nY3xMEHUiaTRfRIjq8HNV'
            + '4o8QY1qmWGnxNBQgOlL8MZlykjg3ULmQ3DtFfQPj/YYGS3jzxv'
            + 'C+EBjaafmsg+52CTeK3Rswu72PX450BnSZ1i3If4xWAUKvjTpe'
            + 'Ug5aDLqttOv1pITolTJDw5W/SD+b5rjEKg1CFCHGEGE9wwV3Nf'
            + 'QHVCQL+dfpd7Or0poy4dqKMAi3g0o3Tg7edIF8d5rREmxaALPy'
            + 'iie8PHD8mj/5Y0GLqrac4CD6+Mop7eUTzVovprjg',
        mac: '5lxYBHQU80M',
        ephemeral: '/Bn0A4UMFwJaDDvh0aEk1XZj3k1IfgCxgFY9P9a0b14',
    },
};

function makeTestClient(sessionStore, cryptoStore) {
    const scheduler = [
        "getQueueForEvent", "queueEvent", "removeEventFromQueue",
        "setProcessFunction",
    ].reduce((r, k) => {r[k] = expect.createSpy(); return r;}, {});
    const store = [
        "getRoom", "getRooms", "getUser", "getSyncToken", "scrollback",
        "save", "wantsSave", "setSyncToken", "storeEvents", "storeRoom",
        "storeUser", "getFilterIdByName", "setFilterIdByName", "getFilter",
        "storeFilter", "getSyncAccumulator", "startup", "deleteAllData",
    ].reduce((r, k) => {r[k] = expect.createSpy(); return r;}, {});
    store.getSavedSync = expect.createSpy().andReturn(Promise.resolve(null));
    store.getSavedSyncToken = expect.createSpy().andReturn(Promise.resolve(null));
    store.setSyncData = expect.createSpy().andReturn(Promise.resolve(null));
    return new MatrixClient({
        baseUrl: "https://my.home.server",
        idBaseUrl: "https://identity.server",
        accessToken: "my.access.token",
        request: function() {}, // NOP
        store: store,
        scheduler: scheduler,
        userId: "@alice:bar",
        deviceId: "device",
        sessionStore: sessionStore,
        cryptoStore: cryptoStore,
    });
}

describe("MegolmBackup", function() {
    if (!global.Olm) {
        console.warn('Not running megolm backup unit tests: libolm not present');
        return;
    }

    let olmDevice;
    let mockOlmLib;
    let mockCrypto;
    let mockStorage;
    let sessionStore;
    let cryptoStore;
    let megolmDecryption;
    beforeEach(async function() {
        await Olm.init();
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        mockCrypto = testUtils.mock(Crypto, 'Crypto');
        mockCrypto.backupKey = new Olm.PkEncryption();
        mockCrypto.backupKey.set_recipient_key(
            "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
        );
        mockCrypto.backupInfo = {
            algorithm: "m.megolm_backup.v1",
            version: 1,
            auth_data: {
                public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
            },
        };

        mockStorage = new MockStorageApi();
        sessionStore = new WebStorageSessionStore(mockStorage);
        cryptoStore = new MemoryCryptoStore(mockStorage);

        olmDevice = new OlmDevice(sessionStore, cryptoStore);

        // we stub out the olm encryption bits
        mockOlmLib = {};
        mockOlmLib.ensureOlmSessionsForDevices = expect.createSpy();
        mockOlmLib.encryptMessageForDevice =
            expect.createSpy().andReturn(Promise.resolve());
    });

    describe("backup", function() {
        let mockBaseApis;
        let realSetTimeout;

        beforeEach(function() {
            mockBaseApis = {};

            megolmDecryption = new MegolmDecryption({
                userId: '@user:id',
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: mockBaseApis,
                roomId: ROOM_ID,
            });

            megolmDecryption.olmlib = mockOlmLib;

            // clobber the setTimeout function to run 100x faster.
            // ideally we would use lolex, but we have no oportunity
            // to tick the clock between the first try and the retry.
            realSetTimeout = global.setTimeout;
            global.setTimeout = function(f, n) {
                return realSetTimeout(f, n/100);
            };
        });

        afterEach(function() {
            global.setTimeout = realSetTimeout;
        });

        it('automatically calls the key back up', function() {
            const groupSession = new Olm.OutboundGroupSession();
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

            mockCrypto.decryptEvent = function() {
                return Promise.resolve(decryptedData);
            };
            mockCrypto.cancelRoomKeyRequest = function() {};

            mockCrypto.backupGroupSession = expect.createSpy();

            return event.attemptDecryption(mockCrypto).then(() => {
                return megolmDecryption.onRoomKeyEvent(event);
            }).then(() => {
                expect(mockCrypto.backupGroupSession).toHaveBeenCalled();
            });
        });

        it('sends backups to the server', function() {
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();
            const ibGroupSession = new Olm.InboundGroupSession();
            ibGroupSession.create(groupSession.session_key());

            const client = makeTestClient(sessionStore, cryptoStore);

            megolmDecryption = new MegolmDecryption({
                userId: '@user:id',
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: client,
                roomId: ROOM_ID,
            });

            megolmDecryption.olmlib = mockOlmLib;

            return client.initCrypto()
                .then(() => {
                    return cryptoStore.doTxn(
                        "readwrite",
                        [cryptoStore.STORE_SESSION],
                        (txn) => {
                            cryptoStore.addEndToEndInboundGroupSession(
                                "F0Q2NmyJNgUVj9DGsb4ZQt3aVxhVcUQhg7+gvW0oyKI",
                                groupSession.session_id(),
                                {
                                    forwardingCurve25519KeyChain: undefined,
                                    keysClaimed: {
                                        ed25519: "SENDER_ED25519",
                                    },
                                    room_id: ROOM_ID,
                                    session: ibGroupSession.pickle(olmDevice._pickleKey),
                                },
                                txn);
                        });
                })
                .then(() => {
                    client.enableKeyBackup({
                        algorithm: "m.megolm_backup.v1",
                        version: 1,
                        auth_data: {
                            public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
                        },
                    });
                    let numCalls = 0;
                    return new Promise((resolve, reject) => {
                        client._http.authedRequest = function(
                            callback, method, path, queryParams, data, opts,
                        ) {
                            ++numCalls;
                            expect(numCalls).toBeLessThanOrEqualTo(1);
                            if (numCalls >= 2) {
                                // exit out of retry loop if there's something wrong
                                reject(new Error("authedRequest called too many timmes"));
                                return Promise.resolve({});
                            }
                            expect(method).toBe("PUT");
                            expect(path).toBe("/room_keys/keys");
                            expect(queryParams.version).toBe(1);
                            expect(data.rooms[ROOM_ID].sessions).toExist();
                            expect(data.rooms[ROOM_ID].sessions).toIncludeKey(
                                groupSession.session_id(),
                            );
                            resolve();
                            return Promise.resolve({});
                        };
                        client._crypto.backupGroupSession(
                            "roomId",
                            "F0Q2NmyJNgUVj9DGsb4ZQt3aVxhVcUQhg7+gvW0oyKI",
                            [],
                            groupSession.session_id(),
                            groupSession.session_key(),
                        );
                    }).then(() => {
                        expect(numCalls).toBe(1);
                    });
                });
        });

        it('retries when a backup fails', function() {
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();
            const ibGroupSession = new Olm.InboundGroupSession();
            ibGroupSession.create(groupSession.session_key());

            const scheduler = [
                "getQueueForEvent", "queueEvent", "removeEventFromQueue",
                "setProcessFunction",
            ].reduce((r, k) => {r[k] = expect.createSpy(); return r;}, {});
            const store = [
                "getRoom", "getRooms", "getUser", "getSyncToken", "scrollback",
                "save", "wantsSave", "setSyncToken", "storeEvents", "storeRoom",
                "storeUser", "getFilterIdByName", "setFilterIdByName", "getFilter",
                "storeFilter", "getSyncAccumulator", "startup", "deleteAllData",
            ].reduce((r, k) => {r[k] = expect.createSpy(); return r;}, {});
            store.getSavedSync = expect.createSpy().andReturn(Promise.resolve(null));
            store.getSavedSyncToken = expect.createSpy().andReturn(Promise.resolve(null));
            store.setSyncData = expect.createSpy().andReturn(Promise.resolve(null));
            const client = new MatrixClient({
                baseUrl: "https://my.home.server",
                idBaseUrl: "https://identity.server",
                accessToken: "my.access.token",
                request: function() {}, // NOP
                store: store,
                scheduler: scheduler,
                userId: "@alice:bar",
                deviceId: "device",
                sessionStore: sessionStore,
                cryptoStore: cryptoStore,
            });

            megolmDecryption = new MegolmDecryption({
                userId: '@user:id',
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: client,
                roomId: ROOM_ID,
            });

            megolmDecryption.olmlib = mockOlmLib;

            return client.initCrypto()
                .then(() => {
                    return cryptoStore.doTxn(
                        "readwrite",
                        [cryptoStore.STORE_SESSION],
                        (txn) => {
                            cryptoStore.addEndToEndInboundGroupSession(
                                "F0Q2NmyJNgUVj9DGsb4ZQt3aVxhVcUQhg7+gvW0oyKI",
                                groupSession.session_id(),
                                {
                                    forwardingCurve25519KeyChain: undefined,
                                    keysClaimed: {
                                        ed25519: "SENDER_ED25519",
                                    },
                                    room_id: ROOM_ID,
                                    session: ibGroupSession.pickle(olmDevice._pickleKey),
                                },
                                txn);
                        });
                })
                .then(() => {
                    client.enableKeyBackup({
                        algorithm: "foobar",
                        version: 1,
                        auth_data: {
                            public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
                        },
                    });
                    let numCalls = 0;
                    return new Promise((resolve, reject) => {
                        client._http.authedRequest = function(
                            callback, method, path, queryParams, data, opts,
                        ) {
                            ++numCalls;
                            expect(numCalls).toBeLessThanOrEqualTo(2);
                            if (numCalls >= 3) {
                                // exit out of retry loop if there's something wrong
                                reject(new Error("authedRequest called too many timmes"));
                                return Promise.resolve({});
                            }
                            expect(method).toBe("PUT");
                            expect(path).toBe("/room_keys/keys");
                            expect(queryParams.version).toBe(1);
                            expect(data.rooms[ROOM_ID].sessions).toExist();
                            expect(data.rooms[ROOM_ID].sessions).toIncludeKey(
                                groupSession.session_id(),
                            );
                            if (numCalls > 1) {
                                resolve();
                                return Promise.resolve({});
                            } else {
                                return Promise.reject(
                                    new Error("this is an expected failure"),
                                );
                            }
                        };
                        client._crypto.backupGroupSession(
                            "roomId",
                            "F0Q2NmyJNgUVj9DGsb4ZQt3aVxhVcUQhg7+gvW0oyKI",
                            [],
                            groupSession.session_id(),
                            groupSession.session_key(),
                        );
                    }).then(() => {
                        expect(numCalls).toBe(2);
                    });
                });
        });
    });

    describe("restore", function() {
        let client;

        beforeEach(function() {
            client = makeTestClient(sessionStore, cryptoStore);

            megolmDecryption = new MegolmDecryption({
                userId: '@user:id',
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: client,
                roomId: ROOM_ID,
            });

            megolmDecryption.olmlib = mockOlmLib;

            return client.initCrypto();
        });

        afterEach(function() {
            client.stopClient();
        });

        it('can restore from backup', function() {
            client._http.authedRequest = function() {
                return Promise.resolve(KEY_BACKUP_DATA);
            };
            return client.restoreKeyBackupWithRecoveryKey(
                "EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d",
                ROOM_ID,
                SESSION_ID,
            ).then(() => {
                return megolmDecryption.decryptEvent(ENCRYPTED_EVENT);
            }).then((res) => {
                expect(res.clearEvent.content).toEqual('testytest');
            });
        });

        it('can restore backup by room', function() {
            client._http.authedRequest = function() {
                return Promise.resolve({
                    rooms: {
                        [ROOM_ID]: {
                            sessions: {
                                [SESSION_ID]: KEY_BACKUP_DATA,
                            },
                        },
                    },
                });
            };
            return client.restoreKeyBackupWithRecoveryKey(
                "EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d",
            ).then(() => {
                return megolmDecryption.decryptEvent(ENCRYPTED_EVENT);
            }).then((res) => {
                expect(res.clearEvent.content).toEqual('testytest');
            });
        });
    });
});
