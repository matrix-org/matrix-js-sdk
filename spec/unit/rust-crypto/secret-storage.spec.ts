/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import {
    secretStorageCanAccessSecrets,
    secretStorageContainsCrossSigningKeys,
} from "../../../src/rust-crypto/secret-storage";
import { ServerSideSecretStorage } from "../../../src/secret-storage";

describe("secret-storage", () => {
    describe("secretStorageContainsCrossSigningKeys", () => {
        it("should return false when the master cross-signing key is not stored in secret storage", async () => {
            const secretStorage = {
                isStored: jest.fn().mockReturnValue(false),
                getKey: jest.fn().mockResolvedValue(["SFQ3TbqGOdaaRVfxHtNkn0tvhx0rVj9S", {}]),
            } as unknown as ServerSideSecretStorage;

            const result = await secretStorageContainsCrossSigningKeys(secretStorage);
            expect(result).toBeFalsy();
        });

        it("should return false when there is no shared secret storage key between master, user signing and self signing keys", async () => {
            const secretStorage = {
                isStored: (type: string) => {
                    // Return different storage keys
                    if (type === "m.cross_signing.master") return { secretStorageKey: {} };
                    else return { secretStorageKey2: {} };
                },
                getKey: jest.fn().mockResolvedValue(["SFQ3TbqGOdaaRVfxHtNkn0tvhx0rVj9S", {}]),
            } as unknown as ServerSideSecretStorage;

            const result = await secretStorageContainsCrossSigningKeys(secretStorage);
            expect(result).toBeFalsy();
        });

        it("should return false when the secret storage key for the master key is only shared by the user-signing key", async () => {
            const secretStorage = {
                isStored: (type: string) => {
                    // Return different storage keys
                    if (type === "m.cross_signing.master" || type === "m.cross_signing.user_signing") {
                        return { secretStorageKey: {} };
                    } else {
                        return { secretStorageKey2: {} };
                    }
                },
                getKey: jest.fn().mockResolvedValue(["secretStorageKey", {}]),
            } as unknown as ServerSideSecretStorage;

            const result = await secretStorageContainsCrossSigningKeys(secretStorage);
            expect(result).toBeFalsy();
        });

        it("should return true when there is shared secret storage key between master, user signing and self signing keys with default key", async () => {
            const secretStorage = {
                isStored: jest.fn().mockReturnValue({ secretStorageKey: {} }),
                getKey: jest.fn().mockResolvedValue(["secretStorageKey", {}]),
            } as unknown as ServerSideSecretStorage;

            const result = await secretStorageContainsCrossSigningKeys(secretStorage);
            expect(result).toBeTruthy();
        });

        it("should return false when there is shared secret storage key between master, user signing and self signing keys without default key", async () => {
            const secretStorage = {
                isStored: jest.fn().mockResolvedValue({ defaultKey: {} }),
                getKey: jest.fn().mockResolvedValue(["anotherCommonKey", {}]),
            } as unknown as ServerSideSecretStorage;

            const result = await secretStorageContainsCrossSigningKeys(secretStorage);
            expect(result).toBeFalsy();
        });
    });

    describe("Secret storage access", () => {
        it("Check canAccessSecrets", async () => {
            const secretStorage = {
                isStored: jest.fn((secretName) => {
                    if (secretName == "secretA") {
                        return { bbbb: {} };
                    } else if (secretName == "secretB") {
                        return { bbbb: {} };
                    } else if (secretName == "secretC") {
                        return { cccc: {} };
                    } else if (secretName == "secretD") {
                        return { dddd: {} };
                    } else if (secretName == "secretE") {
                        return { aaaa: {}, bbbb: {} };
                    } else {
                        null;
                    }
                }),
                getKey: jest.fn((keyId) => {
                    if (["aaaa", "bbbb", "cccc", "dddd"].includes(keyId)) {
                        return [keyId, {}];
                    } else if (keyId == null) {
                        // default key
                        return ["aaaa", {}];
                    } else {
                        return null;
                    }
                }),
            } as unknown as ServerSideSecretStorage;

            expect(await secretStorageCanAccessSecrets(secretStorage, "aaaa", ["secretE"])).toStrictEqual(true);
            expect(await secretStorageCanAccessSecrets(secretStorage, null, ["secretE"])).toStrictEqual(true);
            expect(await secretStorageCanAccessSecrets(secretStorage, "bbbb", ["secretA", "secretB"])).toStrictEqual(
                true,
            );
            expect(
                await secretStorageCanAccessSecrets(secretStorage, "bbbb", ["secretA", "secretB", "Unknown"]),
            ).toStrictEqual(false);
            expect(await secretStorageCanAccessSecrets(secretStorage, null, ["secretA", "secretB"])).toStrictEqual(
                false,
            );
            expect(
                await secretStorageCanAccessSecrets(secretStorage, "bbbb", ["secretA", "secretB", "secretC"]),
            ).toStrictEqual(false);
            expect(
                await secretStorageCanAccessSecrets(secretStorage, "bbbb", ["secretA", "secretB", "secretE"]),
            ).toStrictEqual(true);
            expect(
                await secretStorageCanAccessSecrets(secretStorage, null, ["secretA", "secretB", "secretE"]),
            ).toStrictEqual(false);
            expect(await secretStorageCanAccessSecrets(secretStorage, null, [])).toStrictEqual(true);
            expect(await secretStorageCanAccessSecrets(secretStorage, "unknown", ["secretE"])).toStrictEqual(false);
        });
    });
});
