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

import MockHttpBackend from "matrix-mock-request";
import { Mocked } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import {
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    PutDehydratedDeviceRequest,
    RoomMessageRequest,
    SignatureUploadRequest,
    UploadSigningKeysRequest,
    ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import fetchMock from "fetch-mock-jest";

import { TypedEventEmitter } from "../../../src";
import { HttpApiEvent, HttpApiEventHandlerMap, IHttpOpts, MatrixHttpApi, UIAuthCallback } from "../../../src";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { defer } from "../../../src/utils";

describe("OutgoingRequestProcessor", () => {
    /** the OutgoingRequestProcessor implementation under test */
    let processor: OutgoingRequestProcessor;

    /** A mock http backend which processor is connected to */
    let httpBackend: MockHttpBackend;

    /** a mocked-up OlmMachine which processor is connected to */
    let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

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

        const dummyEventEmitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
        const httpApi = new MatrixHttpApi(dummyEventEmitter, {
            baseUrl: "https://example.com",
            prefix: "/_matrix",
            fetchFn: httpBackend.fetchFn as typeof global.fetch,
            onlyData: true,
        });

        olmMachine = {
            markRequestAsSent: jest.fn(),
        } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

        processor = new OutgoingRequestProcessor(olmMachine, httpApi);
    });

    /* simple requests that map directly to the request body */
    const tests: Array<[string, any, "POST" | "PUT", string]> = [
        ["KeysUploadRequest", KeysUploadRequest, "POST", "https://example.com/_matrix/client/v3/keys/upload"],
        ["KeysQueryRequest", KeysQueryRequest, "POST", "https://example.com/_matrix/client/v3/keys/query"],
        ["KeysClaimRequest", KeysClaimRequest, "POST", "https://example.com/_matrix/client/v3/keys/claim"],
        [
            "SignatureUploadRequest",
            SignatureUploadRequest,
            "POST",
            "https://example.com/_matrix/client/v3/keys/signatures/upload",
        ],
        ["KeysBackupRequest", KeysBackupRequest, "PUT", "https://example.com/_matrix/client/v3/room_keys/keys"],
    ];

    test.each(tests)(`should handle %ss`, async (_, RequestClass, expectedMethod, expectedPath) => {
        // first, mock up a request as we might expect to receive it from the Rust layer ...
        const testBody = '{ "foo": "bar" }';
        const outgoingRequest = new RequestClass("1234", testBody);

        // ... then poke it into the OutgoingRequestProcessor under test.
        const reqProm = processor.makeOutgoingRequest(outgoingRequest);

        // Now: check that it makes a matching HTTP request ...
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

        // ... and that it calls OlmMachine.markAsSent.
        const markSentCallPromise = awaitCallToMarkAsSent();
        await httpBackend.flushAllExpected();

        await Promise.all([reqProm, markSentCallPromise]);
        expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("1234", outgoingRequest.type, testResponse);
        httpBackend.verifyNoOutstandingRequests();
    });

    it("should handle ToDeviceRequests", async () => {
        // first, mock up the ToDeviceRequest as we might expect to receive it from the Rust layer ...
        const testBody = '{ "messages": { "user": {"device": "bar" }}}';
        const outgoingRequest = new ToDeviceRequest("1234", "test/type", "test/txnid", testBody);

        // ... then poke it into the OutgoingRequestProcessor under test.
        const reqProm = processor.makeOutgoingRequest(outgoingRequest);

        // Now: check that it makes a matching HTTP request ...
        const testResponse = '{ "result": 1 }';
        httpBackend
            .when("PUT", "/_matrix")
            .check((req) => {
                expect(req.path).toEqual("https://example.com/_matrix/client/v3/sendToDevice/test%2Ftype/test%2Ftxnid");
                expect(req.rawData).toEqual(testBody);
                expect(req.headers["Accept"]).toEqual("application/json");
                expect(req.headers["Content-Type"]).toEqual("application/json");
            })
            .respond(200, testResponse, true);

        // ... and that it calls OlmMachine.markAsSent.
        const markSentCallPromise = awaitCallToMarkAsSent();
        await httpBackend.flushAllExpected();

        await Promise.all([reqProm, markSentCallPromise]);
        expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("1234", outgoingRequest.type, testResponse);
        httpBackend.verifyNoOutstandingRequests();
    });

    it("should handle RoomMessageRequests", async () => {
        // first, mock up the RoomMessageRequest as we might expect to receive it from the Rust layer ...
        const testBody = '{ "foo": "bar" }';
        const outgoingRequest = new RoomMessageRequest("1234", "test/room", "test/txnid", "test/type", testBody);

        // ... then poke it into the OutgoingRequestProcessor under test.
        const reqProm = processor.makeOutgoingRequest(outgoingRequest);

        // Now: check that it makes a matching HTTP request ...
        const testResponse = '{ "result": 1 }';
        httpBackend
            .when("PUT", "/_matrix")
            .check((req) => {
                expect(req.path).toEqual(
                    "https://example.com/_matrix/client/v3/rooms/test%2Froom/send/test%2Ftype/test%2Ftxnid",
                );
                expect(req.rawData).toEqual(testBody);
                expect(req.headers["Accept"]).toEqual("application/json");
                expect(req.headers["Content-Type"]).toEqual("application/json");
            })
            .respond(200, testResponse, true);

        // ... and that it calls OlmMachine.markAsSent.
        const markSentCallPromise = awaitCallToMarkAsSent();
        await httpBackend.flushAllExpected();

        await Promise.all([reqProm, markSentCallPromise]);
        expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("1234", outgoingRequest.type, testResponse);
        httpBackend.verifyNoOutstandingRequests();
    });

    it("should handle UploadSigningKeysRequest without UIA", async () => {
        // first, mock up a request as we might expect to receive it from the Rust layer ...
        const testReq = { foo: "bar" };
        const outgoingRequest = new UploadSigningKeysRequest(JSON.stringify(testReq));

        // ... then poke the request into the OutgoingRequestProcessor under test
        const reqProm = processor.makeOutgoingRequest(outgoingRequest);

        // Now: check that it makes a matching HTTP request.
        const testResponse = '{"result":1}';
        httpBackend
            .when("POST", "/_matrix")
            .check((req) => {
                expect(req.path).toEqual("https://example.com/_matrix/client/v3/keys/device_signing/upload");
                expect(JSON.parse(req.rawData)).toEqual(testReq);
                expect(req.headers["Accept"]).toEqual("application/json");
                expect(req.headers["Content-Type"]).toEqual("application/json");
            })
            .respond(200, testResponse, true);

        // SigningKeysUploadRequest does not need to be marked as sent, so no call to OlmMachine.markAsSent is expected.

        await httpBackend.flushAllExpected();
        await reqProm;
        httpBackend.verifyNoOutstandingRequests();
    });

    it("should handle UploadSigningKeysRequest with UIA", async () => {
        // first, mock up a request as we might expect to receive it from the Rust layer ...
        const testReq = { foo: "bar" };
        const outgoingRequest = new UploadSigningKeysRequest(JSON.stringify(testReq));

        // also create a UIA callback
        const authCallback: UIAuthCallback<Object> = async (makeRequest) => {
            return await makeRequest({ type: "test" });
        };

        // ... then poke the request into the OutgoingRequestProcessor under test
        const reqProm = processor.makeOutgoingRequest(outgoingRequest, authCallback);

        // Now: check that it makes a matching HTTP request.
        const testResponse = '{"result":1}';
        httpBackend
            .when("POST", "/_matrix")
            .check((req) => {
                expect(req.path).toEqual("https://example.com/_matrix/client/v3/keys/device_signing/upload");
                expect(JSON.parse(req.rawData)).toEqual({ foo: "bar", auth: { type: "test" } });
                expect(req.headers["Accept"]).toEqual("application/json");
                expect(req.headers["Content-Type"]).toEqual("application/json");
            })
            .respond(200, testResponse, true);

        // SigningKeysUploadRequest does not need to be marked as sent, so no call to OlmMachine.markAsSent is expected.

        await httpBackend.flushAllExpected();
        await reqProm;
        httpBackend.verifyNoOutstandingRequests();
    });

    it("should handle PutDehydratedDeviceRequest", async () => {
        // first, mock up a request as we might expect to receive it from the Rust layer ...
        const testReq = { foo: "bar" };
        const outgoingRequest = new PutDehydratedDeviceRequest(JSON.stringify(testReq));

        // ... then poke the request into the OutgoingRequestProcessor under test
        const reqProm = processor.makeOutgoingRequest(outgoingRequest);

        // Now: check that it makes a matching HTTP request.
        const testResponse = '{"result":1}';
        httpBackend
            .when("PUT", "/_matrix")
            .check((req) => {
                expect(req.path).toEqual(
                    "https://example.com/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device",
                );
                expect(JSON.parse(req.rawData)).toEqual(testReq);
                expect(req.headers["Accept"]).toEqual("application/json");
                expect(req.headers["Content-Type"]).toEqual("application/json");
            })
            .respond(200, testResponse, true);

        // PutDehydratedDeviceRequest does not need to be marked as sent, so no call to OlmMachine.markAsSent is expected.

        await httpBackend.flushAllExpected();
        await reqProm;
        httpBackend.verifyNoOutstandingRequests();
    });

    it("does not explode with unknown requests", async () => {
        const outgoingRequest = { id: "5678", type: 987 };
        const markSentCallPromise = awaitCallToMarkAsSent();
        await Promise.all([processor.makeOutgoingRequest(outgoingRequest), markSentCallPromise]);
        expect(olmMachine.markRequestAsSent).toHaveBeenCalledWith("5678", 987, "");
    });

    it("does not explode if the OlmMachine is stopped while the request is in flight", async () => {
        // we use a real olm machine for this test
        const olmMachine = await RustSdkCryptoJs.OlmMachine.initialize(
            new RustSdkCryptoJs.UserId("@alice:example.com"),
            new RustSdkCryptoJs.DeviceId("TEST_DEVICE"),
        );

        const authRequestResultDefer = defer<string>();

        const authRequestCalledPromise = new Promise<void>((resolve) => {
            const mockHttpApi = {
                authedRequest: async () => {
                    resolve();
                    return await authRequestResultDefer.promise;
                },
            } as unknown as Mocked<MatrixHttpApi<IHttpOpts & { onlyData: true }>>;
            processor = new OutgoingRequestProcessor(olmMachine, mockHttpApi);
        });

        // build a request
        const request = olmMachine.queryKeysForUsers([new RustSdkCryptoJs.UserId("@bob:example.com")]);
        const result = processor.makeOutgoingRequest(request);

        // wait for the HTTP request to be made
        await authRequestCalledPromise;

        // while the HTTP request is in flight, the OlmMachine gets stopped.
        olmMachine.close();

        // the HTTP request completes...
        authRequestResultDefer.resolve("{}");

        // ... and `makeOutgoingRequest` resolves satisfactorily
        await result;
    });

    describe("Should retry requests", () => {
        beforeEach(() => {
            jest.useFakeTimers();

            // here we use another httpApi instance in order to use fetchMock
            const dummyEventEmitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            const httpApi = new MatrixHttpApi(dummyEventEmitter, {
                baseUrl: "https://example.com",
                prefix: "/_matrix",
                onlyData: true,
            });

            processor = new OutgoingRequestProcessor(olmMachine, httpApi);
        });

        afterEach(() => {
            jest.useRealTimers();
            fetchMock.reset();
        });

        describe("Should retry on retryable errors", () => {
            const retryableErrors: Array<[number, { status: number; body: { error: string } }]> = [
                [429, { status: 429, body: { error: "Too Many Requests" } }],
                [500, { status: 500, body: { error: "Internal Server Error" } }],
                [502, { status: 502, body: { error: "Bad Gateway" } }],
                [503, { status: 503, body: { error: "Service Unavailable" } }],
                [504, { status: 504, body: { error: "Gateway timeout" } }],
                [505, { status: 505, body: { error: "HTTP Version Not Supported" } }],
                [506, { status: 506, body: { error: "Variant Also Negotiates" } }],
                [507, { status: 507, body: { error: "Insufficient Storage" } }],
                [508, { status: 508, body: { error: "Loop Detected" } }],
                [510, { status: 510, body: { error: "Not Extended" } }],
                [511, { status: 511, body: { error: "Network Authentication Required" } }],
                [525, { status: 525, body: { error: "SSL Handshake Failed" } }],
            ];
            describe.each(retryableErrors)(`When status code is %s`, (_, error) => {
                test.each(tests)(`for request of type %ss`, async (_, RequestClass, expectedMethod, expectedPath) => {
                    // first, mock up a request as we might expect to receive it from the Rust layer ...
                    const testBody = '{ "foo": "bar" }';
                    const outgoingRequest = new RequestClass("1234", testBody);

                    fetchMock.mock(expectedPath, error, { method: expectedMethod });

                    const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

                    // Run all timers and wait for the request promise to resolve/reject
                    await Promise.all([jest.runAllTimersAsync(), requestPromise.catch(() => {})]);

                    await expect(requestPromise).rejects.toThrow();

                    // Should have ultimately made 5 requests (1 initial + 4 retries)
                    const calls = fetchMock.calls(expectedPath);
                    expect(calls).toHaveLength(5);

                    // The promise should have been rejected
                    await expect(requestPromise).rejects.toThrow();
                });
            });
        });

        it("should not retry if M_TOO_LARGE", async () => {
            const testBody = '{ "messages": { "user": {"device": "bar" }}}';
            const outgoingRequest = new ToDeviceRequest("1234", "custom.type", "12345", testBody);

            fetchMock.put("express:/_matrix/client/v3/sendToDevice/:type/:txnId", {
                status: 502,
                body: {
                    errcode: "M_TOO_LARGE",
                    error: "Request too large",
                },
            });

            const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

            await Promise.all([requestPromise.catch(() => {}), jest.runAllTimersAsync()]);

            await expect(requestPromise).rejects.toThrow();

            const calls = fetchMock.calls("express:/_matrix/client/v3/sendToDevice/:type/:txnId");
            expect(calls).toHaveLength(1);

            // The promise should have been rejected
            await expect(requestPromise).rejects.toThrow();
        });

        it("should retry on Failed to fetch connection errors", async () => {
            let callCount = 0;
            fetchMock.post("path:/_matrix/client/v3/keys/upload", (url, opts) => {
                callCount++;
                if (callCount == 2) {
                    return {
                        status: 200,
                        body: "{}",
                    };
                } else {
                    throw new Error("Failed to fetch");
                }
            });

            const outgoingRequest = new KeysUploadRequest("1234", "{}");

            const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

            await Promise.all([requestPromise, jest.runAllTimersAsync()]);

            const calls = fetchMock.calls("path:/_matrix/client/v3/keys/upload");
            expect(calls).toHaveLength(2);
            expect(olmMachine.markRequestAsSent).toHaveBeenCalled();
        });

        it("should retry to send to-device", async () => {
            let callCount = 0;
            const testBody = '{ "messages": { "user": {"device": "bar" }}}';
            const outgoingRequest = new ToDeviceRequest("1234", "custom.type", "12345", testBody);

            fetchMock.put("express:/_matrix/client/v3/sendToDevice/:type/:txnId", (url, opts) => {
                callCount++;
                if (callCount == 2) {
                    return {
                        status: 200,
                        body: "{}",
                    };
                } else {
                    throw new Error("Failed to fetch");
                }
            });

            const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

            await Promise.all([requestPromise, jest.runAllTimersAsync()]);

            const calls = fetchMock.calls("express:/_matrix/client/v3/sendToDevice/:type/:txnId");
            expect(calls).toHaveLength(2);
            expect(olmMachine.markRequestAsSent).toHaveBeenCalled();
        });

        it("should retry to call with UIA", async () => {
            let callCount = 0;
            const testBody = '{ "foo": "bar" }';
            const outgoingRequest = new UploadSigningKeysRequest(testBody);

            fetchMock.post("path:/_matrix/client/v3/keys/device_signing/upload", (url, opts) => {
                callCount++;
                if (callCount == 2) {
                    return {
                        status: 200,
                        body: "{}",
                    };
                } else {
                    throw new Error("Failed to fetch");
                }
            });
            const authCallback: UIAuthCallback<Object> = async (makeRequest) => {
                return await makeRequest({ type: "test" });
            };
            const requestPromise = processor.makeOutgoingRequest(outgoingRequest, authCallback);

            await Promise.all([requestPromise, jest.runAllTimersAsync()]);

            const calls = fetchMock.calls("path:/_matrix/client/v3/keys/device_signing/upload");
            expect(calls).toHaveLength(2);
            // Will not mark as sent as it's a UIA request
        });

        it("should retry on respect server cool down on LIMIT_EXCEEDED", async () => {
            const retryAfterMs = 5000;
            let callCount = 0;

            fetchMock.post("path:/_matrix/client/v3/keys/upload", (url, opts) => {
                callCount++;
                if (callCount == 2) {
                    return {
                        status: 200,
                        body: "{}",
                    };
                } else {
                    return {
                        status: 429,
                        body: {
                            errcode: "M_LIMIT_EXCEEDED",
                            error: "Too many requests",
                            retry_after_ms: retryAfterMs,
                        },
                    };
                }
            });

            const outgoingRequest = new KeysUploadRequest("1234", "{}");

            const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

            // advanced by less than the retryAfterMs
            await jest.advanceTimersByTimeAsync(retryAfterMs - 1000);

            // should not have made a second request yet
            {
                const calls = fetchMock.calls("path:/_matrix/client/v3/keys/upload");
                expect(calls).toHaveLength(1);
            }

            // advanced by the remaining time
            await jest.advanceTimersByTimeAsync(retryAfterMs + 1000);

            await requestPromise;

            const calls = fetchMock.calls("path:/_matrix/client/v3/keys/upload");
            expect(calls).toHaveLength(2);
            expect(olmMachine.markRequestAsSent).toHaveBeenCalled();
        });

        const nonRetryableErrors: Array<[number, { status: number; body: { errcode: string } }]> = [
            [400, { status: 400, body: { errcode: "Bad Request" } }],
            [401, { status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }],
            [403, { status: 403, body: { errcode: "M_FORBIDDEN" } }],
        ];

        describe.each(nonRetryableErrors)("Should not retry all sort of errors", (_, error) => {
            test.each(tests)("for %ss", async (_, RequestClass, expectedMethod, expectedPath) => {
                const testBody = '{ "foo": "bar" }';
                const outgoingRequest = new RequestClass("1234", testBody);

                // @ts-ignore to avoid having to do if else to switch the method (.put/.post)
                fetchMock[expectedMethod.toLowerCase()](expectedPath, {
                    status: error.status,
                    body: error.body,
                });

                const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

                // Run all timers and wait for the request promise to resolve/reject
                await Promise.all([jest.runAllTimersAsync(), requestPromise.catch(() => {})]);

                await expect(requestPromise).rejects.toThrow();

                // Should have only tried once
                const calls = fetchMock.calls(expectedPath);
                expect(calls).toHaveLength(1);

                await expect(requestPromise).rejects.toThrow();
            });
        });

        describe("Should not retry client timeouts", () => {
            test.each(tests)("for %ss", async (_, RequestClass, expectedMethod, expectedPath) => {
                const testBody = '{ "foo": "bar" }';
                const outgoingRequest = new RequestClass("1234", testBody);

                // @ts-ignore to avoid having to do if else to switch the method (.put/.post)
                fetchMock[expectedMethod.toLowerCase()](expectedPath, () => {
                    // This is what a client timeout error will throw
                    throw new DOMException("The user aborted a request.", "AbortError");
                });

                const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

                // Run all timers and wait for the request promise to resolve/reject
                await Promise.all([jest.runAllTimersAsync(), requestPromise.catch(() => {})]);

                await expect(requestPromise).rejects.toThrow();

                // Should have only tried once
                const calls = fetchMock.calls(expectedPath);
                expect(calls).toHaveLength(1);
                await expect(requestPromise).rejects.toThrow();
            });
        });

        describe("Should retry until it works", () => {
            it.each([1, 2, 3, 4])("should succeed if the call number %s is ok", async (successfulCall) => {
                let callCount = 0;
                fetchMock.post("path:/_matrix/client/v3/keys/upload", (url, opts) => {
                    callCount++;
                    if (callCount == successfulCall) {
                        return {
                            status: 200,
                            body: "{}",
                        };
                    } else {
                        return {
                            status: 500,
                            body: { error: "Internal server error" },
                        };
                    }
                });

                const outgoingRequest = new KeysUploadRequest("1234", "{}");

                const requestPromise = processor.makeOutgoingRequest(outgoingRequest);

                await Promise.all([requestPromise, jest.runAllTimersAsync()]);

                const calls = fetchMock.calls("path:/_matrix/client/v3/keys/upload");
                expect(calls).toHaveLength(successfulCall);
                expect(olmMachine.markRequestAsSent).toHaveBeenCalled();
            });
        });
    });
});
