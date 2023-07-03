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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";
import { Mocked } from "jest-mock";

import { RustVerificationRequest } from "../../../src/rust-crypto/verification";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";

describe("VerificationRequest", () => {
    describe("startVerification", () => {
        let mockedInner: Mocked<RustSdkCryptoJs.VerificationRequest>;
        let mockedOutgoingRequestProcessor: Mocked<OutgoingRequestProcessor>;
        let request: RustVerificationRequest;

        beforeEach(() => {
            mockedInner = {
                registerChangesCallback: jest.fn(),
                startSas: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.VerificationRequest>;
            mockedOutgoingRequestProcessor = {} as Mocked<OutgoingRequestProcessor>;
            request = new RustVerificationRequest(mockedInner, mockedOutgoingRequestProcessor, undefined);
        });

        it("does not permit methods other than SAS", async () => {
            await expect(request.startVerification("m.reciprocate.v1")).rejects.toThrow(
                "Unsupported verification method",
            );
        });

        it("raises an error if starting verification does not produce a verifier", async () => {
            await expect(request.startVerification("m.sas.v1")).rejects.toThrow(
                "Still no verifier after startSas() call",
            );
        });
    });
});
