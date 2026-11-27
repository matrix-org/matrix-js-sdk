import fetchMock from "@fetch-mock/vitest";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { type Mocked } from "vitest";

import {
    ClientStoppedError,
    type HttpApiEvent,
    type HttpApiEventHandlerMap,
    MatrixError,
    MatrixHttpApi,
    TypedEventEmitter,
} from "../../../src";
import { CryptoEvent, type KeyBackupInfo, type KeyBackupSession } from "../../../src/crypto-api/index.ts";
import { type OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import * as testData from "../../test-utils/crypto-test-data";
import * as TestData from "../../test-utils/crypto-test-data";
import { RustBackupManager, type KeyBackup } from "../../../src/rust-crypto/backup";
import { logger } from "../../../src/logger.ts";

describe("Upload keys to backup", () => {
    /** The backup manager under test */
    let rustBackupManager: RustBackupManager;

    let mockOlmMachine: Mocked<RustSdkCryptoJs.OlmMachine>;

    let outgoingRequestProcessor: Mocked<OutgoingRequestProcessor>;

    const httpAPi = new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
        baseUrl: "http://server/",
        prefix: "",
        onlyData: true,
    });

    let idGenerator = 0;
    function mockBackupRequest(keyCount: number): RustSdkCryptoJs.KeysBackupRequest {
        const requestBody: KeyBackup = {
            rooms: {
                "!room1:server": {
                    sessions: {},
                },
            },
        };
        for (let i = 0; i < keyCount; i++) {
            requestBody.rooms["!room1:server"].sessions["session" + i] = {} as KeyBackupSession;
        }
        return {
            id: "id" + idGenerator++,
            body: JSON.stringify(requestBody),
        } as unknown as Mocked<RustSdkCryptoJs.KeysBackupRequest>;
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        idGenerator = 0;

        mockOlmMachine = {
            getBackupKeys: vi.fn().mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } satisfies Partial<RustSdkCryptoJs.BackupKeys>),
            backupRoomKeys: vi.fn(),
            isBackupEnabled: vi.fn().mockResolvedValue(true),
            enableBackupV1: vi.fn(),
            disableBackup: vi.fn(),
            saveBackupDecryptionKey: vi.fn(),
            verifyBackup: vi.fn().mockResolvedValue({
                trusted: vi.fn().mockResolvedValue(true),
            } satisfies Partial<RustSdkCryptoJs.SignatureVerification>),
            roomKeyCounts: vi.fn(),
        } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

        outgoingRequestProcessor = {
            makeOutgoingRequest: vi.fn(),
        } as unknown as Mocked<OutgoingRequestProcessor>;

        rustBackupManager = new RustBackupManager(logger, mockOlmMachine, httpAPi, outgoingRequestProcessor);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetAllMocks();
    });

    it("Should call expensive roomKeyCounts only once per loop", async () => {
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

        const remainingEmitted: number[] = [];

        const zeroRemainingWasEmitted = new Promise<void>((resolve) => {
            rustBackupManager.on(CryptoEvent.KeyBackupSessionsRemaining, (count) => {
                remainingEmitted.push(count);
                if (count == 0) {
                    resolve();
                }
            });
        });

        // We want several batch of keys to check that we don't call expensive room key count several times
        mockOlmMachine.backupRoomKeys
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(100))
            .mockResolvedValueOnce(mockBackupRequest(2))
            .mockResolvedValue(undefined);

        mockOlmMachine.roomKeyCounts.mockResolvedValue({
            total: 602,
            // First iteration won't call roomKeyCounts(); it will be called on the second iteration after 200 keys have been saved.
            backedUp: 200,
        } as unknown as RustSdkCryptoJs.RoomKeyCounts);

        await rustBackupManager.checkKeyBackupAndEnable(false);
        await vi.runAllTimersAsync();

        await zeroRemainingWasEmitted;

        expect(outgoingRequestProcessor.makeOutgoingRequest).toHaveBeenCalledTimes(7);
        expect(mockOlmMachine.roomKeyCounts).toHaveBeenCalledTimes(1);

        // check event emission
        expect(remainingEmitted[0]).toEqual(402);
        expect(remainingEmitted[1]).toEqual(302);
        expect(remainingEmitted[2]).toEqual(202);
        expect(remainingEmitted[3]).toEqual(102);
        expect(remainingEmitted[4]).toEqual(2);
        expect(remainingEmitted[5]).toEqual(0);
    });

    it("Should not call expensive roomKeyCounts when only one iteration is needed", async () => {
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

        const zeroRemainingWasEmitted = new Promise<void>((resolve) => {
            rustBackupManager.on(CryptoEvent.KeyBackupSessionsRemaining, (count) => {
                if (count == 0) {
                    resolve();
                }
            });
        });

        // Only returns 2 keys on the first call, then none.
        mockOlmMachine.backupRoomKeys.mockResolvedValueOnce(mockBackupRequest(2)).mockResolvedValue(undefined);

        await rustBackupManager.checkKeyBackupAndEnable(false);
        await vi.runAllTimersAsync();

        await zeroRemainingWasEmitted;

        expect(outgoingRequestProcessor.makeOutgoingRequest).toHaveBeenCalledTimes(1);
        expect(mockOlmMachine.roomKeyCounts).toHaveBeenCalledTimes(0);
    });

    it("Should emit key cached after enabling a newly-created backup", async () => {
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
            status: 404,
            body: {
                errcode: "M_NOT_FOUND",
                error: "No backup found",
            },
        });
        fetchMock.post("path:/_matrix/client/v3/room_keys/version", { version: "42" });

        await rustBackupManager.checkKeyBackupAndEnable(false);

        const keyCachedEventState = Promise.withResolvers<{
            activeBackupVersion: string | null;
            eventVersion: string;
            serverBackupVersion: string | undefined;
        }>();
        rustBackupManager.on(CryptoEvent.KeyBackupDecryptionKeyCached, async (eventVersion) => {
            const [activeBackupVersion, serverBackupInfo] = await Promise.all([
                rustBackupManager.getActiveBackupVersion(),
                rustBackupManager.getServerBackupInfo(),
            ]);
            keyCachedEventState.resolve({
                activeBackupVersion,
                eventVersion,
                serverBackupVersion: serverBackupInfo?.version,
            });
        });

        await rustBackupManager.setupKeyBackup(async () => {});

        await expect(keyCachedEventState.promise).resolves.toEqual({
            activeBackupVersion: "42",
            eventVersion: "42",
            serverBackupVersion: "42",
        });
        expect(mockOlmMachine.enableBackupV1).toHaveBeenCalledWith(expect.any(String), "42");
        expect(mockOlmMachine.saveBackupDecryptionKey).toHaveBeenCalledWith(expect.anything(), "42");
    });

    it("should reject backup check and abort setupKeyBackup if stopped while checking", async () => {
        const res = Promise.withResolvers<KeyBackupInfo>();
        const started = Promise.withResolvers<void>();
        fetchMock.getOnce("path:/_matrix/client/v3/room_keys/version", () => {
            started.resolve();
            return res.promise;
        });

        const check = rustBackupManager.checkKeyBackupAndEnable(false);
        await started.promise;
        const setup = rustBackupManager.setupKeyBackup(async () => {});
        rustBackupManager.stop();
        res.resolve(testData.SIGNED_BACKUP_DATA);

        await expect(check).rejects.toBeInstanceOf(ClientStoppedError);
        await expect(setup).rejects.toBeInstanceOf(ClientStoppedError);
        expect(mockOlmMachine.isBackupEnabled).not.toHaveBeenCalled();
        expect(fetchMock.callHistory.calls()).toHaveLength(1);
    });

    it("should stop backupKeysLoop on upload error after stop", async () => {
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
        mockOlmMachine.isBackupEnabled.mockResolvedValue(false);
        mockOlmMachine.backupRoomKeys.mockResolvedValueOnce(mockBackupRequest(1)).mockResolvedValue(undefined);
        const upload = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        outgoingRequestProcessor.makeOutgoingRequest.mockImplementation(() => {
            started.resolve();
            return upload.promise;
        });

        await rustBackupManager.checkKeyBackupAndEnable(false);
        await vi.advanceTimersByTimeAsync(10_000);
        await started.promise;
        rustBackupManager.stop();
        upload.reject(new MatrixError({ errcode: "M_WRONG_ROOM_KEYS_VERSION" }, 403));
        await vi.runAllTimersAsync();

        expect(mockOlmMachine.disableBackup).not.toHaveBeenCalled();
        expect(fetchMock.callHistory.calls("path:/_matrix/client/v3/room_keys/version")).toHaveLength(1);
    });
});
