import { ConnectionError } from "../../src/http-api/errors";
import { ClientEvent, type MatrixClient, type Store } from "../../src/client";
import { ToDeviceMessageQueue } from "../../src/ToDeviceMessageQueue";
import { getMockClientWithEventEmitter } from "../test-utils/client";
import { StubStore } from "../../src/store/stub";
import { type IndexedToDeviceBatch } from "../../src/models/ToDeviceMessage";
import { SyncState } from "../../src/sync";
import { logger } from "../../src/logger.ts";

describe("onResumedSync", () => {
    let batch: IndexedToDeviceBatch | null;
    let shouldFailSendToDevice: boolean;
    let onSendToDeviceFailure: () => void;
    let onSendToDeviceSuccess: () => void;
    let resumeSync: (newState: SyncState, oldState: SyncState) => void;

    let store: Store;
    let mockClient: MatrixClient;
    let queue: ToDeviceMessageQueue;

    beforeEach(() => {
        batch = {
            id: 0,
            txnId: "123",
            eventType: "m.dummy",
            batch: [],
        };

        shouldFailSendToDevice = true;
        onSendToDeviceFailure = () => {};
        onSendToDeviceSuccess = () => {};
        resumeSync = (newState, oldState) => {
            shouldFailSendToDevice = false;
            mockClient.emit(ClientEvent.Sync, newState, oldState);
        };

        store = new StubStore();
        store.getOldestToDeviceBatch = jest.fn().mockImplementation(() => {
            return batch;
        });
        store.removeToDeviceBatch = jest.fn().mockImplementation(() => {
            batch = null;
        });

        mockClient = getMockClientWithEventEmitter({});
        mockClient.store = store;
        mockClient.sendToDevice = jest.fn().mockImplementation(async () => {
            if (shouldFailSendToDevice) {
                await Promise.reject(new ConnectionError("")).finally(() => {
                    setTimeout(onSendToDeviceFailure, 0);
                });
            } else {
                await Promise.resolve({}).finally(() => {
                    setTimeout(onSendToDeviceSuccess, 0);
                });
            }
        });

        queue = new ToDeviceMessageQueue(mockClient, logger);
    });

    it("resends queue after connectivity restored", async () => {
        const successResolvers = Promise.withResolvers<void>();

        onSendToDeviceFailure = () => {
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(1);
            expect(store.removeToDeviceBatch).not.toHaveBeenCalled();

            resumeSync(SyncState.Syncing, SyncState.Catchup);
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(2);
        };

        onSendToDeviceSuccess = () => {
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(3);
            expect(store.removeToDeviceBatch).toHaveBeenCalled();
            successResolvers.resolve();
        };

        queue.start();
        return successResolvers.promise;
    });

    it("does not resend queue if client sync still catching up", async () => {
        const successResolvers = Promise.withResolvers<void>();

        onSendToDeviceFailure = () => {
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(1);
            expect(store.removeToDeviceBatch).not.toHaveBeenCalled();

            resumeSync(SyncState.Catchup, SyncState.Catchup);
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(1);
            successResolvers.resolve();
        };

        queue.start();
        return successResolvers.promise;
    });

    it("does not resend queue if connectivity restored after queue stopped", async () => {
        const successResolvers = Promise.withResolvers<void>();

        onSendToDeviceFailure = () => {
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(1);
            expect(store.removeToDeviceBatch).not.toHaveBeenCalled();

            queue.stop();

            resumeSync(SyncState.Syncing, SyncState.Catchup);
            expect(store.getOldestToDeviceBatch).toHaveBeenCalledTimes(1);
            successResolvers.resolve();
        };

        queue.start();
        return successResolvers.promise;
    });
});
