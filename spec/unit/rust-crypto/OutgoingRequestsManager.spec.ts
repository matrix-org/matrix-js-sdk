/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { Mocked } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { OutgoingRequestsManager } from "../../../src/rust-crypto/OutgoingRequestsManager";
import { logger } from "../../../lib/logger";
import { defer } from "../../../src/utils";
import { OutgoingRequest } from "../../../lib/rust-crypto/OutgoingRequestProcessor";

describe("OutgoingRequestsManager", () => {
    /** the OutgoingRequestProcessor implementation under test */
    let manager: OutgoingRequestsManager;

    /** a mock  OutgoingRequestProcessor */
    let processor: Mocked<OutgoingRequestProcessor>;

    /** a mocked-up OlmMachine which processor is connected to */
    let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

    beforeEach(async () => {
        olmMachine = {
            outgoingRequests: jest.fn(),
        } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

        processor = {
            makeOutgoingRequest: jest.fn(),
        } as unknown as Mocked<OutgoingRequestProcessor>;

        manager = new OutgoingRequestsManager(logger, olmMachine, processor);
    });

    describe("requestLoop", () => {
        it("Requests are processed directly when requested", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            const request2 = new RustSdkCryptoJs.KeysUploadRequest("foo2", "{}");
            olmMachine.outgoingRequests.mockImplementationOnce(async () => {
                return [request1, request2];
            });

            processor.makeOutgoingRequest.mockImplementationOnce(async () => {
                return;
            });

            await manager.requestLoop();

            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(2);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request2);
        });

        it("Stack requests while one is already running", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            const request2 = new RustSdkCryptoJs.KeysUploadRequest("foo2", "{}");
            const request3 = new RustSdkCryptoJs.KeysBackupRequest("foo3", "{}", "1");

            const firstOutgoingRequestDefer = defer<OutgoingRequest[]>();

            olmMachine.outgoingRequests
                .mockImplementationOnce(async (): Promise<OutgoingRequest[]> => {
                    return firstOutgoingRequestDefer.promise;
                })
                .mockImplementationOnce(async () => {
                    return [request3];
                });

            const firstRequest = manager.requestLoop();

            // stack 2 additional requests while the first one is still running
            const secondRequest = manager.requestLoop();
            const thirdRequest = manager.requestLoop();

            // let the first request complete
            firstOutgoingRequestDefer.resolve([request1, request2]);

            await firstRequest;
            await secondRequest;
            await thirdRequest;

            // outgoingRequests should be called twice in total, as the second and third requests are
            // processed in the same loop.
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(2);

            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(3);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request2);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request3);
        });

        it("Should not bubble if request is rejected", async () => {
            const request = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            olmMachine.outgoingRequests.mockImplementationOnce(async () => {
                return [request];
            });

            processor.makeOutgoingRequest.mockImplementationOnce(async () => {
                throw new Error("Some network error");
            });

            await manager.requestLoop();

            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);
        });
    });

    describe("Stop", () => {
        it("Is stopped properly before making requests", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");

            const firstOutgoingRequestDefer = defer<OutgoingRequest[]>();

            olmMachine.outgoingRequests.mockImplementationOnce(async (): Promise<OutgoingRequest[]> => {
                return firstOutgoingRequestDefer.promise;
            });

            const firstRequest = manager.requestLoop();

            // stop
            manager.stop();

            // let the first request complete
            firstOutgoingRequestDefer.resolve([request1]);

            await firstRequest;

            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(0);
        });

        it("Is stopped properly after calling outgoing requests", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");

            const firstOutgoingRequestDefer = defer<OutgoingRequest[]>();

            olmMachine.outgoingRequests.mockImplementationOnce(async (): Promise<OutgoingRequest[]> => {
                return firstOutgoingRequestDefer.promise;
            });

            const firstRequest = manager.requestLoop();

            // stop
            manager.stop();

            // let the first request complete
            firstOutgoingRequestDefer.resolve([request1]);

            await firstRequest;

            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(0);
        });

        it("Is stopped properly in between requests", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("11", "{}");
            const request2 = new RustSdkCryptoJs.KeysUploadRequest("12", "{}");

            const firstRequestDefer = defer<void>();

            olmMachine.outgoingRequests.mockImplementationOnce(async (): Promise<OutgoingRequest[]> => {
                return [request1, request2];
            });

            processor.makeOutgoingRequest
                .mockImplementationOnce(async () => {
                    manager.stop();
                    return firstRequestDefer.promise;
                })
                .mockImplementationOnce(async () => {
                    return;
                });

            const firstRequest = manager.requestLoop();

            firstRequestDefer.resolve();

            await firstRequest;

            // should have been called once but not twice
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(1);
        });
    });
});