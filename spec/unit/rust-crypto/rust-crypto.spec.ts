/*
Copyright 2022-2023 The Matrix.org Foundation C.I.C.

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
import { KeysQueryRequest, OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import { mocked, Mocked } from "jest-mock";
import fetchMock from "fetch-mock-jest";

import { RustCrypto } from "../../../src/rust-crypto/rust-crypto";
import { initRustCrypto } from "../../../src/rust-crypto";
import {
    CryptoEvent,
    Device,
    DeviceVerification,
    HttpApiEvent,
    HttpApiEventHandlerMap,
    IHttpOpts,
    IToDeviceEvent,
    MatrixClient,
    MatrixEvent,
    MatrixHttpApi,
    TypedEventEmitter,
} from "../../../src";
import { mkEvent } from "../../test-utils/test-utils";
import { CryptoBackend } from "../../../src/common-crypto/CryptoBackend";
import { IEventDecryptionResult } from "../../../src/@types/crypto";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { ServerSideSecretStorage } from "../../../src/secret-storage";
import {
    CryptoCallbacks,
    EventShieldColour,
    EventShieldReason,
    ImportRoomKeysOpts,
    KeyBackupCheck,
    VerificationRequest,
} from "../../../src/crypto-api";
import * as testData from "../../test-utils/test-data";
import { defer } from "../../../src/utils";
import { logger } from "../../../src/logger";
import { OutgoingRequestsManager } from "../../../src/rust-crypto/OutgoingRequestsManager";
import { Curve25519AuthData } from "../../../src/crypto-api/keybackup";

const TEST_USER = "@alice:example.com";
const TEST_DEVICE_ID = "TEST_DEVICE";

afterEach(() => {
    fetchMock.reset();
    jest.restoreAllMocks();
});

describe("initRustCrypto", () => {
    function makeTestOlmMachine(): Mocked<OlmMachine> {
        return {
            registerRoomKeyUpdatedCallback: jest.fn(),
            registerUserIdentityUpdatedCallback: jest.fn(),
            getSecretsFromInbox: jest.fn().mockResolvedValue(["dGhpc2lzYWZha2VzZWNyZXQ="]),
            deleteSecretsFromInbox: jest.fn(),
            registerReceiveSecretCallback: jest.fn(),
            outgoingRequests: jest.fn(),
        } as unknown as Mocked<OlmMachine>;
    }

    it("passes through the store params", async () => {
        const testOlmMachine = makeTestOlmMachine();
        jest.spyOn(OlmMachine, "initialize").mockResolvedValue(testOlmMachine);

        await initRustCrypto(
            logger,
            {} as MatrixClient["http"],
            TEST_USER,
            TEST_DEVICE_ID,
            {} as ServerSideSecretStorage,
            {} as CryptoCallbacks,
            "storePrefix",
            "storePassphrase",
        );

        expect(OlmMachine.initialize).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            "storePrefix",
            "storePassphrase",
        );
    });

    it("suppresses the storePassphrase if storePrefix is unset", async () => {
        const testOlmMachine = makeTestOlmMachine();
        jest.spyOn(OlmMachine, "initialize").mockResolvedValue(testOlmMachine);

        await initRustCrypto(
            logger,
            {} as MatrixClient["http"],
            TEST_USER,
            TEST_DEVICE_ID,
            {} as ServerSideSecretStorage,
            {} as CryptoCallbacks,
            null,
            "storePassphrase",
        );

        expect(OlmMachine.initialize).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined, undefined);
    });

    it("Should get secrets from inbox on start", async () => {
        const testOlmMachine = makeTestOlmMachine() as OlmMachine;
        jest.spyOn(OlmMachine, "initialize").mockResolvedValue(testOlmMachine);

        await initRustCrypto(
            logger,
            {} as MatrixClient["http"],
            TEST_USER,
            TEST_DEVICE_ID,
            {} as ServerSideSecretStorage,
            {} as CryptoCallbacks,
            "storePrefix",
            "storePassphrase",
        );

        expect(testOlmMachine.getSecretsFromInbox).toHaveBeenCalledWith("m.megolm_backup.v1");
    });
});

describe("RustCrypto", () => {
    it("getVersion() should return the current version of the rust sdk and vodozemac", async () => {
        const rustCrypto = await makeTestRustCrypto();
        const versions = RustSdkCryptoJs.getVersions();
        expect(rustCrypto.getVersion()).toBe(
            `Rust SDK ${versions.matrix_sdk_crypto} (${versions.git_sha}), Vodozemac ${versions.vodozemac}`,
        );
    });

    describe(".importRoomKeys and .exportRoomKeys", () => {
        let rustCrypto: RustCrypto;

        beforeEach(
            async () => {
                rustCrypto = await makeTestRustCrypto();
            },
            /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */
            10000,
        );

        it("should import and export keys", async () => {
            const someRoomKeys = testData.MEGOLM_SESSION_DATA_ARRAY;
            let importTotal = 0;
            const opt: ImportRoomKeysOpts = {
                progressCallback: (stage) => {
                    importTotal = stage.total;
                },
            };
            await rustCrypto.importRoomKeys(someRoomKeys, opt);

            expect(importTotal).toBe(someRoomKeys.length);

            const keys = await rustCrypto.exportRoomKeys();
            expect(Array.isArray(keys)).toBeTruthy();
            expect(keys.length).toBe(someRoomKeys.length);

            const aSession = someRoomKeys[0];

            const exportedKey = keys.find((k) => k.session_id == aSession.session_id);

            expect(aSession).toStrictEqual(exportedKey);
        });
    });

    describe("call preprocess methods", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto();
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

        it("emits VerificationRequestReceived on incoming m.key.verification.request", async () => {
            const toDeviceEvent = {
                type: "m.key.verification.request",
                content: {
                    from_device: "testDeviceId",
                    methods: ["m.sas.v1"],
                    transaction_id: "testTxn",
                    timestamp: Date.now() - 1000,
                },
                sender: "@user:id",
            };

            const onEvent = jest.fn();
            rustCrypto.on(CryptoEvent.VerificationRequestReceived, onEvent);
            await rustCrypto.preprocessToDeviceMessages([toDeviceEvent]);
            expect(onEvent).toHaveBeenCalledTimes(1);

            const [req]: [VerificationRequest] = onEvent.mock.lastCall;
            expect(req.transactionId).toEqual("testTxn");
        });
    });

    it("getCrossSigningKeyId when there is no cross signing keys", async () => {
        const rustCrypto = await makeTestRustCrypto();
        await expect(rustCrypto.getCrossSigningKeyId()).resolves.toBe(null);
    });

    describe("getCrossSigningStatus", () => {
        it("returns sensible values on a default client", async () => {
            const secretStorage = {
                isStored: jest.fn().mockResolvedValue(null),
                getDefaultKeyId: jest.fn().mockResolvedValue("key"),
            } as unknown as Mocked<ServerSideSecretStorage>;
            const rustCrypto = await makeTestRustCrypto(undefined, undefined, undefined, secretStorage);

            const result = await rustCrypto.getCrossSigningStatus();

            expect(secretStorage.isStored).toHaveBeenCalledWith("m.cross_signing.master");
            expect(result).toEqual({
                privateKeysCachedLocally: {
                    masterKey: false,
                    selfSigningKey: false,
                    userSigningKey: false,
                },
                privateKeysInSecretStorage: false,
                publicKeysOnDevice: false,
            });
        });

        it("throws if `stop` is called mid-call", async () => {
            const secretStorage = {
                isStored: jest.fn().mockResolvedValue(null),
                getDefaultKeyId: jest.fn().mockResolvedValue(null),
            } as unknown as Mocked<ServerSideSecretStorage>;
            const rustCrypto = await makeTestRustCrypto(undefined, undefined, undefined, secretStorage);

            // start the call off
            const result = rustCrypto.getCrossSigningStatus();

            // call `.stop`
            rustCrypto.stop();

            // getCrossSigningStatus should abort
            await expect(result).rejects.toEqual(new Error("MatrixClient has been stopped"));
        });
    });

    it("bootstrapCrossSigning delegates to CrossSigningIdentity", async () => {
        const rustCrypto = await makeTestRustCrypto();
        const mockCrossSigningIdentity = {
            bootstrapCrossSigning: jest.fn().mockResolvedValue(undefined),
        };
        // @ts-ignore private property
        rustCrypto.crossSigningIdentity = mockCrossSigningIdentity;
        await rustCrypto.bootstrapCrossSigning({});
        expect(mockCrossSigningIdentity.bootstrapCrossSigning).toHaveBeenCalledWith({});
    });

    it("isSecretStorageReady", async () => {
        const mockSecretStorage = {
            getDefaultKeyId: jest.fn().mockResolvedValue(null),
        } as unknown as Mocked<ServerSideSecretStorage>;
        const rustCrypto = await makeTestRustCrypto(undefined, undefined, undefined, mockSecretStorage);
        await expect(rustCrypto.isSecretStorageReady()).resolves.toBe(false);
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

            const outgoingRequestsManager = new OutgoingRequestsManager(logger, olmMachine, outgoingRequestProcessor);

            rustCrypto = new RustCrypto(
                logger,
                olmMachine,
                {} as MatrixHttpApi<any>,
                TEST_USER,
                TEST_DEVICE_ID,
                {} as ServerSideSecretStorage,
                {} as CryptoCallbacks,
            );
            rustCrypto["outgoingRequestProcessor"] = outgoingRequestProcessor;
            rustCrypto["outgoingRequestsManager"] = outgoingRequestsManager;
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

        it("should go round the loop again if another sync completes while the first `outgoingRequests` is running", async () => {
            // the first call to `outgoingMessages` will return a promise which blocks for a while
            const firstOutgoingRequestsDefer = defer<Array<any>>();
            mocked(olmMachine.outgoingRequests).mockReturnValueOnce(firstOutgoingRequestsDefer.promise);

            // the second will return a KeysQueryRequest.
            const testReq = new KeysQueryRequest("1234", "{}");
            outgoingRequestQueue.push([testReq]);

            // the first sync completes, triggering the first call to `outgoingMessages`
            rustCrypto.onSyncCompleted({});
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);

            // a second /sync completes before the first call to `outgoingRequests` completes. It shouldn't trigger
            // a second call immediately, but should queue one up.
            rustCrypto.onSyncCompleted({});
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(1);

            // the first call now completes, *with an empty result*, which would normally cause us to exit the loop, but
            // we should have a second call queued. It should trigger a call to `makeOutgoingRequest`.
            firstOutgoingRequestsDefer.resolve([]);
            await awaitCallToMakeOutgoingRequest();
            expect(olmMachine.outgoingRequests).toHaveBeenCalledTimes(2);
        });
    });

    describe(".getEventEncryptionInfo", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto();
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

    describe(".getEncryptionInfoForEvent", () => {
        let rustCrypto: RustCrypto;
        let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

        beforeEach(() => {
            olmMachine = {
                getRoomEventEncryptionInfo: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;
            rustCrypto = new RustCrypto(
                logger,
                olmMachine,
                {} as MatrixClient["http"],
                TEST_USER,
                TEST_DEVICE_ID,
                {} as ServerSideSecretStorage,
                {} as CryptoCallbacks,
            );
        });

        async function makeEncryptedEvent(): Promise<MatrixEvent> {
            const encryptedEvent = mkEvent({
                event: true,
                type: "m.room.encrypted",
                content: { algorithm: "fake_alg" },
                room: "!room:id",
            });
            encryptedEvent.event.event_id = "$event:id";
            const mockCryptoBackend = {
                decryptEvent: () =>
                    ({
                        clearEvent: { content: { body: "1234" } },
                    } as unknown as IEventDecryptionResult),
            } as unknown as CryptoBackend;
            await encryptedEvent.attemptDecryption(mockCryptoBackend);
            return encryptedEvent;
        }

        it("should handle unencrypted events", async () => {
            const event = mkEvent({ event: true, type: "m.room.message", content: { body: "xyz" } });
            const res = await rustCrypto.getEncryptionInfoForEvent(event);
            expect(res).toBe(null);
            expect(olmMachine.getRoomEventEncryptionInfo).not.toHaveBeenCalled();
        });

        it("should handle decryption failures", async () => {
            const event = mkEvent({
                event: true,
                type: "m.room.encrypted",
                content: { algorithm: "fake_alg" },
                room: "!room:id",
            });
            event.event.event_id = "$event:id";
            const mockCryptoBackend = {
                decryptEvent: () => {
                    throw new Error("UISI");
                },
            };
            await event.attemptDecryption(mockCryptoBackend as unknown as CryptoBackend);

            const res = await rustCrypto.getEncryptionInfoForEvent(event);
            expect(res).toBe(null);
            expect(olmMachine.getRoomEventEncryptionInfo).not.toHaveBeenCalled();
        });

        it("passes the event into the OlmMachine", async () => {
            const encryptedEvent = await makeEncryptedEvent();
            const res = await rustCrypto.getEncryptionInfoForEvent(encryptedEvent);
            expect(res).toBe(null);
            expect(olmMachine.getRoomEventEncryptionInfo).toHaveBeenCalledTimes(1);
            const [passedEvent, passedRoom] = olmMachine.getRoomEventEncryptionInfo.mock.calls[0];
            expect(passedRoom.toString()).toEqual("!room:id");
            expect(JSON.parse(passedEvent)).toStrictEqual(
                expect.objectContaining({
                    event_id: "$event:id",
                }),
            );
        });

        it.each([
            [RustSdkCryptoJs.ShieldColor.None, EventShieldColour.NONE],
            [RustSdkCryptoJs.ShieldColor.Grey, EventShieldColour.GREY],
            [RustSdkCryptoJs.ShieldColor.Red, EventShieldColour.RED],
        ])("gets the right shield color (%i)", async (rustShield, expectedShield) => {
            const mockEncryptionInfo = {
                shieldState: jest.fn().mockReturnValue({ color: rustShield, message: undefined }),
            } as unknown as RustSdkCryptoJs.EncryptionInfo;
            olmMachine.getRoomEventEncryptionInfo.mockResolvedValue(mockEncryptionInfo);

            const res = await rustCrypto.getEncryptionInfoForEvent(await makeEncryptedEvent());
            expect(mockEncryptionInfo.shieldState).toHaveBeenCalledWith(false);
            expect(res).not.toBe(null);
            expect(res!.shieldColour).toEqual(expectedShield);
        });

        it.each([
            [undefined, null],
            ["Encrypted by an unverified user.", EventShieldReason.UNVERIFIED_IDENTITY],
            ["Encrypted by a device not verified by its owner.", EventShieldReason.UNSIGNED_DEVICE],
            [
                "The authenticity of this encrypted message can't be guaranteed on this device.",
                EventShieldReason.AUTHENTICITY_NOT_GUARANTEED,
            ],
            ["Encrypted by an unknown or deleted device.", EventShieldReason.UNKNOWN_DEVICE],
            ["bloop", EventShieldReason.UNKNOWN],
        ])("gets the right shield reason (%s)", async (rustReason, expectedReason) => {
            // suppress the warning from the unknown shield reason
            jest.spyOn(console, "warn").mockImplementation(() => {});

            const mockEncryptionInfo = {
                shieldState: jest
                    .fn()
                    .mockReturnValue({ color: RustSdkCryptoJs.ShieldColor.None, message: rustReason }),
            } as unknown as RustSdkCryptoJs.EncryptionInfo;
            olmMachine.getRoomEventEncryptionInfo.mockResolvedValue(mockEncryptionInfo);

            const res = await rustCrypto.getEncryptionInfoForEvent(await makeEncryptedEvent());
            expect(mockEncryptionInfo.shieldState).toHaveBeenCalledWith(false);
            expect(res).not.toBe(null);
            expect(res!.shieldReason).toEqual(expectedReason);
        });
    });

    describe("get|setTrustCrossSignedDevices", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto();
        });

        it("should be true by default", () => {
            expect(rustCrypto.getTrustCrossSignedDevices()).toBe(true);
        });

        it("should be easily turn-off-and-on-able", () => {
            rustCrypto.setTrustCrossSignedDevices(false);
            expect(rustCrypto.getTrustCrossSignedDevices()).toBe(false);
            rustCrypto.setTrustCrossSignedDevices(true);
            expect(rustCrypto.getTrustCrossSignedDevices()).toBe(true);
        });
    });

    describe("setDeviceVerified", () => {
        let rustCrypto: RustCrypto;

        async function getTestDevice(): Promise<Device> {
            const devices = await rustCrypto.getUserDeviceInfo([testData.TEST_USER_ID]);
            return devices.get(testData.TEST_USER_ID)!.get(testData.TEST_DEVICE_ID)!;
        }

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto(
                new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
                    baseUrl: "http://server/",
                    prefix: "",
                    onlyData: true,
                }),
                testData.TEST_USER_ID,
            );

            fetchMock.post("path:/_matrix/client/v3/keys/upload", { one_time_key_counts: {} });
            fetchMock.post("path:/_matrix/client/v3/keys/query", {
                device_keys: {
                    [testData.TEST_USER_ID]: {
                        [testData.TEST_DEVICE_ID]: testData.SIGNED_TEST_DEVICE_DATA,
                    },
                },
            });
            // call onSyncCompleted to kick off the outgoingRequestLoop and download the device list.
            rustCrypto.onSyncCompleted({});

            // before the call, the device should be unverified.
            const device = await getTestDevice();
            expect(device.verified).toEqual(DeviceVerification.Unverified);
        });

        it("should throw an error for an unknown device", async () => {
            await expect(rustCrypto.setDeviceVerified(testData.TEST_USER_ID, "xxy")).rejects.toThrow("Unknown device");
        });

        it("should mark an unverified device as verified", async () => {
            await rustCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            // and confirm that the device is now verified
            expect((await getTestDevice()).verified).toEqual(DeviceVerification.Verified);
        });

        it("should mark a verified device as unverified", async () => {
            await rustCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
            expect((await getTestDevice()).verified).toEqual(DeviceVerification.Verified);

            await rustCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID, false);
            expect((await getTestDevice()).verified).toEqual(DeviceVerification.Unverified);
        });
    });

    describe("getDeviceVerificationStatus", () => {
        let rustCrypto: RustCrypto;
        let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

        beforeEach(() => {
            olmMachine = {
                getDevice: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;
            rustCrypto = new RustCrypto(
                logger,
                olmMachine,
                {} as MatrixClient["http"],
                TEST_USER,
                TEST_DEVICE_ID,
                {} as ServerSideSecretStorage,
                {} as CryptoCallbacks,
            );
        });

        it("should call getDevice", async () => {
            olmMachine.getDevice.mockResolvedValue({
                free: jest.fn(),
                isCrossSigningTrusted: jest.fn().mockReturnValue(false),
                isLocallyTrusted: jest.fn().mockReturnValue(false),
                isCrossSignedByOwner: jest.fn().mockReturnValue(false),
            } as unknown as RustSdkCryptoJs.Device);
            const res = await rustCrypto.getDeviceVerificationStatus("@user:domain", "device");
            expect(olmMachine.getDevice.mock.calls[0][0].toString()).toEqual("@user:domain");
            expect(olmMachine.getDevice.mock.calls[0][1].toString()).toEqual("device");
            expect(res?.crossSigningVerified).toBe(false);
            expect(res?.localVerified).toBe(false);
            expect(res?.signedByOwner).toBe(false);
        });

        it("should return null for unknown device", async () => {
            olmMachine.getDevice.mockResolvedValue(undefined);
            const res = await rustCrypto.getDeviceVerificationStatus("@user:domain", "device");
            expect(res).toBe(null);
        });
    });

    describe("userHasCrossSigningKeys", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto(
                new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
                    baseUrl: "http://server/",
                    prefix: "",
                    onlyData: true,
                }),
                testData.TEST_USER_ID,
            );
        });

        it("throws an error if the fetch fails", async () => {
            fetchMock.post("path:/_matrix/client/v3/keys/query", 400);
            await expect(rustCrypto.userHasCrossSigningKeys()).rejects.toThrow("400 error");
        });

        it("returns false if the user has no cross-signing keys", async () => {
            fetchMock.post("path:/_matrix/client/v3/keys/query", {
                device_keys: {
                    [testData.TEST_USER_ID]: { [testData.TEST_DEVICE_ID]: testData.SIGNED_TEST_DEVICE_DATA },
                },
            });

            await expect(rustCrypto.userHasCrossSigningKeys()).resolves.toBe(false);
        });

        it("returns true if the user has cross-signing keys", async () => {
            fetchMock.post("path:/_matrix/client/v3/keys/query", {
                device_keys: {
                    [testData.TEST_USER_ID]: { [testData.TEST_DEVICE_ID]: testData.SIGNED_TEST_DEVICE_DATA },
                },
                ...testData.SIGNED_CROSS_SIGNING_KEYS_DATA,
            });

            await expect(rustCrypto.userHasCrossSigningKeys()).resolves.toBe(true);
        });

        it("returns true if the user is untracked, downloadUncached is set at true and the cross-signing keys are available", async () => {
            fetchMock.post("path:/_matrix/client/v3/keys/query", {
                device_keys: {
                    [testData.BOB_TEST_USER_ID]: {
                        [testData.BOB_TEST_DEVICE_ID]: testData.BOB_SIGNED_TEST_DEVICE_DATA,
                    },
                },
                ...testData.BOB_SIGNED_CROSS_SIGNING_KEYS_DATA,
            });

            await expect(rustCrypto.userHasCrossSigningKeys(testData.BOB_TEST_USER_ID, true)).resolves.toBe(true);
        });

        it("returns false if the user is unknown", async () => {
            await expect(rustCrypto.userHasCrossSigningKeys(testData.BOB_TEST_USER_ID)).resolves.toBe(false);
        });
    });

    describe("createRecoveryKeyFromPassphrase", () => {
        let rustCrypto: RustCrypto;

        beforeEach(async () => {
            rustCrypto = await makeTestRustCrypto();
        });

        it("should create a recovery key without password", async () => {
            const recoveryKey = await rustCrypto.createRecoveryKeyFromPassphrase();

            // Expected the encoded private key to have 59 chars
            expect(recoveryKey.encodedPrivateKey?.length).toBe(59);
            // Expect the private key to be an Uint8Array with a length of 32
            expect(recoveryKey.privateKey).toBeInstanceOf(Uint8Array);
            expect(recoveryKey.privateKey.length).toBe(32);
            // Expect keyInfo to be empty
            expect(Object.keys(recoveryKey.keyInfo!).length).toBe(0);
        });

        it("should create a recovery key with password", async () => {
            const recoveryKey = await rustCrypto.createRecoveryKeyFromPassphrase("my password");

            // Expected the encoded private key to have 59 chars
            expect(recoveryKey.encodedPrivateKey?.length).toBe(59);
            // Expect the private key to be an Uint8Array with a length of 32
            expect(recoveryKey.privateKey).toBeInstanceOf(Uint8Array);
            expect(recoveryKey.privateKey.length).toBe(32);
            // Expect keyInfo.passphrase to be filled
            expect(recoveryKey.keyInfo?.passphrase?.algorithm).toBe("m.pbkdf2");
            expect(recoveryKey.keyInfo?.passphrase?.iterations).toBe(500000);
        });
    });

    it("should wait for a keys/query before returning devices", async () => {
        jest.useFakeTimers();

        const mockHttpApi = new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
            baseUrl: "http://server/",
            prefix: "",
            onlyData: true,
        });
        fetchMock.post("path:/_matrix/client/v3/keys/upload", { one_time_key_counts: {} });
        fetchMock.post("path:/_matrix/client/v3/keys/query", {
            device_keys: {
                [testData.TEST_USER_ID]: {
                    [testData.TEST_DEVICE_ID]: testData.SIGNED_TEST_DEVICE_DATA,
                },
            },
        });

        const rustCrypto = await makeTestRustCrypto(mockHttpApi, testData.TEST_USER_ID);

        // an attempt to fetch the device list should block
        const devicesPromise = rustCrypto.getUserDeviceInfo([testData.TEST_USER_ID]);

        // ... until a /sync completes, and we trigger the outgoingRequests.
        rustCrypto.onSyncCompleted({});

        const deviceMap = (await devicesPromise).get(testData.TEST_USER_ID)!;
        expect(deviceMap.has(TEST_DEVICE_ID)).toBe(true);
        expect(deviceMap.has(testData.TEST_DEVICE_ID)).toBe(true);
        rustCrypto.stop();
    });

    describe("requestDeviceVerification", () => {
        it("throws an error if the device is unknown", async () => {
            const rustCrypto = await makeTestRustCrypto();
            await expect(() => rustCrypto.requestDeviceVerification(TEST_USER, "unknown")).rejects.toThrow(
                "Not a known device",
            );
        });
    });

    describe("get|storeSessionBackupPrivateKey", () => {
        it("can save and restore a key", async () => {
            const key = "testtesttesttesttesttesttesttest";
            const rustCrypto = await makeTestRustCrypto();
            await rustCrypto.storeSessionBackupPrivateKey(
                new TextEncoder().encode(key),
                testData.SIGNED_BACKUP_DATA.version!,
            );
            const fetched = await rustCrypto.getSessionBackupPrivateKey();
            expect(new TextDecoder().decode(fetched!)).toEqual(key);
        });

        it("fails to save a key if version not provided", async () => {
            const key = "testtesttesttesttesttesttesttest";
            const rustCrypto = await makeTestRustCrypto();
            await expect(() => rustCrypto.storeSessionBackupPrivateKey(new TextEncoder().encode(key))).rejects.toThrow(
                "storeSessionBackupPrivateKey: version is required",
            );
            const fetched = await rustCrypto.getSessionBackupPrivateKey();
            expect(fetched).toBeNull();
        });
    });

    describe("getActiveSessionBackupVersion", () => {
        it("returns null", async () => {
            const rustCrypto = await makeTestRustCrypto();
            expect(await rustCrypto.getActiveSessionBackupVersion()).toBeNull();
        });
    });

    describe("findVerificationRequestDMInProgress", () => {
        it("throws an error if the userId is not provided", async () => {
            const rustCrypto = await makeTestRustCrypto();
            expect(() => rustCrypto.findVerificationRequestDMInProgress(testData.TEST_ROOM_ID)).toThrow(
                "missing userId",
            );
        });
    });

    describe("requestVerificationDM", () => {
        it("send verification request to an unknown user", async () => {
            const rustCrypto = await makeTestRustCrypto();
            await expect(() =>
                rustCrypto.requestVerificationDM("@bob:example.com", testData.TEST_ROOM_ID),
            ).rejects.toThrow("unknown userId @bob:example.com");
        });
    });

    describe("getUserVerificationStatus", () => {
        let rustCrypto: RustCrypto;
        let olmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

        beforeEach(() => {
            olmMachine = {
                getIdentity: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;
            rustCrypto = new RustCrypto(
                logger,
                olmMachine,
                {} as MatrixClient["http"],
                TEST_USER,
                TEST_DEVICE_ID,
                {} as ServerSideSecretStorage,
                {} as CryptoCallbacks,
            );
        });

        it("returns an unverified UserVerificationStatus when there is no UserIdentity", async () => {
            const userVerificationStatus = await rustCrypto.getUserVerificationStatus(testData.TEST_USER_ID);
            expect(userVerificationStatus.isVerified()).toBeFalsy();
            expect(userVerificationStatus.isTofu()).toBeFalsy();
            expect(userVerificationStatus.isCrossSigningVerified()).toBeFalsy();
            expect(userVerificationStatus.wasCrossSigningVerified()).toBeFalsy();
        });

        it("returns a verified UserVerificationStatus when the UserIdentity is verified", async () => {
            olmMachine.getIdentity.mockResolvedValue({ free: jest.fn(), isVerified: jest.fn().mockReturnValue(true) });

            const userVerificationStatus = await rustCrypto.getUserVerificationStatus(testData.TEST_USER_ID);
            expect(userVerificationStatus.isVerified()).toBeTruthy();
            expect(userVerificationStatus.isTofu()).toBeFalsy();
            expect(userVerificationStatus.isCrossSigningVerified()).toBeTruthy();
            expect(userVerificationStatus.wasCrossSigningVerified()).toBeFalsy();
        });
    });

    describe("key backup", () => {
        it("is started when rust crypto is created", async () => {
            // `RustCrypto.checkKeyBackupAndEnable` async call is made in background in the RustCrypto constructor.
            // We don't have an instance of the rust crypto yet, we spy directly in the prototype.
            const spyCheckKeyBackupAndEnable = jest
                .spyOn(RustCrypto.prototype, "checkKeyBackupAndEnable")
                .mockResolvedValue({} as KeyBackupCheck);

            await makeTestRustCrypto();

            expect(spyCheckKeyBackupAndEnable).toHaveBeenCalled();
        });

        it("raises KeyBackupStatus event when identify change", async () => {
            // Return the key backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const mockHttpApi = new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
                baseUrl: "http://server/",
                prefix: "",
                onlyData: true,
            });

            const olmMachine = {
                getIdentity: jest.fn(),
                // Force the backup to be trusted by the olmMachine
                verifyBackup: jest.fn().mockResolvedValue({ trusted: jest.fn().mockReturnValue(true) }),
                isBackupEnabled: jest.fn().mockReturnValue(true),
                getBackupKeys: jest.fn(),
                enableBackupV1: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

            const rustCrypto = new RustCrypto(
                logger,
                olmMachine,
                mockHttpApi,
                testData.TEST_USER_ID,
                testData.TEST_DEVICE_ID,
                {} as ServerSideSecretStorage,
                {} as CryptoCallbacks,
            );

            // Wait for the key backup to be available
            const keyBackupStatusPromise = new Promise<boolean>((resolve) =>
                rustCrypto.once(CryptoEvent.KeyBackupStatus, resolve),
            );
            await rustCrypto.onUserIdentityUpdated(new RustSdkCryptoJs.UserId(testData.TEST_USER_ID));
            expect(await keyBackupStatusPromise).toBe(true);
        });

        it("does not back up keys that came from backup", async () => {
            const rustCrypto = await makeTestRustCrypto();
            const olmMachine: OlmMachine = rustCrypto["olmMachine"];

            await olmMachine.enableBackupV1(
                (testData.SIGNED_BACKUP_DATA.auth_data as Curve25519AuthData).public_key,
                testData.SIGNED_BACKUP_DATA.version!,
            );

            // we import two keys: one "from backup", and one "from export"
            const [backedUpRoomKey, exportedRoomKey] = testData.MEGOLM_SESSION_DATA_ARRAY;
            await rustCrypto.importBackedUpRoomKeys([backedUpRoomKey]);
            await rustCrypto.importRoomKeys([exportedRoomKey]);

            // we ask for the keys that should be backed up
            const roomKeysRequest = await olmMachine.backupRoomKeys();
            expect(roomKeysRequest).toBeTruthy();
            const roomKeys = JSON.parse(roomKeysRequest!.body);

            // we expect that the key "from export" is present
            expect(roomKeys).toMatchObject({
                rooms: {
                    [exportedRoomKey.room_id]: {
                        sessions: {
                            [exportedRoomKey.session_id]: {},
                        },
                    },
                },
            });

            // we expect that the key "from backup" is not present
            expect(roomKeys).not.toMatchObject({
                rooms: {
                    [backedUpRoomKey.room_id]: {
                        sessions: {
                            [backedUpRoomKey.session_id]: {},
                        },
                    },
                },
            });
        });
    });
});

/** build a basic RustCrypto instance for testing
 *
 * just provides default arguments for initRustCrypto()
 */
async function makeTestRustCrypto(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }> = {} as MatrixClient["http"],
    userId: string = TEST_USER,
    deviceId: string = TEST_DEVICE_ID,
    secretStorage: ServerSideSecretStorage = {} as ServerSideSecretStorage,
    cryptoCallbacks: CryptoCallbacks = {} as CryptoCallbacks,
): Promise<RustCrypto> {
    return await initRustCrypto(logger, http, userId, deviceId, secretStorage, cryptoCallbacks, null, undefined);
}
