/*
Copyright 2018-2019 New Vector Ltd
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
import "../../../olm-loader";
import { MatrixEvent } from "../../../../src/models/event";
import { SAS } from "../../../../src/crypto/verification/SAS";
import { logger } from "../../../../src/logger";
import { IVerificationChannel } from "../../../../src/crypto/verification/request/Channel";
import { MatrixClient } from "../../../../src";
import { VerificationRequest } from "../../../../src/crypto/verification/request/VerificationRequest";
const Olm = globalThis.Olm;

describe("SAS verification", function () {
    if (!globalThis.Olm) {
        logger.warn("Not running device verification unit tests: libolm not present");
        return;
    }

    beforeAll(function () {
        return Olm.init();
    });

    it("should error on an unexpected event", async function () {
        //channel, baseApis, userId, deviceId, startEvent, request
        const request = {
            onVerifierCancelled: function () {},
        } as VerificationRequest;
        const channel = {
            send: function () {
                return Promise.resolve();
            },
        } as unknown as IVerificationChannel;
        const mockClient = {} as unknown as MatrixClient;
        const event = new MatrixEvent({ type: "test" });
        const sas = new SAS(channel, mockClient, "@alice:example.com", "ABCDEFG", event, request);
        sas.handleEvent(
            new MatrixEvent({
                sender: "@alice:example.com",
                type: "es.inquisition",
                content: {},
            }),
        );
        const spy = jest.fn();
        await sas.verify().catch(spy);
        expect(spy).toHaveBeenCalled();

        // Cancel the SAS for cleanup (we started a verification, so abort)
        sas.cancel(new Error("error"));
    });
});
