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

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";
import { KeysQueryRequest, OlmMachine } from "@matrix-org/matrix-sdk-crypto-js";
import { Mocked } from "jest-mock";

import { RustCrypto } from "../../../src/rust-crypto/rust-crypto";
import { initRustCrypto } from "../../../src/rust-crypto";
import { IToDeviceEvent, MatrixClient, MatrixHttpApi } from "../../../src";
import { mkEvent } from "../../test-utils/test-utils";
import { CryptoBackend } from "../../../src/common-crypto/CryptoBackend";
import { IEventDecryptionResult } from "../../../src/@types/crypto";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

describe("RustCrypto", () => {
    const TEST_USER = "@alice:example.com";
    const TEST_DEVICE_ID = "TEST_DEVICE";

    describe(".exportRoomKeys", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            const mockHttpApi = {} as MatrixClient["http"];
            rustCrypto = (await initRustCrypto(mockHttpApi, TEST_USER, TEST_DEVICE_ID)) as RustCrypto;
        });

        it("should return a list", async () => {
            const keys = await rustCrypto.exportRoomKeys();
            expect(Array.isArray(keys)).toBeTruthy();
        });
    });

    describe("to-device messages", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            const mockHttpApi = {} as MatrixClient["http"];
            rustCrypto = (await initRustCrypto(mockHttpApi, TEST_USER, TEST_DEVICE_ID)) as RustCrypto;
        });

        it("should pass through unencrypted to-device messages", async () => {
            const inputs: IToDeviceEvent[] = [
                { content: { key: "value" }, type: "org.matrix.test", sender: "@alice:example.com" },
            ];
            const res = await rustCrypto.preprocessToDeviceMessages(inputs);
            expect(res).toEqual(inputs);
        });

        it("should pass through bad encrypted messages", async () => {
            const olmMachine: OlmMachine = rustCrypto["olmMachine"];
            const keys = olmMachine.identityKeys;
            const inputs: IToDeviceEvent[] = [
                {
                    type: "m.room.encrypted",
                    content: {
                        algorithm: "m.olm.v1.curve25519-aes-sha2",
                        sender_key: "IlRMeOPX2e0MurIyfWEucYBRVOEEUMrOHqn/8mLqMjA",
                        ciphertext: {
                            [keys.curve25519.toBase64()]: {
                                type: 0,
                                body: "ajyjlghi",
                            },
                        },
                    },
                    sender: "@alice:example.com",
                },
            ];

            const res = await rustCrypto.preprocessToDeviceMessages(inputs);
            expect(res).toEqual(inputs);
        });
    });

    describe("outgoing requests", () => {
        /** the RustCrypto implementation under test */
        let rustCrypto: RustCrypto;

        /** A mock OutgoingRequestProcessor which rustCrypto is connected to */
        let outgoingRequestProcessor: Mocked<OutgoingRequestProcessor>;

        /** a mocked-up OlmMachine which rustCrypto is connected to */
        let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

        /** A list of results to be returned from olmMachine.outgoingRequest. Each call will shift a result off
         *  the front of the queue, until it is empty. */
        let outgoingRequestQueue: Array<Array<any>>;

        /** wait for a call to outgoingRequestProcessor.makeOutgoingRequest.
         *
         * The promise resolves to a callback: the makeOutgoingRequest call will not complete until the returned
         * callback is called.
         */
        function awaitCallToMakeOutgoingRequest(): Promise<() => void> {
            return new Promise<() => void>((resolveCalledPromise, _reject) => {
                outgoingRequestProcessor.makeOutgoingRequest.mockImplementationOnce(async () => {
                    const completePromise = new Promise<void>((resolveCompletePromise, _reject) => {
                        resolveCalledPromise(resolveCompletePromise);
                    });
                    return completePromise;
                });
            });
        }

        beforeEach(async () => {
            await RustSdkCryptoJs.initAsync();

            // for these tests we use a mock OlmMachine, with an implementation of outgoingRequests that
            // returns objects from outgoingRequestQueue
            outgoingRequestQueue = [];
            olmMachine = {
                outgoingRequests: jest.fn().mockImplementation(() => {
                    return Promise.resolve(outgoingRequestQueue.shift() ?? []);
                }),
                close: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

            outgoingRequestProcessor = {
                makeOutgoingRequest: jest.fn(),
            } as unknown as Mocked<OutgoingRequestProcessor>;

            rustCrypto = new RustCrypto(olmMachine, {} as MatrixHttpApi<any>, TEST_USER, TEST_DEVICE_ID);
            rustCrypto["outgoingRequestProcessor"] = outgoingRequestProcessor;
        });

        it("should poll for outgoing messages and send them", async () => {
            const testReq = new KeysQueryRequest("1234", "{}");
            outgoingRequestQueue.push([testReq]);

            const makeRequestPromise = awaitCallToMakeOutgoingRequest();
            rustCrypto.onSyncCompleted({});

            await makeRequestPromise;
            expect(olmMachine.outgoingRequests).toHaveBeenCalled();
            expect(outgoingRequestProcessor.makeOutgoingRequest).toHaveBeenCalledWith(testReq);
        });

        it("stops looping when stop() is called", async () => {
            for (let i = 0; i < 5; i++) {
                outgoingRequestQueue.push([new KeysQueryRequest("1234", "{}")]);
            }

            let makeRequestPromise = awaitCallToMakeOutgoingRequest();

            rustCrypto.onSyncCompleted({});

            expect(rustCrypto["outgoingRequestLoopRunning"]).toBeTruthy();

            // go a couple of times round the loop
            let resolveMakeRequest = await makeRequestPromise;
            makeRequestPromise = awaitCallToMakeOutgoingRequest();
            resolveMakeRequest();

            resolveMakeRequest = await makeRequestPromise;
            makeRequestPromise = awaitCallToMakeOutgoingRequest();
            resolveMakeRequest();

            // a second sync while this is going on shouldn't make any difference
            rustCrypto.onSyncCompleted({});

            resolveMakeRequest = await makeRequestPromise;
            outgoingRequestProcessor.makeOutgoingRequest.mockReset();
            resolveMakeRequest();

            // now stop...
            rustCrypto.stop();

            // which should (eventually) cause the loop to stop with no further calls to outgoingRequests
            olmMachine.outgoingRequests.mockReset();

            await new Promise((resolve) => {
                setTimeout(resolve, 100);
            });
            expect(rustCrypto["outgoingRequestLoopRunning"]).toBeFalsy();
            expect(outgoingRequestProcessor.makeOutgoingRequest).not.toHaveBeenCalled();
            expect(olmMachine.outgoingRequests).not.toHaveBeenCalled();

            // we sent three, so there should be 2 left
            expect(outgoingRequestQueue.length).toEqual(2);
        });
    });

    describe(".getEventEncryptionInfo", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            const mockHttpApi = {} as MatrixClient["http"];
            rustCrypto = (await initRustCrypto(mockHttpApi, TEST_USER, TEST_DEVICE_ID)) as RustCrypto;
        });

        it("should handle unencrypted events", () => {
            const event = mkEvent({ event: true, type: "m.room.message", content: { body: "xyz" } });
            const res = rustCrypto.getEventEncryptionInfo(event);
            expect(res.encrypted).toBeFalsy();
        });

        it("should handle encrypted events", async () => {
            const event = mkEvent({ event: true, type: "m.room.encrypted", content: { algorithm: "fake_alg" } });
            const mockCryptoBackend = {
                decryptEvent: () =>
                    ({
                        senderCurve25519Key: "1234",
                    } as IEventDecryptionResult),
            } as unknown as CryptoBackend;
            await event.attemptDecryption(mockCryptoBackend);

            const res = rustCrypto.getEventEncryptionInfo(event);
            expect(res.encrypted).toBeTruthy();
        });
    });
});
