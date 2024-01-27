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
    RoomMessageRequest,
    SignatureUploadRequest,
    UploadSigningKeysRequest,
    ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";
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
});
