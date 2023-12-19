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

import { Mocked } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { OutgoingRequest, OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { OutgoingRequestsManager } from "../../../src/rust-crypto/OutgoingRequestsManager";
import { defer, IDeferred } from "../../../src/utils";
import { logger } from "../../../src/logger";

describe("OutgoingRequestsManager", () => {
    /** the OutgoingRequestsManager implementation under test */
    let manager: OutgoingRequestsManager;

    /** a mock OutgoingRequestProcessor */
    let processor: Mocked<OutgoingRequestProcessor>;

    /** a mocked-up OlmMachine which manager is connected to */
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

    describe("Call doProcessOutgoingRequests", () => {
        it("The call triggers handling of the machine outgoing requests", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            const request2 = new RustSdkCryptoJs.KeysUploadRequest("foo2", "{}");
            olmMachine.outgoingRequests.mockImplementationOnce(async () => {
                return [request1, request2];
            });

            processor.makeOutgoingRequest.mockImplementationOnce(async () => {
                return;
            });

            await manager.doProcessOutgoingRequests();

            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(2);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request2);
        });

        it("Stack and batch calls to doProcessOutgoingRequests while one is already running", async () => {
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

            const firstRequest = manager.doProcessOutgoingRequests();

            // stack 2 additional requests while the first one is still running
            const secondRequest = manager.doProcessOutgoingRequests();
            const thirdRequest = manager.doProcessOutgoingRequests();

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

        it("Process 3 consecutive calls to doProcessOutgoingRequests while not blocking previous ones", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            const request2 = new RustSdkCryptoJs.KeysUploadRequest("foo2", "{}");
            const request3 = new RustSdkCryptoJs.KeysBackupRequest("foo3", "{}", "1");

            // promises which will resolve when OlmMachine.outgoingRequests is called
            const outgoingRequestCalledPromises: Promise<void>[] = [];

            // deferreds which will provide the results of OlmMachine.outgoingRequests
            const outgoingRequestResultDeferreds: IDeferred<OutgoingRequest[]>[] = [];

            for (let i = 0; i < 3; i++) {
                const resultDeferred = defer<OutgoingRequest[]>();
                const calledPromise = new Promise<void>((resolve) => {
                    olmMachine.outgoingRequests.mockImplementationOnce(() => {
                        resolve();
                        return resultDeferred.promise;
                    });
                });
                outgoingRequestCalledPromises.push(calledPromise);
                outgoingRequestResultDeferreds.push(resultDeferred);
            }

            const call1 = manager.doProcessOutgoingRequests();

            // First call will start an iteration and for now is awaiting on outgoingRequests
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);

            // Make a new call now: this will request a new iteration
            const call2 = manager.doProcessOutgoingRequests();

            // let the first iteration complete
            outgoingRequestResultDeferreds[0].resolve([request1]);

            // The first call should now complete
            await call1;
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(1);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request1);

            // Wait for the second iteration to fire and be waiting on `outgoingRequests`
            await outgoingRequestCalledPromises[1];
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(2);

            // Stack a new call that should be processed in an additional iteration.
            const call3 = manager.doProcessOutgoingRequests();

            outgoingRequestResultDeferreds[1].resolve([request2]);
            await call2;
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(2);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request2);

            // Wait for the third iteration to fire and be waiting on `outgoingRequests`
            await outgoingRequestCalledPromises[2];
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(3);
            outgoingRequestResultDeferreds[2].resolve([request3]);
            await call3;

            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(3);
            expect(processor.makeOutgoingRequest).toHaveBeenCalledWith(request3);

            // ensure that no other iteration is going on
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(3);
        });

        it("Should not bubble exceptions if server request is rejected", async () => {
            const request = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");
            olmMachine.outgoingRequests.mockImplementationOnce(async () => {
                return [request];
            });

            processor.makeOutgoingRequest.mockImplementationOnce(async () => {
                throw new Error("Some network error");
            });

            await manager.doProcessOutgoingRequests();

            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);
        });
    });

    describe("Calling stop on the manager should stop ongoing work", () => {
        it("When the manager is stopped after outgoingRequests() call, do not make sever requests", async () => {
            const request1 = new RustSdkCryptoJs.KeysQueryRequest("foo", "{}");

            const firstOutgoingRequestDefer = defer<OutgoingRequest[]>();

            olmMachine.outgoingRequests.mockImplementationOnce(async (): Promise<OutgoingRequest[]> => {
                return firstOutgoingRequestDefer.promise;
            });

            const firstRequest = manager.doProcessOutgoingRequests();

            // stop
            manager.stop();

            // let the first request complete
            firstOutgoingRequestDefer.resolve([request1]);

            await firstRequest;

            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(0);
        });

        it("When the manager is stopped while doing server calls, it should stop before the next sever call", async () => {
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

            const firstRequest = manager.doProcessOutgoingRequests();

            firstRequestDefer.resolve();

            await firstRequest;

            // should have been called once but not twice
            expect(processor.makeOutgoingRequest).toHaveBeenCalledTimes(1);
        });
    });
});
