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

import anotherjson from "another-json";
import FetchMock from "fetch-mock";
import fetchMock from "fetch-mock-jest";
import { IDBFactory } from "fake-indexeddb";
import { createHash } from "crypto";
import Olm from "@matrix-org/olm";

import {
    createClient,
    CryptoEvent,
    DeviceVerification,
    IContent,
    ICreateClientOpts,
    IEvent,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent,
} from "../../../src";
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
import { defer, escapeRegExp } from "../../../src/utils";
import {
    awaitDecryption,
    CRYPTO_BACKENDS,
    emitPromise,
    getSyncResponse,
    InitCrypto,
    syncPromise,
} from "../../test-utils/test-utils";
import { SyncResponder } from "../../test-utils/SyncResponder";
import {
    BACKUP_DECRYPTION_KEY_BASE64,
    BOB_ONE_TIME_KEYS,
    BOB_SIGNED_CROSS_SIGNING_KEYS_DATA,
    BOB_SIGNED_TEST_DEVICE_DATA,
    BOB_TEST_USER_ID,
    CURVE25519_KEY_BACKUP_DATA,
    MASTER_CROSS_SIGNING_PUBLIC_KEY_BASE64,
    SIGNED_CROSS_SIGNING_KEYS_DATA,
    SIGNED_TEST_DEVICE_DATA,
    TEST_DEVICE_ID,
    TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
    TEST_ROOM_ID,
    TEST_USER_ID,
} from "../../test-utils/test-data";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import {
    bootstrapCrossSigningTestOlmAccount,
    createOlmSession,
    encryptGroupSessionKey,
    encryptMegolmEvent,
    encryptSecretSend,
    ToDeviceEvent,
} from "./olm-utils";
import { KeyBackupInfo } from "../../../src/crypto-api";
import { encodeBase64 } from "../../../src/base64";

// The verification flows use javascript timers to set timeouts. We tell jest to use mock timer implementations
// to ensure that we don't end up with dangling timeouts.
// But the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

beforeAll(async () => {
    // we use the libolm primitives in the test, so init the Olm library
    await global.Olm.init();
});

// load the rust library. This can take a few seconds on a slow GH worker.
beforeAll(async () => {
    const RustSdkCryptoJs = await require("@matrix-org/matrix-sdk-crypto-wasm");
    await RustSdkCryptoJs.initAsync();
}, 10000);

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
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
    // newBackendOnly is the opposite to `oldBackendOnly`: it will skip the test if we are running against the legacy
    // backend. Once we drop support for legacy crypto, it will go away.
    const newBackendOnly = backend === "rust-sdk" ? test : test.skip;

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
            e2eKeyResponder.addDeviceKeys(SIGNED_TEST_DEVICE_DATA);

            fetchMock.put(
                new RegExp(`/_matrix/client/(r0|v3)/sendToDevice/${escapeRegExp("m.secret.request")}`),
                { ok: false, status: 404 },
                { overwriteRoutes: true },
            );
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
            expect(request.pending).toBe(true);
            // we're using fake timers, so the timeout should have exactly 10 minutes left still.
            expect(request.timeout).toEqual(600_000);

            // and now the request should be visible via `getVerificationRequestsToDeviceInProgress`
            {
                const requests = aliceClient.getCrypto()!.getVerificationRequestsToDeviceInProgress(TEST_USER_ID);
                expect(requests.length).toEqual(1);
                expect(requests[0].transactionId).toEqual(transactionId);
            }

            // check that the returned request depends on the given userID
            {
                const requests = aliceClient
                    .getCrypto()!
                    .getVerificationRequestsToDeviceInProgress("@unknown:localhost");
                expect(requests.length).toEqual(0);
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
            returnToDeviceMessageFromSync(buildSasKeyMessage(transactionId, olmSAS.get_pubkey()));

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
            returnToDeviceMessageFromSync(
                buildSasMacMessage(transactionId, olmSAS, TEST_USER_ID, aliceClient.deviceId!),
            );

            // that should satisfy Alice, who should reply with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // the dummy device also confirms done-ness
            returnToDeviceMessageFromSync(buildDoneMessage(transactionId));

            // ... and the whole thing should be done!
            await verificationPromise;
            expect(request.phase).toEqual(VerificationPhase.Done);
            expect(request.pending).toBe(false);

            // at this point, cancelling should do nothing.
            await request.cancel();
            expect(request.phase).toEqual(VerificationPhase.Done);

            // we're done with the temporary keypair
            olmSAS.free();
        });

        it("can initiate SAS verification ourselves", async () => {
            aliceClient = await startTestClient();
            await waitForDeviceList();

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.sas.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.otherPartySupportsMethod("m.sas.v1")).toBe(true);

            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            await jest.advanceTimersByTimeAsync(10);

            // And now Alice starts a SAS verification
            let sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.start");
            await request.startVerification("m.sas.v1");
            let requestBody = await sendToDevicePromise;

            let toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage).toEqual({
                from_device: aliceClient.deviceId,
                method: "m.sas.v1",
                transaction_id: transactionId,
                hashes: ["sha256"],
                key_agreement_protocols: expect.arrayContaining(["curve25519-hkdf-sha256"]),
                message_authentication_codes: expect.arrayContaining(["hkdf-hmac-sha256.v2"]),
                short_authentication_string: ["decimal", "emoji"],
            });

            expect(request.chosenMethod).toEqual("m.sas.v1");

            // There should now be a `verifier`
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();
            expect(verifier.getShowSasCallbacks()).toBeNull();
            const verificationPromise = verifier.verify();

            // The dummy device makes up a curve25519 keypair and uses the hash in an 'm.key.verification.accept'
            // We use the Curve25519, HMAC and HKDF implementations in libolm, for now
            const olmSAS = new global.Olm.SAS();
            const commitmentStr = olmSAS.get_pubkey() + anotherjson.stringify(toDeviceMessage);

            sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.key");
            returnToDeviceMessageFromSync(buildSasAcceptMessage(transactionId, commitmentStr));

            // alice responds with a 'key' ...
            requestBody = await sendToDevicePromise;

            toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.transaction_id).toEqual(transactionId);
            const aliceDevicePubKeyBase64 = toDeviceMessage.key;
            olmSAS.set_their_key(aliceDevicePubKeyBase64);

            // ... and the dummy device also sends a 'key'
            returnToDeviceMessageFromSync(buildSasKeyMessage(transactionId, olmSAS.get_pubkey()));

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
            returnToDeviceMessageFromSync(
                buildSasMacMessage(transactionId, olmSAS, TEST_USER_ID, aliceClient.deviceId!),
            );

            // that should satisfy Alice, who should reply with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // the dummy device also confirms done-ness
            returnToDeviceMessageFromSync(buildDoneMessage(transactionId));

            // ... and the whole thing should be done!
            await verificationPromise;
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

        it("can verify another via QR code with an untrusted cross-signing key", async () => {
            // This is a slightly weird thing to test; if we don't trust the cross-signing key, normally we would
            // spam out a verification request to all devices rather than targeting a single device. Still, it's
            // a thing both the Matrix protocol and the js-sdk API support, so we may as well test it.
            //
            // Since we don't yet trust the master key, this is a type 0x02 QR code:
            //   "self-verifying in which the current device does not yet trust the master key"
            //
            // By the end of it, we should trust the master key.

            aliceClient = await startTestClient();
            // QRCode fails if we don't yet have the cross-signing keys, so make sure we have them now.
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

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
            const qrCodeBuffer = (await request.generateQRCode())!;
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

            // we should still be "Ready" and have no verifier
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.verifier).toBeUndefined();

            // the dummy device "scans" the displayed QR code and acknowledges it with a "m.key.verification.start"
            returnToDeviceMessageFromSync(buildReciprocateStartMessage(transactionId, sharedSecret));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Started);
            expect(request.chosenMethod).toEqual("m.reciprocate.v1");

            // there should now be a verifier
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();

            // ... which we call .verify on, which emits a ShowReciprocateQr event
            const reciprocatePromise = new Promise<ShowQrCodeCallbacks>((resolve) => {
                verifier.once(VerifierEvent.ShowReciprocateQr, resolve);
            });
            const verificationPromise = verifier.verify();
            const reciprocateQRCodeCallbacks = await reciprocatePromise;

            // getReciprocateQrCodeCallbacks() is an alternative way to get the callbacks
            expect(verifier.getReciprocateQrCodeCallbacks()).toBe(reciprocateQRCodeCallbacks);
            expect(verifier.getShowSasCallbacks()).toBeNull();

            // Alice confirms she is happy, which makes her reply with a 'done'
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.done");
            reciprocateQRCodeCallbacks.confirm();
            await sendToDevicePromise;

            // at this point, on legacy crypto, the master key is already marked as trusted, and the request is "Done".
            // Rust crypto, on the other hand, waits for the 'done' to arrive from the other side.
            if (request.phase === VerificationPhase.Done) {
                // legacy crypto: we're all done
                const userVerificationStatus = await aliceClient.getCrypto()!.getUserVerificationStatus(TEST_USER_ID);
                // eslint-disable-next-line jest/no-conditional-expect
                expect(userVerificationStatus.isCrossSigningVerified()).toBeTruthy();
                await verificationPromise;
            } else {
                // rust crypto: still in flight
                // eslint-disable-next-line jest/no-conditional-expect
                expect(request.phase).toEqual(VerificationPhase.Started);
            }

            // the dummy device replies with its own 'done'
            returnToDeviceMessageFromSync(buildDoneMessage(transactionId));

            // ... and now we're really done.
            await verificationPromise;
            expect(request.phase).toEqual(VerificationPhase.Done);
            const userVerificationStatus = await aliceClient.getCrypto()!.getUserVerificationStatus(TEST_USER_ID);
            expect(userVerificationStatus.isCrossSigningVerified()).toBeTruthy();
        });

        it("can try to generate a QR code when QR code is not supported", async () => {
            aliceClient = await startTestClient();
            // we need cross-signing keys for a QR code verification
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, indicating it can only use SaS
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.sas.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);

            // Alice tries to generate a QR Code but it's unavailable
            const qrCodeBuffer = await request.generateQRCode();
            expect(qrCodeBuffer).toBeUndefined();
        });

        newBackendOnly("can verify another by scanning their QR code", async () => {
            aliceClient = await startTestClient();
            // we need cross-signing keys for a QR code verification
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, indicating it can show a QR code
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.qr_code.show.v1", "m.reciprocate.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.otherPartySupportsMethod("m.qr_code.show.v1")).toBe(true);

            // the dummy device shows a QR code
            const sharedSecret = "SUPERSEKRET";
            const qrCodeBuffer = buildQRCode(
                transactionId,
                TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
                MASTER_CROSS_SIGNING_PUBLIC_KEY_BASE64,
                sharedSecret,
            );

            // Alice scans the QR code
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.start");
            const verifier = await request.scanQRCode(qrCodeBuffer);

            const requestBody = await sendToDevicePromise;
            const toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage).toEqual({
                from_device: aliceClient.deviceId,
                method: "m.reciprocate.v1",
                transaction_id: transactionId,
                secret: encodeUnpaddedBase64(Buffer.from(sharedSecret)),
            });

            expect(request.phase).toEqual(VerificationPhase.Started);
            expect(request.chosenMethod).toEqual("m.reciprocate.v1");
            expect(verifier.getReciprocateQrCodeCallbacks()).toBeNull();

            const verificationPromise = verifier.verify();

            // the dummy device confirms that Alice scanned the QR code, by replying with a done
            returnToDeviceMessageFromSync(buildDoneMessage(transactionId));

            // Alice also replies with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // ... and the whole thing should be done!
            await verificationPromise;
            expect(request.phase).toEqual(VerificationPhase.Done);
        });

        it("can send an SAS start after QR code display", async () => {
            aliceClient = await startTestClient();
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, with an indication it can scan a QR code
            // or do the emoji dance
            returnToDeviceMessageFromSync(
                buildReadyMessage(transactionId, ["m.qr_code.scan.v1", "m.sas.v1", "m.reciprocate.v1"]),
            );
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);

            // Alice displays the QR code
            const qrCodeBuffer = (await request.generateQRCode())!;
            expect(qrCodeBuffer).toBeTruthy();
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.verifier).toBeUndefined();

            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            await jest.advanceTimersByTimeAsync(10);

            // ... but Alice wants to do an SAS verification
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.start");
            await request.startVerification("m.sas.v1");
            await sendToDevicePromise;

            // There should now be a `verifier`
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();
            expect(request.chosenMethod).toEqual("m.sas.v1");

            // clean up the test
            expectSendToDeviceMessage("m.key.verification.cancel");
            request.cancel();
            await expect(verifier.verify()).rejects.toBeTruthy();
        });

        it("can receive an SAS start after QR code display", async () => {
            aliceClient = await startTestClient();
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            await waitForDeviceList();

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, with an indication it can scan a QR code
            // or do the emoji dance
            returnToDeviceMessageFromSync(
                buildReadyMessage(transactionId, ["m.qr_code.scan.v1", "m.sas.v1", "m.reciprocate.v1"]),
            );
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);

            // Alice displays the QR code
            const qrCodeBuffer = (await request.generateQRCode())!;
            expect(qrCodeBuffer).toBeTruthy();
            expect(request.phase).toEqual(VerificationPhase.Ready);
            expect(request.verifier).toBeUndefined();

            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            await jest.advanceTimersByTimeAsync(10);

            // ... but the dummy device wants to do an SAS verification
            returnToDeviceMessageFromSync(buildSasStartMessage(transactionId));
            await emitPromise(request, VerificationRequestEvent.Change);

            // Alice should now have a `verifier`
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();
            expect(request.chosenMethod).toEqual("m.sas.v1");

            // clean up the test
            expectSendToDeviceMessage("m.key.verification.cancel");
            request.cancel();
            await expect(verifier.verify()).rejects.toBeTruthy();
        });
    });

    describe("cancellation", () => {
        beforeEach(async () => {
            // pretend that we have another device, which we will start verifying
            e2eKeyResponder.addDeviceKeys(SIGNED_TEST_DEVICE_DATA);
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);

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
            expect(request.cancellationCode).toEqual("m.user");
            expect(request.cancellingUserId).toEqual("@alice:localhost");
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

        it("can cancel in the ShowQrCodeCallbacks", async () => {
            // have alice initiate a verification. She should send a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, TEST_DEVICE_ID),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, with an indication it can scan the QR code
            returnToDeviceMessageFromSync(buildReadyMessage(transactionId, ["m.qr_code.scan.v1"]));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Ready);

            // we should now have QR data we can display
            const qrCodeBuffer = (await request.generateQRCode())!;
            expect(qrCodeBuffer).toBeTruthy();
            const sharedSecret = qrCodeBuffer.subarray(74 + transactionId.length);

            // the dummy device "scans" the displayed QR code and acknowledges it with a "m.key.verification.start"
            returnToDeviceMessageFromSync(buildReciprocateStartMessage(transactionId, sharedSecret));
            await waitForVerificationRequestChanged(request);
            expect(request.phase).toEqual(VerificationPhase.Started);
            expect(request.chosenMethod).toEqual("m.reciprocate.v1");

            // there should now be a verifier
            const verifier: Verifier = request.verifier!;
            expect(verifier).toBeDefined();

            // ... which we call .verify on, which emits a ShowReciprocateQr event
            const reciprocatePromise = emitPromise(verifier, VerifierEvent.ShowReciprocateQr);
            const verificationPromise = verifier.verify();
            const reciprocateQRCodeCallbacks: ShowQrCodeCallbacks = await reciprocatePromise;

            // Alice complains that she didn't see the dummy device scan her code
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.cancel");
            reciprocateQRCodeCallbacks.cancel();
            await sendToDevicePromise;

            // ... which should cancel the verifier
            await expect(verificationPromise).rejects.toBeTruthy();
            expect(request.phase).toEqual(VerificationPhase.Cancelled);
            expect(verifier.hasBeenCancelled).toBe(true);
        });
    });

    describe("Incoming verification from another device", () => {
        beforeEach(async () => {
            e2eKeyResponder.addDeviceKeys(SIGNED_TEST_DEVICE_DATA);

            aliceClient = await startTestClient();
            await waitForDeviceList();
        });

        it("Incoming verification: can accept", async () => {
            const TRANSACTION_ID = "abcd";

            // Initiate the request by sending a to-device message
            returnToDeviceMessageFromSync(buildRequestMessage(TRANSACTION_ID));
            const request: VerificationRequest = await emitPromise(
                aliceClient,
                CryptoEvent.VerificationRequestReceived,
            );
            expect(request.transactionId).toEqual(TRANSACTION_ID);
            expect(request.phase).toEqual(VerificationPhase.Requested);
            expect(request.roomId).toBeUndefined();
            expect(request.initiatedByMe).toBe(false);
            expect(request.otherUserId).toEqual(TEST_USER_ID);
            expect(request.chosenMethod).toBe(null); // nothing chosen yet
            expect(canAcceptVerificationRequest(request)).toBe(true);
            expect(request.pending).toBe(true);

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

        it("Incoming verification: can refuse", async () => {
            const TRANSACTION_ID = "abcd";

            // Initiate the request by sending a to-device message
            returnToDeviceMessageFromSync(buildRequestMessage(TRANSACTION_ID));
            const request: VerificationRequest = await emitPromise(
                aliceClient,
                CryptoEvent.VerificationRequestReceived,
            );
            expect(request.transactionId).toEqual(TRANSACTION_ID);

            // Alice declines, by sending a cancellation
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.cancel");
            const cancelPromise = request.cancel();
            expect(canAcceptVerificationRequest(request)).toBe(false);
            expect(request.accepting).toBe(false);
            expect(request.declining).toBe(true);
            await cancelPromise;
            const requestBody = await sendToDevicePromise;
            expect(request.phase).toEqual(VerificationPhase.Cancelled);

            const toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
            expect(toDeviceMessage.transaction_id).toEqual(TRANSACTION_ID);
        });
    });

    describe("Send verification request in DM", () => {
        beforeEach(async () => {
            aliceClient = await startTestClient();
            aliceClient.setGlobalErrorOnUnknownDevices(false);

            e2eKeyResponder.addCrossSigningData(BOB_SIGNED_CROSS_SIGNING_KEYS_DATA);
            e2eKeyResponder.addDeviceKeys(BOB_SIGNED_TEST_DEVICE_DATA);
            syncResponder.sendOrQueueSyncResponse(getSyncResponse([BOB_TEST_USER_ID]));

            // Wait for the sync response to be processed
            await syncPromise(aliceClient);
        });

        /**
         * Create a mock to respond when the verification request is sent
         * Handle both encrypted and unencrypted requests
         */
        function awaitRoomMessageRequest(): Promise<IContent> {
            return new Promise((resolve) => {
                // Case of unencrypted message of the new crypto
                fetchMock.put(
                    "express:/_matrix/client/v3/rooms/:roomId/send/m.room.message/:txId",
                    (url: string, options: RequestInit) => {
                        resolve(JSON.parse(options.body as string));
                        return { event_id: "$YUwRidLecu:example.com" };
                    },
                );

                // Case of encrypted message of the old crypto
                fetchMock.put(
                    "express:/_matrix/client/v3/rooms/:roomId/send/m.room.encrypted/:txId",
                    async (url: string, options: RequestInit) => {
                        const encryptedMessage = JSON.parse(options.body as string);
                        const event = new MatrixEvent({
                            content: encryptedMessage,
                            type: "m.room.encrypted",
                            room_id: TEST_ROOM_ID,
                        });
                        // Try to decrypt the event
                        event.once(MatrixEventEvent.Decrypted, (decryptedEvent: MatrixEvent, error?: Error) => {
                            expect(error).not.toBeDefined();
                            resolve(decryptedEvent.getContent());
                        });
                        await aliceClient.decryptEventIfNeeded(event);
                        return { event_id: "$YUwRidLecu:example.com" };
                    },
                );
            });
        }

        it("alice sends a verification request in a DM to bob", async () => {
            fetchMock.post("express:/_matrix/client/v3/keys/claim", () => ({ one_time_keys: BOB_ONE_TIME_KEYS }));

            // In `DeviceList#doQueuedQueries`, the key download response is processed every 5ms
            // 5ms by users, ie Bob and Alice
            await jest.advanceTimersByTimeAsync(10);

            const messageRequestPromise = awaitRoomMessageRequest();
            const verificationRequest = await aliceClient
                .getCrypto()!
                .requestVerificationDM(BOB_TEST_USER_ID, TEST_ROOM_ID);
            const requestContent = await messageRequestPromise;

            expect(requestContent.from_device).toBe(aliceClient.getDeviceId());
            expect(requestContent.methods.sort()).toStrictEqual(
                ["m.sas.v1", "m.qr_code.scan.v1", "m.qr_code.show.v1", "m.reciprocate.v1"].sort(),
            );
            expect(requestContent.msgtype).toBe("m.key.verification.request");
            expect(requestContent.to).toBe(BOB_TEST_USER_ID);

            expect(verificationRequest.roomId).toBe(TEST_ROOM_ID);
            expect(verificationRequest.isSelfVerification).toBe(false);
            expect(verificationRequest.otherUserId).toBe(BOB_TEST_USER_ID);
        });
    });

    describe("Incoming verification in a DM", () => {
        let testOlmAccount: Olm.Account;

        beforeEach(async () => {
            // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
            await Olm.init();
            testOlmAccount = new Olm.Account();
            testOlmAccount.create();

            aliceClient = await startTestClient();
            aliceClient.setGlobalErrorOnUnknownDevices(false);
            syncResponder.sendOrQueueSyncResponse(getSyncResponse([BOB_TEST_USER_ID]));
            await syncPromise(aliceClient);
        });

        /**
         * Return a plaintext verification request event from Bob to Alice
         * @see https://spec.matrix.org/v1.7/client-server-api/#mkeyverificationrequest
         */
        function createVerificationRequestEvent(): IEvent {
            return {
                content: {
                    body: "Verification request from Bob to Alice",
                    from_device: "BobDevice",
                    methods: ["m.sas.v1"],
                    msgtype: "m.key.verification.request",
                    to: aliceClient.getUserId()!,
                },
                event_id: "$143273582443PhrSn:example.org",
                origin_server_ts: Date.now(),
                room_id: TEST_ROOM_ID,
                sender: "@bob:xyz",
                type: "m.room.message",
                unsigned: {
                    age: 1234,
                },
            };
        }

        /**
         * Create a to-device event from Bob to Alice, sharing the group session key
         * @param groupSession - group session key to share
         * @param p2pSession - test Olm session to encrypt the key with
         */
        function encryptGroupSessionKeyForAlice(
            groupSession: Olm.OutboundGroupSession,
            p2pSession: Olm.Session,
        ): ToDeviceEvent {
            return encryptGroupSessionKey({
                recipient: aliceClient.getUserId()!,
                recipientCurve25519Key: e2eKeyReceiver.getDeviceKey(),
                recipientEd25519Key: e2eKeyReceiver.getSigningKey(),
                olmAccount: testOlmAccount,
                p2pSession: p2pSession,
                groupSession: groupSession,
                room_id: TEST_ROOM_ID,
            });
        }

        /**
         * Create and encrypt a verification request event
         * @param groupSession
         */
        function createEncryptedVerificationRequest(groupSession: Olm.OutboundGroupSession): IEvent {
            const testOlmAccountKeys = JSON.parse(testOlmAccount.identity_keys());
            return encryptMegolmEvent({
                senderKey: testOlmAccountKeys.curve25519,
                groupSession: groupSession,
                room_id: TEST_ROOM_ID,
                plaintext: createVerificationRequestEvent(),
            });
        }

        it("Verification request not found", async () => {
            // Expect to not find any verification request
            const request = aliceClient.getCrypto()!.findVerificationRequestDMInProgress(TEST_ROOM_ID, "@bob:xyz");
            expect(request).toBeUndefined();
        });

        it("ignores old verification requests", async () => {
            const eventHandler = jest.fn();
            aliceClient.on(CryptoEvent.VerificationRequestReceived, eventHandler);

            const verificationRequestEvent = createVerificationRequestEvent();
            verificationRequestEvent.origin_server_ts -= 1000000;
            returnRoomMessageFromSync(TEST_ROOM_ID, verificationRequestEvent);

            await syncPromise(aliceClient);

            // make sure the event has arrived
            const room = aliceClient.getRoom(TEST_ROOM_ID)!;
            const matrixEvent = room.getLiveTimeline().getEvents()[0];
            expect(matrixEvent.getId()).toEqual(verificationRequestEvent.event_id);

            // check that an event has not been raised, and that the request is not found
            expect(eventHandler).not.toHaveBeenCalled();
            expect(
                aliceClient.getCrypto()!.findVerificationRequestDMInProgress(TEST_ROOM_ID, "@bob:xyz"),
            ).not.toBeDefined();
        });

        it("Plaintext verification request from Bob to Alice", async () => {
            // Add verification request from Bob to Alice in the DM between them
            returnRoomMessageFromSync(TEST_ROOM_ID, createVerificationRequestEvent());

            // Wait for the request to be received
            const request1 = await emitPromise(aliceClient, CryptoEvent.VerificationRequestReceived);
            expect(request1.roomId).toBe(TEST_ROOM_ID);
            expect(request1.isSelfVerification).toBe(false);
            expect(request1.otherUserId).toBe("@bob:xyz");

            const request = aliceClient.getCrypto()!.findVerificationRequestDMInProgress(TEST_ROOM_ID, "@bob:xyz");
            // Expect to find the verification request received during the sync
            expect(request?.roomId).toBe(TEST_ROOM_ID);
            expect(request?.isSelfVerification).toBe(false);
            expect(request?.otherUserId).toBe("@bob:xyz");
        });

        it("Encrypted verification request from Bob to Alice", async () => {
            const p2pSession = await createOlmSession(testOlmAccount, e2eKeyReceiver);
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            // make the room_key event, but don't send it yet
            const toDeviceEvent = encryptGroupSessionKeyForAlice(groupSession, p2pSession);

            // Add verification request from Bob to Alice in the DM between them
            returnRoomMessageFromSync(TEST_ROOM_ID, createEncryptedVerificationRequest(groupSession));

            // Wait for the sync response to be processed
            await syncPromise(aliceClient);

            const room = aliceClient.getRoom(TEST_ROOM_ID)!;
            const matrixEvent = room.getLiveTimeline().getEvents()[0];

            // wait for a first attempt at decryption: should fail
            await awaitDecryption(matrixEvent);
            expect(matrixEvent.getContent().msgtype).toEqual("m.bad.encrypted");

            const requestEventPromise = emitPromise(aliceClient, CryptoEvent.VerificationRequestReceived);

            // Send Bob the room keys
            returnToDeviceMessageFromSync(toDeviceEvent);

            // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
            await jest.advanceTimersByTimeAsync(10);

            // Wait for the request to be decrypted
            const request1 = await requestEventPromise;
            expect(request1.roomId).toBe(TEST_ROOM_ID);
            expect(request1.isSelfVerification).toBe(false);
            expect(request1.otherUserId).toBe("@bob:xyz");

            const request = aliceClient.getCrypto()!.findVerificationRequestDMInProgress(TEST_ROOM_ID, "@bob:xyz");
            // Expect to find the verification request received during the sync
            expect(request?.roomId).toBe(TEST_ROOM_ID);
            expect(request?.isSelfVerification).toBe(false);
            expect(request?.otherUserId).toBe("@bob:xyz");
        });

        newBackendOnly(
            "If the verification request is not decrypted within 5 minutes, the request is ignored",
            async () => {
                const p2pSession = await createOlmSession(testOlmAccount, e2eKeyReceiver);
                const groupSession = new Olm.OutboundGroupSession();
                groupSession.create();

                // make the room_key event, but don't send it yet
                const toDeviceEvent = encryptGroupSessionKeyForAlice(groupSession, p2pSession);

                // Add verification request from Bob to Alice in the DM between them
                returnRoomMessageFromSync(TEST_ROOM_ID, createEncryptedVerificationRequest(groupSession));

                // Wait for the sync response to be processed
                await syncPromise(aliceClient);

                const room = aliceClient.getRoom(TEST_ROOM_ID)!;
                const matrixEvent = room.getLiveTimeline().getEvents()[0];

                // wait for a first attempt at decryption: should fail
                await awaitDecryption(matrixEvent);
                expect(matrixEvent.getContent().msgtype).toEqual("m.bad.encrypted");

                // Advance time by 5mins, the verification request should be ignored after that
                jest.advanceTimersByTime(5 * 60 * 1000);

                // Send Bob the room keys
                returnToDeviceMessageFromSync(toDeviceEvent);

                // Wait for the message to be decrypted
                await awaitDecryption(matrixEvent, { waitOnDecryptionFailure: true });

                const request = aliceClient.getCrypto()!.findVerificationRequestDMInProgress(TEST_ROOM_ID, "@bob:xyz");
                // the request should not be present
                expect(request).not.toBeDefined();
            },
        );
    });

    describe("Secrets are gossiped after verification", () => {
        // We use a legacy olm session as the existing session.
        // This will give us access to low level olm functions in order to
        // simulate a backup key request with proper olm encryption.
        let testOlmAccount: Olm.Account;
        const olmDeviceId = "OLM_DEVICE";
        let usermasterPubKey: string;

        const matchingBackupInfo: KeyBackupInfo = {
            algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
            version: "1",
            auth_data: {
                public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
            },
        };

        const nonMatchingBackupInfo: KeyBackupInfo = {
            algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
            version: "1",
            auth_data: {
                public_key: "EjDwCYkwp1R0i33ctD73Wg2/Og0mOBr066Spjqqaqqo",
            },
        };

        const unknownAlgorithmBackupInfo: KeyBackupInfo = {
            algorithm: "m.megolm_backup.foo_bar",
            version: "1",
            auth_data: {
                public_key: "EjDwCYkwp1R0i33ctD73Wg2/Og0mOBr066Spjqqaqqo",
            },
        };

        beforeEach(async () => {
            // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
            await Olm.init();
            testOlmAccount = new Olm.Account();
            testOlmAccount.create();

            const bootstrapped = bootstrapCrossSigningTestOlmAccount(testOlmAccount, TEST_USER_ID, olmDeviceId, [
                matchingBackupInfo,
                nonMatchingBackupInfo,
            ]);

            e2eKeyResponder.addDeviceKeys(bootstrapped.device_keys![TEST_USER_ID]![olmDeviceId]);
            e2eKeyResponder.addCrossSigningData(bootstrapped);

            usermasterPubKey = Object.values(bootstrapped.master_keys![TEST_USER_ID].keys)[0];

            aliceClient = await startTestClient();
            syncResponder.sendOrQueueSyncResponse(getSyncResponse([TEST_USER_ID]));
            await syncPromise(aliceClient);
            // DeviceList has a sleep(5) which we need to make happen
            await jest.advanceTimersByTimeAsync(10);

            // The client should now know about the olm device
            const devices = await aliceClient.getCrypto()!.getUserDeviceInfo([TEST_USER_ID]);
            expect(devices.get(TEST_USER_ID)!.keys()).toContain(olmDeviceId);
        });

        afterEach(async () => {
            aliceClient?.stopClient();
            testOlmAccount?.free();

            // Allow in-flight things to complete before we tear down the test
            await jest.runAllTimersAsync();

            fetchMock.mockReset();
        });

        newBackendOnly("Should request cross signing keys after verification", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            // The secret must have been requested
            await requestPromises.get("m.cross_signing.master");
            await requestPromises.get("m.cross_signing.user_signing");
            await requestPromises.get("m.cross_signing.self_signing");
        });

        newBackendOnly("Should accept the backup decryption key gossip if valid", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            const requestId = await requestPromises.get("m.megolm_backup.v1");

            const keyBackupIsCached = emitPromise(aliceClient, CryptoEvent.KeyBackupDecryptionKeyCached);

            await sendBackupGossipAndExpectVersion(requestId!, BACKUP_DECRYPTION_KEY_BASE64, matchingBackupInfo);

            await keyBackupIsCached;

            // the backup secret should be cached
            const cachedKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();
            expect(cachedKey).toBeTruthy();
            expect(encodeBase64(cachedKey!)).toEqual(BACKUP_DECRYPTION_KEY_BASE64);
        });

        newBackendOnly("Should not accept the backup decryption key gossip if private key do not match", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            const requestId = await requestPromises.get("m.megolm_backup.v1");

            await sendBackupGossipAndExpectVersion(requestId!, BACKUP_DECRYPTION_KEY_BASE64, nonMatchingBackupInfo);

            // We are lacking a way to signal that the secret has been received, so we wait a bit..
            jest.useRealTimers();
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            // the backup secret should not be cached
            const cachedKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();
            expect(cachedKey).toBeNull();
        });

        newBackendOnly("Should not accept the backup decryption key gossip if backup not trusted", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            const requestId = await requestPromises.get("m.megolm_backup.v1");

            const infoCopy = Object.assign({}, matchingBackupInfo);
            delete infoCopy.auth_data.signatures;

            await sendBackupGossipAndExpectVersion(requestId!, BACKUP_DECRYPTION_KEY_BASE64, infoCopy);

            // We are lacking a way to signal that the secret has been received, so we wait a bit..
            jest.useRealTimers();
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            // the backup secret should not be cached
            const cachedKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();
            expect(cachedKey).toBeNull();
        });

        newBackendOnly("Should not accept the backup decryption key gossip if backup algorithm unknown", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            const requestId = await requestPromises.get("m.megolm_backup.v1");

            await sendBackupGossipAndExpectVersion(
                requestId!,
                BACKUP_DECRYPTION_KEY_BASE64,
                unknownAlgorithmBackupInfo,
            );

            // We are lacking a way to signal that the secret has been received, so we wait a bit..
            jest.useRealTimers();
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            // the backup secret should not be cached
            const cachedKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();
            expect(cachedKey).toBeNull();
        });

        newBackendOnly("Should not accept an invalid backup decryption key", async () => {
            const requestPromises = mockSecretRequestAndGetPromises();

            await doInteractiveVerification();

            const requestId = await requestPromises.get("m.megolm_backup.v1");

            await sendBackupGossipAndExpectVersion(requestId!, "InvalidSecret", matchingBackupInfo);

            // We are lacking a way to signal that the secret has been received, so we wait a bit..
            jest.useRealTimers();
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            // the backup secret should not be cached
            const cachedKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();
            expect(cachedKey).toBeNull();
        });

        /**
         * Common test setup for gossiping secrets.
         * Creates a peer to peer session, sends the secret, mockup the version API, send the secret back from sync, then await for the backup check.
         */
        async function sendBackupGossipAndExpectVersion(
            requestId: string,
            secret: string,
            expectBackup: KeyBackupInfo,
        ) {
            const p2pSession = await createOlmSession(testOlmAccount, e2eKeyReceiver);

            const toDeviceEvent = encryptSecretSend({
                sender: aliceClient.getUserId()!,
                recipient: aliceClient.getUserId()!,
                recipientCurve25519Key: e2eKeyReceiver.getDeviceKey(),
                recipientEd25519Key: e2eKeyReceiver.getSigningKey(),
                p2pSession: p2pSession,
                olmAccount: testOlmAccount,
                requestId: requestId!,
                secret: secret,
            });

            const expectBackupCheck = new Promise((resolve) => {
                fetchMock.get(
                    "express:/_matrix/client/v3/room_keys/version",
                    (url, request) => {
                        resolve(undefined);
                        return expectBackup;
                    },
                    {
                        overwriteRoutes: true,
                    },
                );
            });

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", CURVE25519_KEY_BACKUP_DATA);

            // The dummy device sends the secret
            returnToDeviceMessageFromSync(toDeviceEvent);

            await expectBackupCheck;
        }

        /**
         * Do an interactive verification between alice and the dummy device.
         */
        async function doInteractiveVerification(): Promise<void> {
            // Do a QR code verification for simplicity

            // Alice sends a m.key.verification.request
            const [, request] = await Promise.all([
                expectSendToDeviceMessage("m.key.verification.request"),
                aliceClient.getCrypto()!.requestDeviceVerification(TEST_USER_ID, olmDeviceId),
            ]);
            const transactionId = request.transactionId!;

            // The dummy device replies with an m.key.verification.ready, indicating it can show a QR code
            returnToDeviceMessageFromSync(
                buildReadyMessage(transactionId, ["m.qr_code.show.v1", "m.reciprocate.v1"], olmDeviceId),
            );
            await waitForVerificationRequestChanged(request);

            const currentDeviceKey = e2eKeyReceiver.getSigningKey();
            // the dummy device shows a QR code
            const sharedSecret = "SUPERSEKRET";
            // use mode 0x01, self-verifying in which the current device does trust the master key
            const mode = 0x01;
            const qrCodeBuffer = buildQRCode(transactionId, usermasterPubKey, currentDeviceKey, sharedSecret, mode);

            // Alice scans the QR code
            const sendToDevicePromise = expectSendToDeviceMessage("m.key.verification.start");
            const verifier = await request.scanQRCode(qrCodeBuffer);

            await sendToDevicePromise;

            const verificationPromise = verifier.verify();
            // the dummy device confirms that Alice scanned the QR code, by replying with a done
            returnToDeviceMessageFromSync(buildDoneMessage(transactionId));

            // Alice also replies with a 'done'
            await expectSendToDeviceMessage("m.key.verification.done");

            // ... and the whole thing should be done!
            await verificationPromise;

            // The other device should now be verified.
            const otherDevice = (await aliceClient.getCrypto()!.getUserDeviceInfo([TEST_USER_ID]))
                .get(TEST_USER_ID)!
                .get(olmDeviceId);
            expect(otherDevice?.verified).toEqual(DeviceVerification.Verified);
        }
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

    function returnRoomMessageFromSync(roomId: string, ev: IEvent): void {
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            rooms: {
                join: {
                    [roomId]: { timeline: { events: [ev] } },
                },
            },
        });
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
            (url: string, opts: RequestInit): FetchMock.MockResponse => {
                resolve(JSON.parse(opts.body as string));
                return {};
            },
        );
    });
}

/**
 * Utility to add all needed mocks for secret requesting (to-device of type `m.secret.request`).
 *
 * The following secrets are mocked: `m.cross_signing.master`, `m.cross_signing.self_signing`,
 * `m.cross_signing.user_signing`, `m.megolm_backup.v1`.
 *
 *  @returns a map of secret name to promise that will resolve (with the id of the secret request) when the secret is requested.
 */
function mockSecretRequestAndGetPromises(): Map<string, Promise<string>> {
    const mskRequestDefer = defer<string>();
    const sskRequestDefer = defer<string>();
    const uskRequestDefer = defer<string>();
    const backupKeyRequestDefer = defer<string>();

    fetchMock.put(
        new RegExp(`/_matrix/client/(r0|v3)/sendToDevice/m.secret.request`),
        (url: string, opts: RequestInit): FetchMock.MockResponse => {
            const messages = JSON.parse(opts.body as string).messages[TEST_USER_ID];
            // rust crypto broadcasts to all devices, old crypto to a specific device, take the first one
            const content = Object.values(messages)[0] as any;
            if (content.action == "request") {
                const name = content.name;
                const requestId = content.request_id;
                if (name == "m.cross_signing.user_signing") {
                    uskRequestDefer.resolve(requestId);
                } else if (name == "m.cross_signing.master") {
                    mskRequestDefer.resolve(requestId);
                } else if (name == "m.cross_signing.self_signing") {
                    sskRequestDefer.resolve(requestId);
                } else if (name == "m.megolm_backup.v1") {
                    backupKeyRequestDefer.resolve(requestId);
                }
            }
            return {};
        },
        { overwriteRoutes: true },
    );

    const promiseMap = new Map<string, Promise<string>>();
    promiseMap.set("m.cross_signing.master", mskRequestDefer.promise);
    promiseMap.set("m.cross_signing.self_signing", sskRequestDefer.promise);
    promiseMap.set("m.cross_signing.user_signing", uskRequestDefer.promise);
    promiseMap.set("m.megolm_backup.v1", backupKeyRequestDefer.promise);
    return promiseMap;
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

/** Calculate the sha256 hash of a string, encoding as unpadded base64 */
function sha256(commitmentStr: string): string {
    return encodeUnpaddedBase64(createHash("sha256").update(commitmentStr, "utf8").digest());
}

function encodeUnpaddedBase64(uint8Array: ArrayBuffer | Uint8Array): string {
    return Buffer.from(uint8Array).toString("base64").replace(/=+$/g, "");
}

/** build an m.key.verification.request to-device message originating from the dummy device */
function buildRequestMessage(transactionId: string): { type: string; content: object } {
    return {
        type: "m.key.verification.request",
        content: {
            from_device: TEST_DEVICE_ID,
            methods: ["m.sas.v1"],
            transaction_id: transactionId,
            timestamp: Date.now() - 1000,
        },
    };
}

/** build an m.key.verification.ready to-device message originating from the given `fromDevice` (default to `TEST_DEVICE_ID` if not provided) */
function buildReadyMessage(
    transactionId: string,
    methods: string[],
    fromDevice?: string,
): { type: string; content: object } {
    return {
        type: "m.key.verification.ready",
        content: {
            from_device: fromDevice || TEST_DEVICE_ID,
            methods: methods,
            transaction_id: transactionId,
        },
    };
}

/** build an m.key.verification.start to-device message suitable for the m.reciprocate.v1 flow, originating from the dummy device */
function buildReciprocateStartMessage(transactionId: string, sharedSecret: Uint8Array) {
    return {
        type: "m.key.verification.start",
        content: {
            from_device: TEST_DEVICE_ID,
            method: "m.reciprocate.v1",
            transaction_id: transactionId,
            secret: encodeUnpaddedBase64(sharedSecret),
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

/** build an m.key.verification.accept to-device message suitable for the SAS flow */
function buildSasAcceptMessage(transactionId: string, commitmentStr: string) {
    return {
        type: "m.key.verification.accept",
        content: {
            transaction_id: transactionId,
            commitment: sha256(commitmentStr),
            hash: "sha256",
            key_agreement_protocol: "curve25519-hkdf-sha256",
            short_authentication_string: ["decimal", "emoji"],
            message_authentication_code: "hkdf-hmac-sha256.v2",
        },
    };
}

/** build an m.key.verification.key to-device message suitable for the SAS flow */
function buildSasKeyMessage(transactionId: string, key: string): { type: string; content: object } {
    return {
        type: "m.key.verification.key",
        content: {
            transaction_id: transactionId,
            key: key,
        },
    };
}

/** build an m.key.verification.mac to-device message suitable for the SAS flow, originating from the dummy device */
function buildSasMacMessage(
    transactionId: string,
    olmSAS: Olm.SAS,
    recipientUserId: string,
    recipientDeviceId: string,
): { type: string; content: object } {
    const macInfoBase = `MATRIX_KEY_VERIFICATION_MAC${TEST_USER_ID}${TEST_DEVICE_ID}${recipientUserId}${recipientDeviceId}${transactionId}`;

    return {
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
    };
}

/** build an m.key.verification.done to-device message */
function buildDoneMessage(transactionId: string) {
    return {
        type: "m.key.verification.done",
        content: {
            transaction_id: transactionId,
        },
    };
}

function buildQRCode(
    transactionId: string,
    key1Base64: string,
    key2Base64: string,
    sharedSecret: string,
    mode = 0x02,
): Uint8Array {
    // https://spec.matrix.org/v1.7/client-server-api/#qr-code-format

    const qrCodeBuffer = Buffer.alloc(150); // oversize
    let idx = 0;
    idx += qrCodeBuffer.write("MATRIX", idx, "ascii");
    idx = qrCodeBuffer.writeUInt8(0x02, idx); // version
    idx = qrCodeBuffer.writeUInt8(mode, idx); // mode
    idx = qrCodeBuffer.writeInt16BE(transactionId.length, idx);
    idx += qrCodeBuffer.write(transactionId, idx, "ascii");

    idx += Buffer.from(key1Base64, "base64").copy(qrCodeBuffer, idx);
    idx += Buffer.from(key2Base64, "base64").copy(qrCodeBuffer, idx);
    idx += qrCodeBuffer.write(sharedSecret, idx);

    // truncate to the right length
    return qrCodeBuffer.subarray(0, idx);
}
