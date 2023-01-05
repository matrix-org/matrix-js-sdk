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
import {
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    OlmMachine,
    SignatureUploadRequest,
} from "@matrix-org/matrix-sdk-crypto-js";
import { Mocked } from "jest-mock";
import MockHttpBackend from "matrix-mock-request";

import { RustCrypto } from "../../src/rust-crypto/rust-crypto";
import { initRustCrypto } from "../../src/rust-crypto";
import { HttpApiEvent, HttpApiEventHandlerMap, IToDeviceEvent, MatrixClient, MatrixHttpApi } from "../../src";
import { TypedEventEmitter } from "../../src/models/typed-event-emitter";

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

        /** A mock http backend which rustCrypto is connected to */
        let httpBackend: MockHttpBackend;

        /** a mocked-up OlmMachine which rustCrypto is connected to */
        let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

        /** A list of results to be returned from olmMachine.outgoingRequest. Each call will shift a result off
         *  the front of the queue, until it is empty. */
        let outgoingRequestQueue: Array<Array<any>>;

        /** wait for a call to olmMachine.markRequestAsSent */
        function awaitCallToMarkAsSent(): Promise<void> {
            return new Promise((resolve, _reject) => {
                olmMachine.markRequestAsSent.mockImplementationOnce(async () => {
                    resolve(undefined);
                });
            });
        }

        beforeEach(async () => {
            httpBackend = new MockHttpBackend();

            await RustSdkCryptoJs.initAsync();

            const dummyEventEmitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            const httpApi = new MatrixHttpApi(dummyEventEmitter, {
                baseUrl: "https://example.com",
                prefix: "/_matrix",
                fetchFn: httpBackend.fetchFn as typeof global.fetch,
                onlyData: true,
            });

            // for these tests we use a mock OlmMachine, with an implementation of outgoingRequests that
            // returns objects from outgoingRequestQueue
            outgoingRequestQueue = [];
            olmMachine = {
                outgoingRequests: jest.fn().mockImplementation(() => {
                    return Promise.resolve(outgoingRequestQueue.shift() ?? []);
                }),
                markRequestAsSent: jest.fn(),
                close: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

            rustCrypto = new RustCrypto(olmMachine, httpApi, TEST_USER, TEST_DEVICE_ID);
        });

        it("should poll for outgoing messages", () => {
            rustCrypto.onSyncCompleted({});
            expect(olmMachine.outgoingRequests).toHaveBeenCalled();
        });

        /* simple requests that map directly to the request body */
        const tests: Array<[any, "POST" | "PUT", string]> = [
            [KeysUploadRequest, "POST", "https://example.com/_matrix/client/v3/keys/upload"],
            [KeysQueryRequest, "POST", "https://example.com/_matrix/client/v3/keys/query"],
            [KeysClaimRequest, "POST", "https://example.com/_matrix/client/v3/keys/claim"],
            [SignatureUploadRequest, "POST", "https://example.com/_matrix/client/v3/keys/signatures/upload"],
            [KeysBackupRequest, "PUT", "https://example.com/_matrix/client/v3/room_keys/keys"],
        ];

        for (const [RequestClass, expectedMethod, expectedPath] of tests) {
            it(`should handle ${RequestClass.name}s`, async () => {
                const testBody = '{ "foo": "bar" }';
                const outgoingRequest = new RequestClass("1234", testBody);
                outgoingRequestQueue.push([outgoingRequest]);

                const testResponse = '{ "result": 1 }';
                httpBackend
                    .when(expectedMethod, "/_matrix")
                    .check((req) => {
                        expect(req.path).toEqual(expectedPath);
                        expect(req.rawData).toEqual(testBody);
                        expect(req.headers["Accept"]).toEqual("application/json");
                        expect(req.headers["Content-Type"]).toEqual("application/json");
                    })
                    .respond(200, testResponse, true);

                rustCrypto.onSyncCompleted({});

                expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);

                const markSentCallPromise = awaitCallToMarkAsSent();
                await httpBackend.flushAllExpected();

                await markSentCallPromise;
                expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("1234", outgoingRequest.type, testResponse);
                httpBackend.verifyNoOutstandingRequests();
            });
        }

        it("does not explode with unknown requests", async () => {
            const outgoingRequest = { id: "5678", type: 987 };
            outgoingRequestQueue.push([outgoingRequest]);

            rustCrypto.onSyncCompleted({});

            await awaitCallToMarkAsSent();
            expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("5678", 987, "");
        });

        it("stops looping when stop() is called", async () => {
            const testResponse = '{ "result": 1 }';

            for (let i = 0; i < 5; i++) {
                outgoingRequestQueue.push([new KeysQueryRequest("1234", "{}")]);
                httpBackend.when("POST", "/_matrix").respond(200, testResponse, true);
            }

            rustCrypto.onSyncCompleted({});

            expect(rustCrypto["outgoingRequestLoopRunning"]).toBeTruthy();

            // go a couple of times round the loop
            await httpBackend.flush("/_matrix", 1);
            await awaitCallToMarkAsSent();

            await httpBackend.flush("/_matrix", 1);
            await awaitCallToMarkAsSent();

            // a second sync while this is going on shouldn't make any difference
            rustCrypto.onSyncCompleted({});

            await httpBackend.flush("/_matrix", 1);
            await awaitCallToMarkAsSent();

            // now stop...
            rustCrypto.stop();

            // which should (eventually) cause the loop to stop with no further calls to outgoingRequests
            olmMachine.outgoingRequests.mockReset();

            await new Promise((resolve) => {
                setTimeout(resolve, 100);
            });
            expect(rustCrypto["outgoingRequestLoopRunning"]).toBeFalsy();
            httpBackend.verifyNoOutstandingRequests();
            expect(olmMachine.outgoingRequests).not.toHaveBeenCalled();

            // we sent three, so there should be 2 left
            expect(outgoingRequestQueue.length).toEqual(2);
        });
    });
});
