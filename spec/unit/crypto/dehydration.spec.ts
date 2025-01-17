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

import "../../olm-loader";
import { TestClient } from "../../TestClient";
import { logger } from "../../../src/logger";
import { DEHYDRATION_ALGORITHM } from "../../../src/crypto/dehydration";

const Olm = globalThis.Olm;

describe("Dehydration", () => {
    if (!globalThis.Olm) {
        logger.warn("Not running dehydration unit tests: libolm not present");
        return;
    }

    beforeAll(function () {
        return globalThis.Olm.init();
    });

    it("should rehydrate a dehydrated device", async () => {
        const key = new Uint8Array([1, 2, 3]);
        const alice = new TestClient("@alice:example.com", "Osborne2", undefined, undefined, {
            cryptoCallbacks: {
                getDehydrationKey: async (t) => key,
            },
        });

        const dehydratedDevice = new Olm.Account();
        dehydratedDevice.create();

        alice.httpBackend.when("GET", "/dehydrated_device").respond(200, {
            device_id: "ABCDEFG",
            device_data: {
                algorithm: DEHYDRATION_ALGORITHM,
                account: dehydratedDevice.pickle(new Uint8Array(key)),
            },
        });
        alice.httpBackend.when("POST", "/dehydrated_device/claim").respond(200, {
            success: true,
        });

        expect((await Promise.all([alice.client.rehydrateDevice(), alice.httpBackend.flushAllExpected()]))[0]).toEqual(
            "ABCDEFG",
        );

        expect(alice.client.getDeviceId()).toEqual("ABCDEFG");
    });
});
