import 'source-map-support/register';

import '../olm-loader';

import Crypto from '../../lib/crypto';
import expect from 'expect';

import WebStorageSessionStore from '../../lib/store/session/webstorage';
import MemoryCryptoStore from '../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../MockStorageApi';
import TestClient from '../TestClient';
import {MatrixEvent} from '../../lib/models/event';
import Room from '../../lib/models/room';
import olmlib from '../../lib/crypto/olmlib';

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

    describe('Key requests', function() {
        let aliceClient;
        let bobClient;

        beforeEach(async function() {
            aliceClient = (new TestClient(
                "@alice:example.com", "alicedevice",
            )).client;
            bobClient = (new TestClient(
                "@bob:example.com", "bobdevice",
            )).client;
            await aliceClient.initCrypto();
            await bobClient.initCrypto();
        });

        afterEach(async function() {
            aliceClient.stopClient();
            bobClient.stopClient();
        });

        it(
            "does not cancel keyshare requests if some messages are not decrypted",
            async function() {
                function awaitEvent(emitter, event) {
                    return new Promise((resolve, reject) => {
                        emitter.once(event, (result) => {
                            resolve(result);
                        });
                    });
                }

                async function keyshareEventForEvent(event, index) {
                    const eventContent = event.getWireContent();
                    const key = await aliceClient._crypto._olmDevice
                        .getInboundGroupSessionKey(
                            roomId, eventContent.sender_key, eventContent.session_id,
                            index,
                        );
                    const ksEvent = new MatrixEvent({
                        type: "m.forwarded_room_key",
                        sender: "@alice:example.com",
                        content: {
                            algorithm: olmlib.MEGOLM_ALGORITHM,
                            room_id: roomId,
                            sender_key: eventContent.sender_key,
                            sender_claimed_ed25519_key: key.sender_claimed_ed25519_key,
                            session_id: eventContent.session_id,
                            session_key: key.key,
                            chain_index: key.chain_index,
                            forwarding_curve25519_key_chain:
                            key.forwarding_curve_key_chain,
                        },
                    });
                    // make onRoomKeyEvent think this was an encrypted event
                    ksEvent._senderCurve25519Key = "akey";
                    return ksEvent;
                }

                const encryptionCfg = {
                    "algorithm": "m.megolm.v1.aes-sha2",
                };
                const roomId = "!someroom";
                const aliceRoom = new Room(roomId, aliceClient, "@alice:example.com", {});
                const bobRoom = new Room(roomId, bobClient, "@bob:example.com", {});
                aliceClient.store.storeRoom(aliceRoom);
                bobClient.store.storeRoom(bobRoom);
                await aliceClient.setRoomEncryption(roomId, encryptionCfg);
                await bobClient.setRoomEncryption(roomId, encryptionCfg);
                const events = [
                    new MatrixEvent({
                        type: "m.room.message",
                        sender: "@alice:example.com",
                        room_id: roomId,
                        event_id: "$1",
                        content: {
                            msgtype: "m.text",
                            body: "1",
                        },
                    }),
                    new MatrixEvent({
                        type: "m.room.message",
                        sender: "@alice:example.com",
                        room_id: roomId,
                        event_id: "$2",
                        content: {
                            msgtype: "m.text",
                            body: "2",
                        },
                    }),
                ];
                await Promise.all(events.map(async (event) => {
                    // alice encrypts each event, and then bob tries to decrypt
                    // them without any keys, so that they'll be in pending
                    await aliceClient._crypto.encryptEvent(event, aliceRoom);
                    event._clearEvent = {};
                    event._senderCurve25519Key = null;
                    event._claimedEd25519Key = null;
                    try {
                        await bobClient._crypto.decryptEvent(event);
                    } catch (e) {
                        // we expect this to fail because we don't have the
                        // decryption keys yet
                    }
                }));

                const bobDecryptor = bobClient._crypto._getRoomDecryptor(
                    roomId, olmlib.MEGOLM_ALGORITHM,
                );

                let eventPromise = Promise.all(events.map((ev) => {
                    return awaitEvent(ev, "Event.decrypted");
                }));

                // keyshare the session key starting at the second message, so
                // the first message can't be decrypted yet, but the second one
                // can
                let ksEvent = await keyshareEventForEvent(events[1], 1);
                await bobDecryptor.onRoomKeyEvent(ksEvent);
                await eventPromise;
                expect(events[0].getContent().msgtype).toBe("m.bad.encrypted");
                expect(events[1].getContent().msgtype).toNotBe("m.bad.encrypted");

                const cryptoStore = bobClient._cryptoStore;
                const eventContent = events[0].getWireContent();
                const senderKey = eventContent.sender_key;
                const sessionId = eventContent.session_id;
                const roomKeyRequestBody = {
                    algorithm: olmlib.MEGOLM_ALGORITHM,
                    room_id: roomId,
                    sender_key: senderKey,
                    session_id: sessionId,
                };
                // the room key request should still be there, since we haven't
                // decrypted everything
                expect(await cryptoStore.getOutgoingRoomKeyRequest(roomKeyRequestBody))
                    .toExist();

                // keyshare the session key starting at the first message, so
                // that it can now be decrypted
                eventPromise = awaitEvent(events[0], "Event.decrypted");
                ksEvent = await keyshareEventForEvent(events[0], 0);
                await bobDecryptor.onRoomKeyEvent(ksEvent);
                await eventPromise;
                expect(events[0].getContent().msgtype).toNotBe("m.bad.encrypted");
                // the room key request should be gone since we've now decypted everything
                expect(await cryptoStore.getOutgoingRoomKeyRequest(roomKeyRequestBody))
                    .toNotExist();
            },
        );
    });
});
