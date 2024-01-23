import { Mocked } from "jest-mock";
import fetchMock from "fetch-mock-jest";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { CryptoEvent, HttpApiEvent, HttpApiEventHandlerMap, MatrixHttpApi, TypedEventEmitter } from "../../../src";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import * as testData from "../../test-utils/test-data";
import * as TestData from "../../test-utils/test-data";
import { IKeyBackup } from "../../../src/crypto/backup";
import { IKeyBackupSession } from "../../../src/crypto/keybackup";
import { RustBackupManager } from "../../../src/rust-crypto/backup";

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
        const requestBody: IKeyBackup = {
            rooms: {
                "!room1:server": {
                    sessions: {},
                },
            },
        };
        for (let i = 0; i < keyCount; i++) {
            requestBody.rooms["!room1:server"].sessions["session" + i] = {} as IKeyBackupSession;
        }
        return {
            id: "id" + idGenerator++,
            body: JSON.stringify(requestBody),
        } as unknown as Mocked<RustSdkCryptoJs.KeysBackupRequest>;
    }

    beforeEach(async () => {
        jest.useFakeTimers();
        idGenerator = 0;

        mockOlmMachine = {
            getBackupKeys: jest.fn().mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys),
            backupRoomKeys: jest.fn(),
            isBackupEnabled: jest.fn().mockResolvedValue(true),
            enableBackupV1: jest.fn(),
            verifyBackup: jest.fn().mockResolvedValue({
                trusted: jest.fn().mockResolvedValue(true),
            } as unknown as RustSdkCryptoJs.SignatureVerification),
            roomKeyCounts: jest.fn(),
        } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

        outgoingRequestProcessor = {
            makeOutgoingRequest: jest.fn(),
        } as unknown as Mocked<OutgoingRequestProcessor>;

        rustBackupManager = new RustBackupManager(mockOlmMachine, httpAPi, outgoingRequestProcessor);

        fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
    });

    afterEach(() => {
        fetchMock.reset();
        jest.useRealTimers();
        jest.resetAllMocks();
    });

    it("Should call expensive roomKeyCounts only once per loop", async () => {
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
            .mockResolvedValue(null);

        mockOlmMachine.roomKeyCounts.mockResolvedValue({
            total: 602,
            // First iteration won't call roomKeyCounts(); it will be called on the second iteration after 200 keys have been saved.
            backedUp: 200,
        });

        await rustBackupManager.checkKeyBackupAndEnable(false);
        await jest.runAllTimersAsync();

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
        const zeroRemainingWasEmitted = new Promise<void>((resolve) => {
            rustBackupManager.on(CryptoEvent.KeyBackupSessionsRemaining, (count) => {
                if (count == 0) {
                    resolve();
                }
            });
        });

        // Only returns 2 keys on the first call, then none.
        mockOlmMachine.backupRoomKeys.mockResolvedValueOnce(mockBackupRequest(2)).mockResolvedValue(null);

        await rustBackupManager.checkKeyBackupAndEnable(false);
        await jest.runAllTimersAsync();

        await zeroRemainingWasEmitted;

        expect(outgoingRequestProcessor.makeOutgoingRequest).toHaveBeenCalledTimes(1);
        expect(mockOlmMachine.roomKeyCounts).toHaveBeenCalledTimes(0);
    });
});
