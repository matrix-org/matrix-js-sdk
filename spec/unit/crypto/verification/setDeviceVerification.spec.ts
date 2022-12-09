/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import "../../../olm-loader";

import { CRYPTO_ENABLED, MatrixClient } from "../../../../src/client";
import { TestClient } from "../../../TestClient";

const Olm = global.Olm;

describe("crypto.setDeviceVerification", () => {
    const userId = "@alice:example.com";
    const deviceId1 = "device1";
    let client: MatrixClient;

    if (!CRYPTO_ENABLED) {
        return;
    }

    beforeAll(async () => {
        await Olm.init();
    });

    beforeEach(async () => {
        client = new TestClient(userId, deviceId1).client;
        await client.initCrypto();
    });

    it("client should provide crypto", () => {
        expect(client.crypto).not.toBeUndefined();
    });

    describe("when setting an own device as verified", () => {
        beforeEach(async () => {
            jest.spyOn(client.crypto!, "cancelAndResendAllOutgoingKeyRequests");
            await client.crypto!.setDeviceVerification(userId, deviceId1, true);
        });

        it("cancelAndResendAllOutgoingKeyRequests should be called", () => {
            expect(client.crypto!.cancelAndResendAllOutgoingKeyRequests).toHaveBeenCalled();
        });
    });
});
