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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { Mocked } from "jest-mock";

import {
    isVerificationEvent,
    RustVerificationRequest,
    verificationMethodIdentifierToMethod,
} from "../../../src/rust-crypto/verification";
import {
    ShowSasCallbacks,
    VerificationRequestEvent,
    Verifier,
    VerifierEvent,
} from "../../../src/crypto-api/verification";
import { OutgoingRequest, OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { IDeviceKeys } from "../../../src/@types/crypto";
import { EventType, MatrixEvent, MsgType } from "../../../src";

describe("VerificationRequest", () => {
    describe("pending", () => {
        let request: RustVerificationRequest;
        let mockedInner: Mocked<RustSdkCryptoJs.VerificationRequest>;

        beforeEach(() => {
            mockedInner = makeMockedInner();
            request = makeTestRequest(mockedInner);
        });

        it("returns true for a created request", () => {
            expect(request.pending).toBe(true);
        });

        it("returns false for passive requests", () => {
            mockedInner.isPassive.mockReturnValue(true);
            expect(request.pending).toBe(false);
        });

        it("returns false for completed requests", () => {
            mockedInner.phase.mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Done);
            expect(request.pending).toBe(false);
        });

        it("returns false for cancelled requests", () => {
            mockedInner.phase.mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Cancelled);
            expect(request.pending).toBe(false);
        });
    });

    describe("timeout", () => {
        it("passes through the result", () => {
            const mockedInner = makeMockedInner();
            const request = makeTestRequest(mockedInner);
            mockedInner.timeRemainingMillis.mockReturnValue(10_000);
            expect(request.timeout).toEqual(10_000);
        });
    });

    describe("startVerification", () => {
        let request: RustVerificationRequest;
        let machine: Mocked<RustSdkCryptoJs.OlmMachine>;
        let inner: Mocked<RustSdkCryptoJs.VerificationRequest>;

        beforeEach(() => {
            inner = makeMockedInner();
            machine = { getDevice: jest.fn() } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;
            request = makeTestRequest(inner, machine);
        });

        it("does not permit methods other than SAS", async () => {
            await expect(request.startVerification("m.reciprocate.v1")).rejects.toThrow(
                "Unsupported verification method",
            );
        });

        it("raises an error if the other device is unknown", async () => {
            await expect(request.startVerification("m.sas.v1")).rejects.toThrow(
                "startVerification(): other device is unknown",
            );
        });

        it("raises an error if starting verification does not produce a verifier", async () => {
            jest.spyOn(inner, "otherDeviceId", "get").mockReturnValue(new RustSdkCryptoJs.DeviceId("other_device"));
            machine.getDevice.mockResolvedValue({} as RustSdkCryptoJs.Device);
            await expect(request.startVerification("m.sas.v1")).rejects.toThrow(
                "Still no verifier after startSas() call",
            );
        });
    });

    it("can verify with SAS", async () => {
        const aliceUserId = "@alice:example.org";
        const aliceDeviceId = "ABCDEFG";
        const bobUserId = "@bob:example.org";
        const bobDeviceId = "HIJKLMN";
        const [aliceOlmMachine, aliceDeviceKeys, aliceCrossSigningKeys] = await initOlmMachineAndKeys(
            aliceUserId,
            aliceDeviceId,
        );
        const [bobOlmMachine, bobDeviceKeys, bobCrossSigningKeys] = await initOlmMachineAndKeys(bobUserId, bobDeviceId);

        const aliceRequestLoop = makeRequestLoop(
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
        );
        const bobRequestLoop = makeRequestLoop(
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
        );

        try {
            await aliceOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(bobUserId)]);
            await bobOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(aliceUserId)]);

            // Alice requests verification
            const bobUserIdentity = await aliceOlmMachine.getIdentity(new RustSdkCryptoJs.UserId(bobUserId));

            const roomId = new RustSdkCryptoJs.RoomId("!roomId:example.org");
            const methods = [verificationMethodIdentifierToMethod("m.sas.v1")];
            const innerVerificationRequest = await bobUserIdentity.requestVerification(
                roomId,
                new RustSdkCryptoJs.EventId("$m.key.verification.request"),
                methods,
            );
            const aliceVerificationRequest = new RustVerificationRequest(
                aliceOlmMachine,
                innerVerificationRequest,
                aliceRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.sas.v1"],
            );

            const verificationRequestContent = JSON.parse(await bobUserIdentity.verificationRequestContent(methods));
            await bobOlmMachine.receiveVerificationEvent(
                JSON.stringify({
                    type: "m.room.message",
                    sender: aliceUserId,
                    event_id: "$m.key.verification.request",
                    content: verificationRequestContent,
                    origin_server_ts: Date.now(),
                    unsigned: {
                        age: 0,
                    },
                }),
                roomId,
            );

            // Bob accepts
            const bobInnerVerificationRequest = bobOlmMachine.getVerificationRequest(
                new RustSdkCryptoJs.UserId(aliceUserId),
                "$m.key.verification.request",
            )!;
            const bobVerificationRequest = new RustVerificationRequest(
                bobOlmMachine,
                bobInnerVerificationRequest,
                bobRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.sas.v1"],
            );

            await bobVerificationRequest.accept();

            // Alice starts the verification
            const bobVerifierPromise: Promise<Verifier> = new Promise((resolve, reject) => {
                bobVerificationRequest.on(VerificationRequestEvent.Change, () => {
                    const verifier = bobVerificationRequest.verifier;
                    if (verifier) {
                        resolve(verifier);
                    }
                });
            });
            const aliceVerifier = await aliceVerificationRequest.startVerification("m.sas.v1");
            const bobVerifier = await bobVerifierPromise;

            // create a function to compare the SAS, and then let the verification run
            let otherCallbacks: ShowSasCallbacks | undefined;
            const compareSas = (callbacks: ShowSasCallbacks): void => {
                if (otherCallbacks) {
                    const ourDecimal = callbacks.sas.decimal!;
                    const theirDecimal = otherCallbacks.sas.decimal!;
                    if (ourDecimal.every((el, idx) => el == theirDecimal[idx])) {
                        otherCallbacks.confirm();
                        callbacks.confirm();
                    } else {
                        otherCallbacks.mismatch();
                        callbacks.mismatch();
                    }
                } else {
                    otherCallbacks = callbacks;
                }
            };
            aliceVerifier.on(VerifierEvent.ShowSas, compareSas);
            bobVerifier.on(VerifierEvent.ShowSas, compareSas);

            await Promise.all([aliceVerifier.verify(), await bobVerifier.verify()]);
        } finally {
            await aliceRequestLoop.stop();
            await bobRequestLoop.stop();
        }
    });

    it("can handle simultaneous starts in SAS", async () => {
        const aliceUserId = "@alice:example.org";
        const aliceDeviceId = "ABCDEFG";
        const bobUserId = "@bob:example.org";
        const bobDeviceId = "HIJKLMN";
        const [aliceOlmMachine, aliceDeviceKeys, aliceCrossSigningKeys] = await initOlmMachineAndKeys(
            aliceUserId,
            aliceDeviceId,
        );
        const [bobOlmMachine, bobDeviceKeys, bobCrossSigningKeys] = await initOlmMachineAndKeys(bobUserId, bobDeviceId);

        let aliceStartRequest: RustSdkCryptoJs.RoomMessageRequest | undefined;
        const aliceRequestLoop = makeRequestLoop(
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
            async (request): Promise<any> => {
                // If the request is sending the m.key.verification.start
                // event, we delay sending it until after Bob has also started
                // a verification
                if (
                    !aliceStartRequest &&
                    request instanceof RustSdkCryptoJs.RoomMessageRequest &&
                    request.event_type == "m.key.verification.start"
                ) {
                    aliceStartRequest = request;
                    return { event_id: "$m.key.verification.start" };
                }
            },
        );
        const bobRequestLoop = makeRequestLoop(
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
        );

        try {
            await aliceOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(bobUserId)]);
            await bobOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(aliceUserId)]);

            // Alice requests verification
            const bobUserIdentity = await aliceOlmMachine.getIdentity(new RustSdkCryptoJs.UserId(bobUserId));

            const roomId = new RustSdkCryptoJs.RoomId("!roomId:example.org");
            const methods = [verificationMethodIdentifierToMethod("m.sas.v1")];
            const innerVerificationRequest = await bobUserIdentity.requestVerification(
                roomId,
                new RustSdkCryptoJs.EventId("$m.key.verification.request"),
                methods,
            );
            const aliceVerificationRequest = new RustVerificationRequest(
                aliceOlmMachine,
                innerVerificationRequest,
                aliceRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.sas.v1"],
            );

            const verificationRequestContent = JSON.parse(await bobUserIdentity.verificationRequestContent(methods));
            await bobOlmMachine.receiveVerificationEvent(
                JSON.stringify({
                    type: "m.room.message",
                    sender: aliceUserId,
                    event_id: "$m.key.verification.request",
                    content: verificationRequestContent,
                    origin_server_ts: Date.now(),
                    unsigned: {
                        age: 0,
                    },
                }),
                roomId,
            );

            // Bob accepts
            const bobInnerVerificationRequest = bobOlmMachine.getVerificationRequest(
                new RustSdkCryptoJs.UserId(aliceUserId),
                "$m.key.verification.request",
            )!;
            const bobVerificationRequest = new RustVerificationRequest(
                bobOlmMachine,
                bobInnerVerificationRequest,
                bobRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.sas.v1"],
            );

            await bobVerificationRequest.accept();

            // Alice and Bob both start the verification
            const aliceVerifier = await aliceVerificationRequest.startVerification("m.sas.v1");
            const bobVerifier = await bobVerificationRequest.startVerification("m.sas.v1");
            // We can now send Alice's start message to Bob
            await aliceRequestLoop.makeOutgoingRequest(aliceStartRequest!);

            // create a function to compare the SAS, and then let the verification run
            let otherCallbacks: ShowSasCallbacks | undefined;
            const compareSas = (callbacks: ShowSasCallbacks) => {
                if (otherCallbacks) {
                    const ourDecimal = callbacks.sas.decimal!;
                    const theirDecimal = otherCallbacks.sas.decimal!;
                    if (ourDecimal.every((el, idx) => el == theirDecimal[idx])) {
                        otherCallbacks.confirm();
                        callbacks.confirm();
                    } else {
                        otherCallbacks.mismatch();
                        callbacks.mismatch();
                    }
                } else {
                    otherCallbacks = callbacks;
                }
            };
            aliceVerifier.on(VerifierEvent.ShowSas, compareSas);
            bobVerifier.on(VerifierEvent.ShowSas, compareSas);

            await Promise.all([aliceVerifier.verify(), await bobVerifier.verify()]);
        } finally {
            await aliceRequestLoop.stop();
            await bobRequestLoop.stop();
        }
    });

    it("can verify by QR code", async () => {
        const aliceUserId = "@alice:example.org";
        const aliceDeviceId = "ABCDEFG";
        const bobUserId = "@bob:example.org";
        const bobDeviceId = "HIJKLMN";
        const [aliceOlmMachine, aliceDeviceKeys, aliceCrossSigningKeys] = await initOlmMachineAndKeys(
            aliceUserId,
            aliceDeviceId,
        );
        const [bobOlmMachine, bobDeviceKeys, bobCrossSigningKeys] = await initOlmMachineAndKeys(bobUserId, bobDeviceId);

        const aliceRequestLoop = makeRequestLoop(
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
        );
        const bobRequestLoop = makeRequestLoop(
            bobOlmMachine,
            bobDeviceKeys,
            bobCrossSigningKeys,
            aliceOlmMachine,
            aliceDeviceKeys,
            aliceCrossSigningKeys,
        );

        try {
            await aliceOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(bobUserId)]);
            await bobOlmMachine.updateTrackedUsers([new RustSdkCryptoJs.UserId(aliceUserId)]);

            // Alice requests verification
            const bobUserIdentity = await aliceOlmMachine.getIdentity(new RustSdkCryptoJs.UserId(bobUserId));

            const roomId = new RustSdkCryptoJs.RoomId("!roomId:example.org");
            const methods = [
                verificationMethodIdentifierToMethod("m.reciprocate.v1"),
                verificationMethodIdentifierToMethod("m.qr_code.show.v1"),
            ];
            const innerVerificationRequest = await bobUserIdentity.requestVerification(
                roomId,
                new RustSdkCryptoJs.EventId("$m.key.verification.request"),
                methods,
            );
            const aliceVerificationRequest = new RustVerificationRequest(
                aliceOlmMachine,
                innerVerificationRequest,
                aliceRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.reciprocate.v1", "m.qr_code.show.v1"],
            );

            const verificationRequestContent = JSON.parse(await bobUserIdentity.verificationRequestContent(methods));
            await bobOlmMachine.receiveVerificationEvent(
                JSON.stringify({
                    type: "m.room.message",
                    sender: aliceUserId,
                    event_id: "$m.key.verification.request",
                    content: verificationRequestContent,
                    origin_server_ts: Date.now(),
                    unsigned: {
                        age: 0,
                    },
                }),
                roomId,
            );

            // Bob accepts
            const bobInnerVerificationRequest = bobOlmMachine.getVerificationRequest(
                new RustSdkCryptoJs.UserId(aliceUserId),
                "$m.key.verification.request",
            )!;
            const bobVerificationRequest = new RustVerificationRequest(
                bobOlmMachine,
                bobInnerVerificationRequest,
                bobRequestLoop as unknown as OutgoingRequestProcessor,
                ["m.reciprocate.v1", "m.qr_code.show.v1", "m.qr_code.scan.v1"],
            );

            await bobVerificationRequest.accept();

            // Bob scans
            const qrCode = await aliceVerificationRequest.generateQRCode();

            const aliceVerifierPromise: Promise<Verifier> = new Promise((resolve, reject) => {
                aliceVerificationRequest.on(VerificationRequestEvent.Change, () => {
                    const verifier = aliceVerificationRequest.verifier;
                    if (verifier) {
                        resolve(verifier);
                    }
                });
            });
            const bobVerifier = await bobVerificationRequest.scanQRCode(qrCode!);

            const aliceVerifier = await aliceVerifierPromise;
            aliceVerifier.on(VerifierEvent.ShowReciprocateQr, (showQrCodeCallbacks) => {
                showQrCodeCallbacks.confirm();
            });

            await Promise.all([aliceVerifier.verify(), await bobVerifier.verify()]);
        } finally {
            await aliceRequestLoop.stop();
            await bobRequestLoop.stop();
        }
    });
});

describe("isVerificationEvent", () => {
    it.each([
        [EventType.KeyVerificationCancel],
        [EventType.KeyVerificationDone],
        [EventType.KeyVerificationMac],
        [EventType.KeyVerificationStart],
        [EventType.KeyVerificationKey],
        [EventType.KeyVerificationReady],
        [EventType.KeyVerificationAccept],
    ])("should return true with %s event", (eventType) => {
        const event = new MatrixEvent({
            type: eventType,
        });
        expect(isVerificationEvent(event)).toBe(true);
    });

    it("should return true with EventType.RoomMessage and MsgType.KeyVerificationRequest", () => {
        const event = new MatrixEvent({
            type: EventType.RoomMessage,
            content: {
                msgtype: MsgType.KeyVerificationRequest,
            },
        });
        expect(isVerificationEvent(event)).toBe(true);
    });

    it("should return false with a non verification event", () => {
        const event = new MatrixEvent({
            type: EventType.RoomName,
        });
        expect(isVerificationEvent(event)).toBe(false);
    });
});

/** build a RustVerificationRequest with default parameters */
function makeTestRequest(
    inner?: RustSdkCryptoJs.VerificationRequest,
    olmMachine?: RustSdkCryptoJs.OlmMachine,
    outgoingRequestProcessor?: OutgoingRequestProcessor,
): RustVerificationRequest {
    inner ??= makeMockedInner();
    olmMachine ??= {} as RustSdkCryptoJs.OlmMachine;
    outgoingRequestProcessor ??= {} as OutgoingRequestProcessor;
    return new RustVerificationRequest(olmMachine, inner, outgoingRequestProcessor, []);
}

/** Mock up a rust-side VerificationRequest */
function makeMockedInner(): Mocked<RustSdkCryptoJs.VerificationRequest> {
    return {
        registerChangesCallback: jest.fn(),
        startSas: jest.fn(),
        phase: jest.fn().mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Created),
        isPassive: jest.fn().mockReturnValue(false),
        timeRemainingMillis: jest.fn(),
        get otherDeviceId() {
            return undefined;
        },
    } as unknown as Mocked<RustSdkCryptoJs.VerificationRequest>;
}

interface CrossSigningKeys {
    master_key: any;
    self_signing_key: any;
    user_signing_key: any;
}

/** create an Olm machine and device/cross-signing keys for a user */
async function initOlmMachineAndKeys(
    userId: string,
    deviceId: string,
): Promise<[RustSdkCryptoJs.OlmMachine, IDeviceKeys, CrossSigningKeys]> {
    const olmMachine = await RustSdkCryptoJs.OlmMachine.initialize(
        new RustSdkCryptoJs.UserId(userId),
        new RustSdkCryptoJs.DeviceId(deviceId),
        undefined,
        undefined,
    );
    const { uploadKeysRequest, uploadSignaturesRequest, uploadSigningKeysRequest } =
        await olmMachine.bootstrapCrossSigning(true);
    const deviceKeys = JSON.parse(uploadKeysRequest.body).device_keys;
    await olmMachine.markRequestAsSent(
        uploadKeysRequest.id,
        uploadKeysRequest.type,
        '{"one_time_key_counts":{"signed_curve25519":100}}',
    );
    const crossSigningSignatures = JSON.parse(uploadSignaturesRequest.body);
    for (const [keyId, signature] of Object.entries(crossSigningSignatures[userId][deviceId]["signatures"][userId])) {
        deviceKeys["signatures"][userId][keyId] = signature;
    }
    const crossSigningKeys = JSON.parse(uploadSigningKeysRequest.body);
    // note: the upload signatures request and upload signing keys requests
    // don't need to be marked as sent in the Olm machine

    return [olmMachine, deviceKeys, crossSigningKeys];
}

type CustomRequestHandler = (request: OutgoingRequest | RustSdkCryptoJs.UploadSigningKeysRequest) => Promise<any>;

/** Loop for handling outgoing requests from an Olm machine.
 *
 * Simulates a server with two users: "us" and "them".  Handles key query
 * requests, querying either our keys or the other user's keys.  Room messages
 * are sent as incoming verification events to the other user.  A custom
 * handler can be added to override default request processing (the handler
 * should return a response body to inhibit default processing).
 *
 * Can also be used as an OutgoingRequestProcessor. */
function makeRequestLoop(
    ourOlmMachine: RustSdkCryptoJs.OlmMachine,
    ourDeviceKeys: IDeviceKeys,
    ourCrossSigningKeys: CrossSigningKeys,
    theirOlmMachine: RustSdkCryptoJs.OlmMachine,
    theirDeviceKeys: IDeviceKeys,
    theirCrossSigningKeys: CrossSigningKeys,
    customHandler?: CustomRequestHandler,
) {
    let stopRequestLoop = false;
    const ourUserId = ourOlmMachine.userId.toString();
    const ourDeviceId = ourOlmMachine.deviceId.toString();
    const theirUserId = theirOlmMachine.userId.toString();
    const theirDeviceId = theirOlmMachine.deviceId.toString();

    function defaultHandler(request: OutgoingRequest | RustSdkCryptoJs.UploadSigningKeysRequest): any {
        if (request instanceof RustSdkCryptoJs.KeysQueryRequest) {
            const resp: Record<string, any> = {
                device_keys: {},
            };
            const body = JSON.parse(request.body);
            const query = body.device_keys;
            const masterKeys: Record<string, any> = {};
            const selfSigningKeys: Record<string, any> = {};
            if (ourUserId in query) {
                resp.device_keys[ourUserId] = { [ourDeviceId]: ourDeviceKeys };
                masterKeys[ourUserId] = ourCrossSigningKeys.master_key;
                selfSigningKeys[ourUserId] = ourCrossSigningKeys.self_signing_key;
                resp.user_signing_keys = {
                    [ourUserId]: ourCrossSigningKeys.user_signing_key,
                };
            }
            if (theirUserId in query) {
                resp.device_keys[theirUserId] = {
                    [theirDeviceId]: theirDeviceKeys,
                };
                masterKeys[theirUserId] = theirCrossSigningKeys.master_key;
                selfSigningKeys[theirUserId] = theirCrossSigningKeys.self_signing_key;
            }
            if (Object.keys(masterKeys).length) {
                resp.master_keys = masterKeys;
            }
            if (Object.keys(selfSigningKeys).length) {
                resp.self_signing_keys = selfSigningKeys;
            }
            return resp;
        } else if (request instanceof RustSdkCryptoJs.RoomMessageRequest) {
            theirOlmMachine.receiveVerificationEvent(
                JSON.stringify({
                    type: request.event_type,
                    sender: ourUserId,
                    event_id: "$" + request.event_type,
                    content: JSON.parse(request.body),
                    origin_server_ts: Date.now(),
                    unsigned: {
                        age: 0,
                    },
                }),
                new RustSdkCryptoJs.RoomId(request.room_id),
            );
            return { event_id: "$" + request.event_type };
        } else if (request instanceof RustSdkCryptoJs.SignatureUploadRequest) {
            // this only gets called at the end after the verification
            // succeeds, so we don't actually have to do anything.
            return { failures: {} };
        }
        return {};
    }

    async function makeOutgoingRequest(
        request: OutgoingRequest | RustSdkCryptoJs.UploadSigningKeysRequest,
    ): Promise<any> {
        const resp = (await customHandler?.(request)) ?? defaultHandler(request);
        if (!(request instanceof RustSdkCryptoJs.UploadSigningKeysRequest) && request.id) {
            await ourOlmMachine.markRequestAsSent(request.id!, request.type, JSON.stringify(resp));
        }
    }

    async function runLoop() {
        while (!stopRequestLoop) {
            const requests = await ourOlmMachine.outgoingRequests();
            for (const request of requests) {
                await makeOutgoingRequest(request);
            }
        }
    }

    const loopCompletedPromise = runLoop();

    return {
        makeOutgoingRequest,
        stop: async () => {
            stopRequestLoop = true;
            await loopCompletedPromise;
        },
    };
}
