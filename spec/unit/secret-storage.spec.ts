/*
Copyright 2019, 2022-2023 The Matrix.org Foundation C.I.C.

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

import { type Mocked } from "jest-mock";

import {
    type AccountDataClient,
    calculateKeyCheck,
    type PassphraseInfo,
    type SecretStorageCallbacks,
    type SecretStorageKeyDescriptionAesV1,
    type SecretStorageKeyDescriptionCommon,
    type ServerSideSecretStorage,
    ServerSideSecretStorageImpl,
    trimTrailingEquals,
} from "../../src/secret-storage";
import { secureRandomString } from "../../src/randomstring";
import { type SecretInfo } from "../../src/secret-storage.ts";
import { type AccountDataEvents, ClientEvent, MatrixEvent, TypedEventEmitter } from "../../src";
import { defer, type IDeferred } from "../../src/utils";

declare module "../../src/@types/event" {
    interface SecretStorageAccountDataEvents {
        mysecret: SecretInfo;
    }
}

describe("ServerSideSecretStorageImpl", function () {
    describe(".addKey", function () {
        it("should allow storing a default key", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            const result = await secretStorage.addKey("m.secret_storage.v1.aes-hmac-sha2", {
                key: new Uint8Array(32),
            });

            // it should have made up a 32-character key id
            expect(result.keyId.length).toEqual(32);
            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith(
                `m.secret_storage.key.${result.keyId}`,
                result.keyInfo,
            );
        });

        it("should allow storing a key with an explicit id", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            const result = await secretStorage.addKey(
                "m.secret_storage.v1.aes-hmac-sha2",
                {
                    key: new Uint8Array(32),
                },
                "myKeyId",
            );

            // it should have made up a 32-character key id
            expect(result.keyId).toEqual("myKeyId");
            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith(
                "m.secret_storage.key.myKeyId",
                result.keyInfo,
            );
        });

        it("should allow storing a key with a name", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            const result = await secretStorage.addKey("m.secret_storage.v1.aes-hmac-sha2", {
                name: "mykey",
                key: new Uint8Array(32),
            });

            expect(result.keyInfo.name).toEqual("mykey");

            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith(
                `m.secret_storage.key.${result.keyId}`,
                result.keyInfo,
            );
        });

        it("should allow storing a key with a passphrase", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            const passphrase: PassphraseInfo = {
                algorithm: "m.pbkdf2",
                iterations: 125,
                salt: "saltygoodness",
                bits: 256,
            };
            const result = await secretStorage.addKey("m.secret_storage.v1.aes-hmac-sha2", {
                passphrase,
                key: new Uint8Array(32),
            });

            expect(result.keyInfo.passphrase).toEqual(passphrase);

            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith(
                `m.secret_storage.key.${result.keyId}`,
                result.keyInfo,
            );
        });

        it("should complain about invalid algorithm", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            await expect(() => secretStorage.addKey("bad_alg", { key: new Uint8Array(32) })).rejects.toThrow(
                "Unknown key algorithm",
            );
        });
    });

    describe("getKey", function () {
        it("should return the specified key", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});

            const storedKey = { iv: "iv", mac: "mac" } as SecretStorageKeyDescriptionAesV1;
            async function mockGetAccountData<K extends keyof AccountDataEvents>(
                eventType: string,
            ): Promise<AccountDataEvents[K] | null> {
                if (eventType === "m.secret_storage.key.my_key") {
                    return storedKey as any;
                } else {
                    throw new Error(`unexpected eventType ${eventType}`);
                }
            }
            accountDataAdapter.getAccountDataFromServer.mockImplementation(mockGetAccountData);

            const result = await secretStorage.getKey("my_key");
            expect(result).toEqual(["my_key", storedKey]);
        });

        it("should return the default key if none is specified", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});

            const storedKey = { iv: "iv", mac: "mac" } as SecretStorageKeyDescriptionAesV1;
            async function mockGetAccountData<K extends keyof AccountDataEvents>(
                eventType: string,
            ): Promise<AccountDataEvents[K] | null> {
                if (eventType === "m.secret_storage.default_key") {
                    return { key: "default_key_id" } as any;
                } else if (eventType === "m.secret_storage.key.default_key_id") {
                    return storedKey as any;
                } else {
                    throw new Error(`unexpected eventType ${eventType}`);
                }
            }
            accountDataAdapter.getAccountDataFromServer.mockImplementation(mockGetAccountData);

            const result = await secretStorage.getKey();
            expect(result).toEqual(["default_key_id", storedKey]);
        });

        it("should return null if the key is not found", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            // @ts-ignore
            accountDataAdapter.getAccountDataFromServer.mockResolvedValue(null);

            const result = await secretStorage.getKey("my_key");
            expect(result).toEqual(null);
        });
    });

    describe("checkKey", function () {
        it("should return true for a correct key check", async function () {
            const secretStorage = new ServerSideSecretStorageImpl({} as AccountDataClient, {});

            const myKey = new TextEncoder().encode(secureRandomString(32));
            const { iv, mac } = await calculateKeyCheck(myKey);

            const keyInfo: SecretStorageKeyDescriptionAesV1 = {
                name: "my key",
                passphrase: {} as PassphraseInfo,
                algorithm: "m.secret_storage.v1.aes-hmac-sha2",
                iv,
                mac,
            };

            const result = await secretStorage.checkKey(myKey, keyInfo);
            expect(result).toBe(true);
        });

        it("should return false for an incorrect key check", async function () {
            const secretStorage = new ServerSideSecretStorageImpl({} as AccountDataClient, {});

            const { iv, mac } = await calculateKeyCheck(new TextEncoder().encode("badkey"));

            const keyInfo: SecretStorageKeyDescriptionAesV1 = {
                name: "my key",
                passphrase: {} as PassphraseInfo,
                algorithm: "m.secret_storage.v1.aes-hmac-sha2",
                iv,
                mac,
            };

            const result = await secretStorage.checkKey(new TextEncoder().encode("goodkey"), keyInfo);
            expect(result).toBe(false);
        });

        it("should raise for an unknown algorithm", async function () {
            const secretStorage = new ServerSideSecretStorageImpl({} as AccountDataClient, {});
            const keyInfo: SecretStorageKeyDescriptionAesV1 = {
                name: "my key",
                passphrase: {} as PassphraseInfo,
                algorithm: "bad_alg",
                iv: "iv",
                mac: "mac",
            };

            await expect(() => secretStorage.checkKey(new TextEncoder().encode("goodkey"), keyInfo)).rejects.toThrow(
                "Unknown algorithm",
            );
        });

        // XXX: really???
        it("should return true for an absent mac", async function () {
            const secretStorage = new ServerSideSecretStorageImpl({} as AccountDataClient, {});
            const keyInfo: SecretStorageKeyDescriptionAesV1 = {
                name: "my key",
                passphrase: {} as PassphraseInfo,
                algorithm: "m.secret_storage.v1.aes-hmac-sha2",
                iv: "iv",
                mac: "",
            };

            const result = await secretStorage.checkKey(new TextEncoder().encode("goodkey"), keyInfo);
            expect(result).toBe(true);
        });
    });

    describe("store", () => {
        let secretStorage: ServerSideSecretStorage;
        let accountDataAdapter: Mocked<AccountDataClient>;

        beforeEach(() => {
            accountDataAdapter = mockAccountDataClient();
            const mockCallbacks = { getSecretStorageKey: jest.fn() } as Mocked<SecretStorageCallbacks>;
            secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, mockCallbacks);
        });

        it("should ignore keys with unknown algorithm", async function () {
            // stub out getAccountData to return a key with an unknown algorithm
            const storedKey = { algorithm: "badalg" } as SecretStorageKeyDescriptionCommon;
            async function mockGetAccountData<K extends keyof AccountDataEvents>(
                eventType: string,
            ): Promise<AccountDataEvents[K] | null> {
                if (eventType === "m.secret_storage.key.keyid") {
                    return storedKey as any;
                } else {
                    throw new Error(`unexpected eventType ${eventType}`);
                }
            }
            accountDataAdapter.getAccountDataFromServer.mockImplementation(mockGetAccountData);

            // suppress the expected warning on the console
            jest.spyOn(console, "warn").mockImplementation();

            // now attempt the store
            await secretStorage.store("mysecret", "supersecret", ["keyid"]);

            // we should have stored... nothing
            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith("mysecret", { encrypted: {} });

            // ... and emitted a warning.
            // eslint-disable-next-line no-console
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unknown algorithm"));
        });

        it("should set the secret with an empty object when the value is null", async function () {
            await secretStorage.store("mySecret", null);
            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith("mySecret", {});
        });
    });

    describe("setDefaultKeyId", function () {
        let secretStorage: ServerSideSecretStorage;
        let accountDataAdapter: Mocked<AccountDataClient>;
        let accountDataPromise: IDeferred<void>;
        beforeEach(() => {
            accountDataAdapter = mockAccountDataClient();
            accountDataPromise = defer();
            accountDataAdapter.setAccountData.mockImplementation(() => {
                accountDataPromise.resolve();
                return Promise.resolve({});
            });

            secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
        });

        it("should set the default key id", async function () {
            const setDefaultPromise = secretStorage.setDefaultKeyId("keyId");
            await accountDataPromise.promise;

            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith("m.secret_storage.default_key", {
                key: "keyId",
            });

            accountDataAdapter.emit(
                ClientEvent.AccountData,
                new MatrixEvent({
                    type: "m.secret_storage.default_key",
                    content: { key: "keyId" },
                }),
            );
            await setDefaultPromise;
        });

        it("should set the default key id with a null key id", async function () {
            const setDefaultPromise = secretStorage.setDefaultKeyId(null);
            await accountDataPromise.promise;

            expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith("m.secret_storage.default_key", {});

            accountDataAdapter.emit(
                ClientEvent.AccountData,
                new MatrixEvent({
                    type: "m.secret_storage.default_key",
                    content: {},
                }),
            );
            await setDefaultPromise;
        });
    });

    describe("getDefaultKeyId", function () {
        it("should return null when there is no key", async function () {
            const accountDataAdapter = mockAccountDataClient();
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            expect(await secretStorage.getDefaultKeyId()).toBe(null);
        });

        it("should return the key id when there is a key", async function () {
            const accountDataAdapter = mockAccountDataClient();
            accountDataAdapter.getAccountDataFromServer.mockResolvedValue({ key: "keyId" });
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            expect(await secretStorage.getDefaultKeyId()).toBe("keyId");
        });

        it("should return null when an empty object is in the account data", async function () {
            const accountDataAdapter = mockAccountDataClient();
            accountDataAdapter.getAccountDataFromServer.mockResolvedValue({});
            const secretStorage = new ServerSideSecretStorageImpl(accountDataAdapter, {});
            expect(await secretStorage.getDefaultKeyId()).toBe(null);
        });
    });
});

describe("trimTrailingEquals", () => {
    it("should strip trailing =", () => {
        expect(trimTrailingEquals("ab=c===")).toEqual("ab=c");
    });

    it("should leave strings without trailing = alone", () => {
        expect(trimTrailingEquals("ab=c")).toEqual("ab=c");
    });

    it("should leave the empty string alone", () => {
        const result = trimTrailingEquals("");
        expect(result).toEqual("");
    });
});

function mockAccountDataClient(): Mocked<AccountDataClient> {
    const eventEmitter = new TypedEventEmitter();
    return {
        getAccountDataFromServer: jest.fn().mockResolvedValue(null),
        setAccountData: jest.fn().mockResolvedValue({}),
        on: eventEmitter.on.bind(eventEmitter),
        off: eventEmitter.off.bind(eventEmitter),
        removeListener: eventEmitter.removeListener.bind(eventEmitter),
        emit: eventEmitter.emit.bind(eventEmitter),
    } as unknown as Mocked<AccountDataClient>;
}
