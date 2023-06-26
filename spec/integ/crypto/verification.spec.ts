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

import "fake-indexeddb/auto";

import { MockResponse } from "fetch-mock";
import fetchMock from "fetch-mock-jest";
import { IDBFactory } from "fake-indexeddb";

import { createClient, CryptoEvent, ICreateClientOpts, MatrixClient } from "../../../src";
import {
    canAcceptVerificationRequest,
    ShowQrCodeCallbacks,
    ShowSasCallbacks,
    VerificationPhase,
    VerificationRequest,
    VerificationRequestEvent,
    Verifier,
    VerifierEvent,
} from "../../../src/crypto-api/verification";
import { escapeRegExp } from "../../../src/utils";
import { CRYPTO_BACKENDS, emitPromise, InitCrypto } from "../../test-utils/test-utils";
import { SyncResponder } from "../../test-utils/SyncResponder";
import {
    MASTER_CROSS_SIGNING_PUBLIC_KEY_BASE64,
    SIGNED_CROSS_SIGNING_KEYS_DATA,
    SIGNED_TEST_DEVICE_DATA,
    TEST_DEVICE_ID,
    TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
    TEST_USER_ID,
} from "../../test-utils/test-data";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";

// The verification flows use javascript timers to set timeouts. We tell jest to use mock timer implementations
// to ensure that we don't end up with dangling timeouts.
jest.useFakeTimers();

let previousCrypto: Crypto | undefined;

beforeAll(async () => {
    // Stub out global.crypto
    previousCrypto = global["crypto"];

    Object.defineProperty(global, "crypto", {
        value: {
            getRandomValues: function <T extends Uint8Array>(array: T): T {
                array.fill(0x12);
                return array;
            },
        },
    });

    // we use the libolm primitives in the test, so init the Olm library
    await global.Olm.init();
});

// load the rust library. This can take a few seconds on a slow GH worker.
beforeAll(async () => {
    const RustSdkCryptoJs = await require("@matrix-org/matrix-sdk-crypto-js");
    await RustSdkCryptoJs.initAsync();
}, 10000);

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

// restore the original global.crypto
afterAll(() => {
    if (previousCrypto === undefined) {
        // @ts-ignore deleting a non-optional property. It *is* optional really.
        delete global.crypto;
    } else {
        Object.defineProperty(global, "crypto", {
            value: previousCrypto,
        });
    }
});

/** The homeserver url that we give to the test client, and where we intercept /sync, /keys, etc requests. */
const TEST_HOMESERVER_URL = "https://alice-server.com";

/**
 * Integration tests for verification functionality.
 *
 * These tests work by intercepting HTTP requests via fetch-mock rather than mocking out bits of the client, so as
 * to provide the most effective integration tests possible.
 */
// we test with both crypto stacks...
describe.each(Object.entries(CRYPTO_BACKENDS))("verification (%s)", (backend: string, initCrypto: InitCrypto) => {
    // oldBackendOnly is an alternative to `it` or `test` which will skip the test if we are running against the
    // Rust backend. Once we have full support in the rust sdk, it will go away.
    const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;

    /** the client under test */
    let aliceClient: MatrixClient;

    /** an object which intercepts `/sync` requests on the test homeserver */
    let syncResponder: SyncResponder;

    /** an object which intercepts `/keys/query` requests on the test homeserver */
    let e2eKeyResponder: E2EKeyResponder;

    /** an object which intercepts `/keys/upload` requests on the test homeserver */
    let e2eKeyReceiver: E2EKeyReceiver;

    beforeEach(async () => {
        // anything that we don't have a specific matcher for silently returns a 404
        fetchMock.catch(404);
        fetchMock.config.warnOnFallback = false;

        e2eKeyReceiver = new E2EKeyReceiver(TEST_HOMESERVER_URL);
        e2eKeyResponder = new E2EKeyResponder(TEST_HOMESERVER_URL);
        e2eKeyResponder.addKeyReceiver(TEST_USER_ID, e2eKeyReceiver);
        syncResponder = new SyncResponder(TEST_HOMESERVER_URL);

        mockInitialApiRequests(TEST_HOMESERVER_URL);
    });

    afterEach(async () => {
        if (aliceClient !== undefined) {
            await aliceClient.stopClient();
        }

        // Allow in-flight things to complete before we tear down the test
        await jest.runAllTimersAsync();

        fetchMock.mockReset();
    });

    describe("Outgoing verification requests for another device", () => {
        beforeEach(async () => {
            // pretend that we have another device, which we will verify
            e2eKeyResponder.addDeviceKeys(TEST_USER_ID, TEST_DEVICE_ID, SIGNED_TEST_DEVICE_DATA);
        });

        // test with (1) the default verification method list, (2) a custom verification method list.
        const TEST_METHODS = ["m.sas.v1", "m.qr_code.show.v1", "m.reciprocate.v1"];
        it.each([undefined, TEST_METHODS])("can verify via SAS (supported methods=%s)", async (methods) => {
            aliceClient = await startTestClient({ verificationMethods: methods });
            await waitForDeviceList();

            // initially there should be no verifications in progress
            {
                const requests = aliceClient.getCrypto()!.getVerificationRequestsToDeviceInProgress(TEST_USER_ID);
                expect(requests.length).toEqual(0);
            }

            // have alice initiate a verification. She should send a m.key.verification.request
            let [requestBody, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;
            expect(transactionId).toBeDefined();
            expect(request.phase).toEqual(VerificationPhase.Requested);
            expect(request.roomId).toBeUndefined();
            expect(request.isSelfVerification).toBe(true);
            expect(request.otherPartySupportsMethod("m.sas.v1")).toBe(false); // no reply yet
            expect(request.chosenMethod).toBe(null); // nothing chosen yet
            expect(request.initiatedByMe).toBe(true);
            expect(request.otherUserId).toEqual(TEST_USER_ID);

            // and now the request should be visible via `getVerificationRequestsToDeviceInProgress`
            {
                const requests = aliceClient.getCrypto()!.getVerificationRequestsToDeviceInProgress(TEST_USER_ID);
                expect(requests.length).toEqual(1);
                expect(requests[0].transactionId).toEqual(transactionId);
            }

            let toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.from_device).toEqual(aliceClient.deviceId);
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);
            if (methods !== undefined) {
                // eslint-disable-next-line jest/no-conditional-expect
                expect(new Set(toDeviceMessage.methods)).toEqual(new Set(methods));
            }

            // The dummy device replies with an m.key.verification.ready...
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.sas.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.otherDeviceId).toEqual(TEST_DEVICE_ID);

            // ... and picks a method with m.key.verification.start
            returnToDeviceMessageFromSync(buildSasStartMessage(transactionId));

            // as soon as the Changed event arrives, `verifier` should be defined
            const verifier = await new Promise<Verifier>((resolve) => {
                function onChange() {
                    expect(request.phase).toEqual(VerificationPhase.Started);
                    expect(request.otherPartySupportsMethod("m.sas.v1")).toBe(true);
                    expect(request.chosenMethod).toEqual("m.sas.v1");

                    const verifier: Verifier = request.verifier!;
                    expect(verifier).toBeDefined();
                    expect(verifier.getShowSasCallbacks()).toBeNull();

                    resolve(verifier);
                }
                request.once(VerificationRequestEvent.Change, onChange);
            });

            // start off the verification process: alice will send an `accept`
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.accept");
            const verificationPromise = verifier.verify();
            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            jest.advanceTimersByTime(10);

            requestBody = await sendToDevicePromise;
            toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.key_agreement_protocol).toEqual("curve25519-hkdf-sha256");
            expect(toDeviceMessage.short_authentication_string).toEqual(["decimal", "emoji"]);
            const macMethod = toDeviceMessage.message_authentication_code;
            expect(macMethod).toEqual("hkdf-hmac-sha256.v2");
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);

            // The dummy device makes up a curve25519 keypair and sends the public bit back in an `m.key.verification.key'
            // We use the Curve25519, HMAC and HKDF implementations in libolm, for now
            const olmSAS = new global.Olm.SAS();
            returnToDeviceMessageFromSync({
                type: "m.key.verification.key",
                content: {
                    transaction_id: transactionId,
                    key: olmSAS.get_pubkey(),
                },
            });

            // alice responds with a 'key' ...
            requestBody = await expectSendToDeviceMessage("m.key.verification.key");
            toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);
            const aliceDevicePubKeyBase64 = toDeviceMessage.key;
            olmSAS.set_their_key(aliceDevicePubKeyBase64);

            // ... and the client is notified to show the emoji
            const showSas = await new Promise<ShowSasCallbacks>((resolve) => {
                verifier.once(VerifierEvent.ShowSas, resolve);
            });

            // `getShowSasCallbacks` is an alternative way to get the callbacks
            expect(verifier.getShowSasCallbacks()).toBe(showSas);
            expect(verifier.getReciprocateQrCodeCallbacks()).toBeNull();

            // user confirms that the emoji match, and alice sends a 'mac'
            [requestBody] = await Promise.all([expectSendToDeviceMessage("m.key.verification.mac"), showSas.confirm()]);
            toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);

            // the dummy device also confirms that the emoji match, and sends a mac
            const macInfoBase = `MATRIX_KEY_VERIFICATION_MAC${TEST_USER_ID}${TEST_DEVICE_ID}${TEST_USER_ID}${aliceClient.deviceId}${transactionId}`;
            returnToDeviceMessageFromSync({
                type: "m.key.verification.mac",
                content: {
                    keys: calculateMAC(olmSAS, `ed25519:${TEST_DEVICE_ID}`, `${macInfoBase}KEY_IDS`),
                    transaction_id: transactionId,
                    mac: {
                        [`ed25519:${TEST_DEVICE_ID}`]: calculateMAC(
                            olmSAS,
                            TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
                            `${macInfoBase}ed25519:${TEST_DEVICE_ID}`,
                        ),
                    },
                },
            });

            // that should satisfy Alice, who should reply with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // the dummy device also confirms done-ness
            returnToDeviceMessageFromSync({
                type: "m.key.verification.done",
                content: {
                    transaction_id: transactionId,
                },
            });

            // ... and the whole thing should be done!
            await verificationPromise;
            expect(request.phase).toEqual(VerificationPhase.Done);

            // at this point, cancelling should do nothing.
            await request.cancel();
            expect(request.phase).toEqual(VerificationPhase.Done);

            // we're done with the temporary keypair
            olmSAS.free();
        });

        it("Can make a verification request to *all* devices", async () => {
            aliceClient = await startTestClient();
            // we need an existing cross-signing key for this
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

            // have alice initiate a verification. She should send a m.key.verification.request
            const [requestBody, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestOwnUserVerification(),
            ]);

            const transactionId = request.transactionId;
            expect(transactionId).toBeDefined();
            expect(request.phase).toEqual(VerificationPhase.Requested);

            // and now the request should be visible via `getVerificationRequestsToDeviceInProgress`
            {
                const requests = aliceClient.getCrypto()!.getVerificationRequestsToDeviceInProgress(TEST_USER_ID);
                expect(requests.length).toEqual(1);
                expect(requests[0].transactionId).toEqual(transactionId);
            }

            // legacy crypto picks devices individually; rust crypto uses a broadcast message
            const toDeviceMessage =
                requestBody.messages[TEST_USER_ID]["*"] ?? requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.from_device).toEqual(aliceClient.deviceId);
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);
        });

        oldBackendOnly("can verify another via QR code with an untrusted cross-signing key", async () => {
            aliceClient = await startTestClient();
            // QRCode fails if we don't yet have the cross-signing keys, so make sure we have them now.
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();
            expect(aliceClient.getStoredCrossSigningForUser(TEST_USER_ID)).toBeTruthy();

            // have alice initiate a verification. She should send a m.key.verification.request
            const [requestBody, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            const toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.methods).toContain("m.qr_code.show.v1");
            expect(toDeviceMessage.methods).toContain("m.reciprocate.v1");
            expect(toDeviceMessage.methods).toContain("m.qr_code.scan.v1");
            expect(toDeviceMessage.from_device).toEqual(aliceClient.deviceId);
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);

            // The dummy device replies with an m.key.verification.ready, with an indication we can scan the QR code
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.qr_code.scan.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);

            // we should now have QR data we can display
            const qrCodeBuffer = request.getQRCodeBytes()!;
            expect(qrCodeBuffer).toBeTruthy();

            // https://spec.matrix.org/v1.7/client-server-api/#qr-code-format
            expect(qrCodeBuffer.subarray(0, 6).toString("latin1")).toEqual("MATRIX");
            expect(qrCodeBuffer.readUint8(6)).toEqual(0x02); // version
            expect(qrCodeBuffer.readUint8(7)).toEqual(0x02); // mode
            const txnIdLen = qrCodeBuffer.readUint16BE(8);
            expect(qrCodeBuffer.subarray(10, 10 + txnIdLen).toString("utf-8")).toEqual(transactionId);
            // Alice's device's public key comes next, but we have nothing to do with it here.
            // const aliceDevicePubKey = qrCodeBuffer.subarray(10 + txnIdLen, 32 + 10 + txnIdLen);
            expect(qrCodeBuffer.subarray(42 + txnIdLen, 32 + 42 + txnIdLen)).toEqual(
                Buffer.from(MASTER_CROSS_SIGNING_PUBLIC_KEY_BASE64, "base64"),
            );
            const sharedSecret = qrCodeBuffer.subarray(74 + txnIdLen);

            // the dummy device "scans" the displayed QR code and acknowledges it with a "m.key.verification.start"
            returnToDeviceMessageFromSync({
                type: "m.key.verification.start",
                content: {
                    from_device: TEST_DEVICE_ID,
                    method: "m.reciprocate.v1",
                    transaction_id: transactionId,
                    secret: encodeUnpaddedBase64(sharedSecret),
                },
            });
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Started);
            expect(request.chosenMethod).toEqual("m.reciprocate.v1");

            // there should now be a verifier
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();
            expect(verifier.getReciprocateQrCodeCallbacks()).toBeNull();

            // ... which we call .verify on, which emits a ShowReciprocateQr event
            const verificationPromise = verifier.verify();
            const reciprocateQRCodeCallbacks = await new Promise<ShowQrCodeCallbacks>((resolve) => {
                verifier.once(VerifierEvent.ShowReciprocateQr, resolve);
            });

            // getReciprocateQrCodeCallbacks() is an alternative way to get the callbacks
            expect(verifier.getReciprocateQrCodeCallbacks()).toBe(reciprocateQRCodeCallbacks);
            expect(verifier.getShowSasCallbacks()).toBeNull();

            // Alice confirms she is happy
            reciprocateQRCodeCallbacks.confirm();

            // that should satisfy Alice, who should reply with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // ... and the whole thing should be done!
            await verificationPromise;
            expect(request.phase).toEqual(VerificationPhase.Done);
        });
    });

    describe("cancellation", () => {
        beforeEach(async () => {
            // pretend that we have another device, which we will start verifying
            e2eKeyResponder.addDeviceKeys(TEST_USER_ID, TEST_DEVICE_ID, SIGNED_TEST_DEVICE_DATA);

            aliceClient = await startTestClient();
            await waitForDeviceList();
        });

        it("can cancel during the Ready phase", async () => {
            // have alice initiate a verification. She should send a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready...
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.sas.v1"]));
            await waitForVerificationRequestChanged(request);

            // now alice changes her mind
            const [requestBody] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.cancel"),
                request.cancel(),
            ]);
            const toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);
            expect(toDeviceMessage.code).toEqual("m.user");
            expect(request.phase).toEqual(VerificationPhase.Cancelled);
        });

        it("can cancel during the SAS phase", async () => {
            // have alice initiate a verification. She should send a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready...
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.sas.v1"]));
            await waitForVerificationRequestChanged(request);

            // ... and picks a method with m.key.verification.start
            returnToDeviceMessageFromSync(buildSasStartMessage(transactionId));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Started);

            // there should now be a verifier...
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();
            expect(verifier.hasBeenCancelled).toBe(false);

            // start off the verification process: alice will send an `accept`
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.accept");
            const verificationPromise = verifier.verify();
            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            jest.advanceTimersByTime(10);
            await sendToDevicePromise;

            // now we unceremoniously cancel. We expect the verificatationPromise to reject.
            const requestPromise = expectSendToDeviceMessage("m.key.verification.cancel");
            verifier.cancel(new Error("blah"));
            await requestPromise;

            // ... which should cancel the verifier
            await expect(verificationPromise).rejects.toThrow();
            expect(request.phase).toEqual(VerificationPhase.Cancelled);
            expect(verifier.hasBeenCancelled).toBe(true);
        });
    });

    describe("Incoming verification from another device", () => {
        beforeEach(() => {
            e2eKeyResponder.addDeviceKeys(TEST_USER_ID, TEST_DEVICE_ID, SIGNED_TEST_DEVICE_DATA);
        });

        oldBackendOnly("Incoming verification: can accept", async () => {
            aliceClient = await startTestClient();
            const TRANSACTION_ID = "abcd";

            // Initiate the request by sending a to-device message
            returnToDeviceMessageFromSync({
                type: "m.key.verification.request",
                content: {
                    from_device: TEST_DEVICE_ID,
                    methods: ["m.sas.v1"],
                    transaction_id: TRANSACTION_ID,
                    timestamp: Date.now() - 1000,
                },
            });
            const request: VerificationRequest = await emitPromise(aliceClient, CryptoEvent.VerificationRequest);
            expect(request.transactionId).toEqual(TRANSACTION_ID);
            expect(request.phase).toEqual(VerificationPhase.Requested);
            expect(request.roomId).toBeUndefined();
            expect(request.initiatedByMe).toBe(false);
            expect(request.otherUserId).toEqual(TEST_USER_ID);
            expect(request.chosenMethod).toBe(null); // nothing chosen yet
            expect(canAcceptVerificationRequest(request)).toBe(true);

            // Alice accepts, by sending a to-device message
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.ready");
            const acceptPromise = request.accept();
            expect(canAcceptVerificationRequest(request)).toBe(false);
            expect(request.phase).toEqual(VerificationPhase.Requested);
            await acceptPromise;
            const requestBody = await sendToDevicePromise;
            expect(request.phase).toEqual(VerificationPhase.Ready);

            const toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.methods).toContain("m.sas.v1");
            expect(toDeviceMessage.from_device).toEqual(aliceClient.deviceId);
            expect(toDeviceMessage.transaction_id).toEqual(TRANSACTION_ID);
        });
    });

    async function startTestClient(opts: Partial<ICreateClientOpts> = {}): Promise<MatrixClient> {
        const client = createClient({
            baseUrl: TEST_HOMESERVER_URL,
            userId: TEST_USER_ID,
            accessToken: "akjgkrgjs",
            deviceId: "device_under_test",
            ...opts,
        });
        await initCrypto(client);
        await client.startClient();
        return client;
    }

    /** make sure that the client knows about the dummy device */
    async function waitForDeviceList(): Promise<void> {
        // Completing the initial sync will make the device list download outdated device lists (of which our own
        // user will be one).
        syncResponder.sendOrQueueSyncResponse({});
        // DeviceList has a sleep(5) which we need to make happen
        await jest.advanceTimersByTimeAsync(10);

        // The client should now know about the dummy device
        const devices = await aliceClient.getCrypto()!.getUserDeviceInfo([TEST_USER_ID]);
        expect(devices.get(TEST_USER_ID)!.keys()).toContain(TEST_DEVICE_ID);
    }

    function returnToDeviceMessageFromSync(ev: { type: string; content: object; sender?: string }): void {
        ev.sender ??= TEST_USER_ID;
        syncResponder.sendOrQueueSyncResponse({ to_device: { events: [ev] } });
    }
});

/**
 * Wait for the client under test to send a to-device message of the given type.
 *
 * @param msgtype - type of to-device message we expect
 * @returns A Promise which resolves with the body of the HTTP request
 */
function expectSendToDeviceMessage(msgtype: string): Promise<{ messages: any }> {
    return new Promise((resolve) => {
        fetchMock.putOnce(
            new RegExp(`/_matrix/client/(r0|v3)/sendToDevice/${escapeRegExp(msgtype)}`),
            (url: string, opts: RequestInit): MockResponse => {
                resolve(JSON.parse(opts.body as string));
                return {};
            },
        );
    });
}

/** wait for the verification request to emit a 'Change' event */
function waitForVerificationRequestChanged(request: VerificationRequest): Promise<void> {
    return new Promise<void>((resolve) => {
        request.once(VerificationRequestEvent.Change, resolve);
    });
}

/** Perform a MAC calculation on the given data
 *
 * Does an HKDR and HMAC as defined by the matrix spec (https://spec.matrix.org/v1.7/client-server-api/#mac-calculation,
 * as amended by https://github.com/matrix-org/matrix-spec/issues/1553).
 *
 * @param olmSAS
 * @param input
 * @param info
 */
function calculateMAC(olmSAS: Olm.SAS, input: string, info: string): string {
    const mac = olmSAS.calculate_mac_fixed_base64(input, info);
    //console.info(`Test MAC: input:'${input}, info: '${info}' -> '${mac}`);
    return mac;
}

function encodeUnpaddedBase64(uint8Array: ArrayBuffer | Uint8Array): string {
    return Buffer.from(uint8Array).toString("base64").replace(/=+$/g, "");
}

/** build an m.key.verification.ready to-device message originating from the dummy device */
function buildReadyMessage(transactionId: string, methods: string[]): { type: string; content: object } {
    return {
        type: "m.key.verification.ready",
        content: {
            from_device: TEST_DEVICE_ID,
            methods: methods,
            transaction_id: transactionId,
        },
    };
}

/** build an m.key.verification.start to-device message suitable for the SAS flow, originating from the dummy device */
function buildSasStartMessage(transactionId: string): { type: string; content: object } {
    return {
        type: "m.key.verification.start",
        content: {
            from_device: TEST_DEVICE_ID,
            method: "m.sas.v1",
            transaction_id: transactionId,
            hashes: ["sha256"],
            key_agreement_protocols: ["curve25519-hkdf-sha256"],
            message_authentication_codes: ["hkdf-hmac-sha256.v2"],
            // we have to include "decimal" per the spec.
            short_authentication_string: ["decimal", "emoji"],
        },
    };
}
