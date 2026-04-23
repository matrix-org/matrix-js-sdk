/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { type LocalIndexedDBStoreBackend } from "../../../src/store/indexeddb-local-backend";
import { IndexedDBStoreWorker } from "../../../src/store/indexeddb-store-worker";
import "fake-indexeddb/auto";
import { waitFor } from "../../test-utils/test-utils";

const { backendFactoryMock } = vi.hoisted(() => ({
    backendFactoryMock: vi.fn(),
}));

vi.mock("../../../src/store/indexeddb-local-backend", () => ({
    LocalIndexedDBStoreBackend: function (...args: any[]) {
        return backendFactoryMock(...args);
    },
}));

describe("IndexedDBStoreWorker", () => {
    let mockBackend: LocalIndexedDBStoreBackend;
    let worker: IndexedDBStoreWorker;
    const postMessage = vi.fn();

    beforeEach(async () => {
        backendFactoryMock.mockReset();
        mockBackend = {} as LocalIndexedDBStoreBackend;
        backendFactoryMock.mockReturnValue(mockBackend);

        worker = new IndexedDBStoreWorker(postMessage);

        worker.onMessage({
            data: { command: "setupWorker", seq: 1, args: ["worker-db"] },
        } as MessageEvent);

        await waitFor(() =>
            expect(postMessage).toHaveBeenCalledWith({ command: "cmd_success", seq: 1, result: undefined }),
        );

        postMessage.mockReset();
    });

    it("reports an unrecognised command", () => {
        worker.onMessage({
            data: { command: "notACommand", seq: 7, args: [] },
        } as MessageEvent);

        expect(postMessage).toHaveBeenCalledWith({
            command: "cmd_fail",
            seq: 7,
            error: "Unrecognised command",
        });
    });

    it("responds to getUserProfile", async () => {
        mockBackend.getUserProfile = vi.fn().mockResolvedValue({ displayname: "Alice" });

        worker.onMessage({ data: { command: "getUserProfile", seq: 2, args: ["alice"] } } as MessageEvent);

        expect(mockBackend.getUserProfile).toHaveBeenCalledWith("alice");

        await waitFor(() =>
            expect(postMessage).toHaveBeenCalledWith({
                command: "cmd_success",
                seq: 2,
                result: { displayname: "Alice" },
            }),
        );
    });

    it("responds to storeUserProfiles", async () => {
        mockBackend.storeUserProfiles = vi.fn().mockResolvedValue(undefined);

        worker.onMessage({ data: { command: "storeUserProfiles", seq: 2, args: [[]] } } as MessageEvent);

        expect(mockBackend.storeUserProfiles).toHaveBeenCalledWith([]);

        await waitFor(() =>
            expect(postMessage).toHaveBeenCalledWith({
                command: "cmd_success",
                seq: 2,
                result: undefined,
            }),
        );
    });

    it("responds to removeUserProfiles", async () => {
        mockBackend.removeUserProfiles = vi.fn().mockResolvedValue(undefined);

        worker.onMessage({ data: { command: "removeUserProfiles", seq: 2, args: [[]] } } as MessageEvent);

        expect(mockBackend.removeUserProfiles).toHaveBeenCalledWith([]);

        await waitFor(() =>
            expect(postMessage).toHaveBeenCalledWith({
                command: "cmd_success",
                seq: 2,
                result: undefined,
            }),
        );
    });
});
