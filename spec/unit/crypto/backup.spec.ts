/*
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import "../../olm-loader";
import { logger } from "../../../src/logger";
import * as olmlib from "../../../src/crypto/olmlib";
import { MatrixClient } from "../../../src/client";
import { MatrixEvent } from "../../../src/models/event";
import * as algorithms from "../../../src/crypto/algorithms";
import { MemoryCryptoStore } from "../../../src/crypto/store/memory-crypto-store";
import * as testUtils from "../../test-utils/test-utils";
import { OlmDevice } from "../../../src/crypto/OlmDevice";
import { Crypto } from "../../../src/crypto";
import { BackupManager } from "../../../src/crypto/backup";
import { StubStore } from "../../../src/store/stub";
import { MatrixScheduler } from "../../../src";
import { CryptoStore } from "../../../src/crypto/store/base";
import { MegolmDecryption as MegolmDecryptionClass } from "../../../src/crypto/algorithms/megolm";

const Olm = globalThis.Olm;

const MegolmDecryption = algorithms.DECRYPTION_CLASSES.get("m.megolm.v1.aes-sha2")!;

const ROOM_ID = "!ROOM:ID";

const CURVE25519_BACKUP_INFO = {
    algorithm: olmlib.MEGOLM_BACKUP_ALGORITHM,
    version: "1",
    auth_data: {
        public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
    },
};

const keys: Record<string, Uint8Array> = {};

function getCrossSigningKey(type: string) {
    return Promise.resolve(keys[type]);
}

function saveCrossSigningKeys(k: Record<string, Uint8Array>) {
    Object.assign(keys, k);
}

function makeTestScheduler(): MatrixScheduler {
    return (["getQueueForEvent", "queueEvent", "removeEventFromQueue", "setProcessFunction"] as const).reduce(
        (r, k) => {
            r[k] = jest.fn();
            return r;
        },
        {} as MatrixScheduler,
    );
}

function makeTestClient(cryptoStore: CryptoStore) {
    const scheduler = makeTestScheduler();
    const store = new StubStore();

    const client = new MatrixClient({
        baseUrl: "https://my.home.server",
        idBaseUrl: "https://identity.server",
        accessToken: "my.access.token",
        fetchFn: jest.fn(), // NOP
        store: store,
        scheduler: scheduler,
        userId: "@alice:bar",
        deviceId: "device",
        cryptoStore: cryptoStore,
        cryptoCallbacks: { getCrossSigningKey, saveCrossSigningKeys },
    });

    // initialising the crypto library will trigger a key upload request, which we can stub out
    client.uploadKeysRequest = jest.fn();
    return client;
}

describe("MegolmBackup", function () {
    if (!globalThis.Olm) {
        logger.warn("Not running megolm backup unit tests: libolm not present");
        return;
    }

    beforeAll(function () {
        return Olm.init();
    });

    let olmDevice: OlmDevice;
    let mockOlmLib: typeof olmlib;
    let mockCrypto: Crypto;
    let cryptoStore: CryptoStore;
    let megolmDecryption: MegolmDecryptionClass;
    beforeEach(async function () {
        mockCrypto = testUtils.mock(Crypto, "Crypto");
        // @ts-ignore making mock
        mockCrypto.backupManager = testUtils.mock(BackupManager, "BackupManager");
        mockCrypto.backupManager.backupInfo = CURVE25519_BACKUP_INFO;

        cryptoStore = new MemoryCryptoStore();

        olmDevice = new OlmDevice(cryptoStore);

        // we stub out the olm encryption bits
        mockOlmLib = {} as unknown as typeof olmlib;
        mockOlmLib.ensureOlmSessionsForDevices = jest.fn();
        mockOlmLib.encryptMessageForDevice = jest.fn().mockResolvedValue(undefined);
    });

    describe("backup", function () {
        let mockBaseApis: MatrixClient;

        beforeEach(function () {
            mockBaseApis = {} as unknown as MatrixClient;

            megolmDecryption = new MegolmDecryption({
                userId: "@user:id",
                crypto: mockCrypto,
                olmDevice: olmDevice,
                baseApis: mockBaseApis,
                roomId: ROOM_ID,
            }) as MegolmDecryptionClass;

            // @ts-ignore private field access
            megolmDecryption.olmlib = mockOlmLib;

            // clobber the setTimeout function to run 100x faster.
            // ideally we would use lolex, but we have no oportunity
            // to tick the clock between the first try and the retry.
            const realSetTimeout = globalThis.setTimeout;
            jest.spyOn(globalThis, "setTimeout").mockImplementation(function (f, n) {
                return realSetTimeout(f!, n! / 100);
            });
        });

        afterEach(function () {
            jest.spyOn(globalThis, "setTimeout").mockRestore();
        });

        test("fail if crypto not enabled", async () => {
            const client = makeTestClient(cryptoStore);
            const data = {
                algorithm: olmlib.MEGOLM_BACKUP_ALGORITHM,
                version: "1",
                auth_data: {
                    public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
                },
            };
            await expect(client.restoreKeyBackupWithSecretStorage(data)).rejects.toThrow(
                "End-to-end encryption disabled",
            );
        });

        it("automatically calls the key back up", function () {
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            // construct a fake decrypted key event via the use of a mocked
            // 'crypto' implementation.
            const event = new MatrixEvent({
                type: "m.room.encrypted",
            });
            event.getWireType = () => "m.room.encrypted";
            event.getWireContent = () => {
                return {
                    algorithm: "m.olm.v1.curve25519-aes-sha2",
                };
            };
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

            mockCrypto.decryptEvent = function () {
                return Promise.resolve(decryptedData);
            };
            mockCrypto.cancelRoomKeyRequest = function () {};

            // @ts-ignore readonly field write
            mockCrypto.backupManager = {
                backupGroupSession: jest.fn(),
            };

            return event
                .attemptDecryption(mockCrypto)
                .then(() => {
                    return megolmDecryption.onRoomKeyEvent(event);
                })
                .then(() => {
                    expect(mockCrypto.backupManager.backupGroupSession).toHaveBeenCalled();
                });
        });
    });
});
