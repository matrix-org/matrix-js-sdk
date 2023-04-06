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

import { AccountDataClient, SecretStorage } from "../../src/secret-storage";

describe("SecretStorage", function () {
    it("should allow storing a default key", async function () {
        const accountDataAdapter = {
            getAccountDataFromServer: jest.fn().mockResolvedValue(null),
            setAccountData: jest.fn().mockResolvedValue({}),
        };
        const secretStorage = new SecretStorage(accountDataAdapter as unknown as AccountDataClient, {});
        const result = await secretStorage.addKey("m.secret_storage.v1.aes-hmac-sha2");

        // it should have made up a 32-character key id
        expect(result.keyId.length).toEqual(32);
        expect(accountDataAdapter.setAccountData).toHaveBeenCalledWith(
            `m.secret_storage.key.${result.keyId}`,
            result.keyInfo,
        );
    });
});
