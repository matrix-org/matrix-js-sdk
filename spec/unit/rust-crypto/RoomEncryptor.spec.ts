/*
 *
 * Copyright 2023 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * /
 */

import {
    CollectStrategy,
    Curve25519PublicKey,
    Ed25519PublicKey,
    HistoryVisibility as RustHistoryVisibility,
    IdentityKeys,
    OlmMachine,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import { Mocked } from "jest-mock";

import { HistoryVisibility, MatrixEvent, Room, RoomMember } from "../../../src";
import { RoomEncryptor, toRustHistoryVisibility } from "../../../src/rust-crypto/RoomEncryptor";
import { KeyClaimManager } from "../../../src/rust-crypto/KeyClaimManager";
import { defer } from "../../../src/utils";
import { OutgoingRequestsManager } from "../../../src/rust-crypto/OutgoingRequestsManager";
import { KnownMembership } from "../../../src/@types/membership";
import { DeviceIsolationMode, AllDevicesIsolationMode, OnlySignedDevicesIsolationMode } from "../../../src/crypto-api";

describe("RoomEncryptor", () => {
    describe("History Visibility", () => {
        it.each([
            [HistoryVisibility.Invited, RustHistoryVisibility.Invited],
            [HistoryVisibility.Joined, RustHistoryVisibility.Joined],
            [HistoryVisibility.Shared, RustHistoryVisibility.Shared],
            [HistoryVisibility.WorldReadable, RustHistoryVisibility.WorldReadable],
        ])("JS HistoryVisibility to Rust HistoryVisibility: converts %s to %s", (historyVisibility, expected) => {
            expect(toRustHistoryVisibility(historyVisibility)).toBe(expected);
        });
    });

    describe("RoomEncryptor", () => {
        /** The room encryptor under test */
        let roomEncryptor: RoomEncryptor;

        let mockOlmMachine: Mocked<OlmMachine>;
        let mockKeyClaimManager: Mocked<KeyClaimManager>;
        let mockOutgoingRequestManager: Mocked<OutgoingRequestsManager>;
        let mockRoom: Mocked<Room>;

        const mockRoomMember = {
            userId: "@alice:example.org",
            membership: KnownMembership.Join,
        } as unknown as Mocked<RoomMember>;

        function createMockEvent(text: string): Mocked<MatrixEvent> {
            return {
                getTxnId: jest.fn().mockReturnValue(""),
                getType: jest.fn().mockReturnValue("m.room.message"),
                getContent: jest.fn().mockReturnValue({
                    body: text,
                    msgtype: "m.text",
                }),
                makeEncrypted: jest.fn().mockReturnValue(undefined),
            } as unknown as Mocked<MatrixEvent>;
        }

        beforeEach(() => {
            mockOlmMachine = {
                identityKeys: {
                    curve25519: {
                        toBase64: jest.fn().mockReturnValue("curve25519"),
                    } as unknown as Curve25519PublicKey,
                    ed25519: {
                        toBase64: jest.fn().mockReturnValue("ed25519"),
                    } as unknown as Ed25519PublicKey,
                } as unknown as Mocked<IdentityKeys>,
                shareRoomKey: jest.fn(),
                updateTrackedUsers: jest.fn().mockResolvedValue(undefined),
                encryptRoomEvent: jest.fn().mockResolvedValue("{}"),
            } as unknown as Mocked<OlmMachine>;

            mockKeyClaimManager = {
                ensureSessionsForUsers: jest.fn(),
            } as unknown as Mocked<KeyClaimManager>;

            mockOutgoingRequestManager = {
                doProcessOutgoingRequests: jest.fn().mockResolvedValue(undefined),
            } as unknown as Mocked<OutgoingRequestsManager>;

            mockRoom = {
                roomId: "!foo:example.org",
                getJoinedMembers: jest.fn().mockReturnValue([mockRoomMember]),
                getEncryptionTargetMembers: jest.fn().mockReturnValue([mockRoomMember]),
                shouldEncryptForInvitedMembers: jest.fn().mockReturnValue(true),
                getHistoryVisibility: jest.fn().mockReturnValue(HistoryVisibility.Invited),
                getBlacklistUnverifiedDevices: jest.fn().mockReturnValue(null),
            } as unknown as Mocked<Room>;

            roomEncryptor = new RoomEncryptor(
                mockOlmMachine,
                mockKeyClaimManager,
                mockOutgoingRequestManager,
                mockRoom,
                { algorithm: "m.megolm.v1.aes-sha2" },
            );
        });

        const defaultDevicesIsolationMode = new AllDevicesIsolationMode(false);

        it("should ensure that there is only one shareRoomKey at a time", async () => {
            const deferredShare = defer<void>();
            const insideOlmShareRoom = defer<void>();

            mockOlmMachine.shareRoomKey.mockImplementationOnce(async () => {
                insideOlmShareRoom.resolve();
                await deferredShare.promise;
            });

            roomEncryptor.prepareForEncryption(false, defaultDevicesIsolationMode);
            await insideOlmShareRoom.promise;

            // call several times more
            roomEncryptor.prepareForEncryption(false, defaultDevicesIsolationMode);
            roomEncryptor.encryptEvent(createMockEvent("Hello"), false, defaultDevicesIsolationMode);
            roomEncryptor.prepareForEncryption(false, defaultDevicesIsolationMode);
            roomEncryptor.encryptEvent(createMockEvent("World"), false, defaultDevicesIsolationMode);

            expect(mockOlmMachine.shareRoomKey).toHaveBeenCalledTimes(1);

            deferredShare.resolve();
            await roomEncryptor.prepareForEncryption(false, defaultDevicesIsolationMode);

            // should have been called again
            expect(mockOlmMachine.shareRoomKey).toHaveBeenCalledTimes(6);
        });

        // Regression test for https://github.com/element-hq/element-web/issues/26684
        it("Should maintain order of encryption requests", async () => {
            const firstTargetMembers = defer<void>();
            const secondTargetMembers = defer<void>();

            mockOlmMachine.shareRoomKey.mockResolvedValue(undefined);

            // Hook into this method to demonstrate the race condition
            mockRoom.getEncryptionTargetMembers
                .mockImplementationOnce(async () => {
                    await firstTargetMembers.promise;
                    return [mockRoomMember];
                })
                .mockImplementationOnce(async () => {
                    await secondTargetMembers.promise;
                    return [mockRoomMember];
                });

            let firstMessageFinished: string | null = null;

            const firstRequest = roomEncryptor.encryptEvent(
                createMockEvent("Hello"),
                false,
                defaultDevicesIsolationMode,
            );
            const secondRequest = roomEncryptor.encryptEvent(
                createMockEvent("Edit of Hello"),
                false,
                defaultDevicesIsolationMode,
            );

            firstRequest.then(() => {
                if (firstMessageFinished === null) {
                    firstMessageFinished = "hello";
                }
            });

            secondRequest.then(() => {
                if (firstMessageFinished === null) {
                    firstMessageFinished = "edit";
                }
            });

            // suppose the second getEncryptionTargetMembers call returns first
            secondTargetMembers.resolve();
            firstTargetMembers.resolve();

            await Promise.all([firstRequest, secondRequest]);

            expect(firstMessageFinished).toBe("hello");
        });

        describe("DeviceIsolationMode", () => {
            type TestCase = [
                string,
                {
                    mode: DeviceIsolationMode;
                    expectedStrategy: CollectStrategy;
                    globalBlacklistUnverifiedDevices: boolean;
                },
            ];

            const testCases: TestCase[] = [
                [
                    "Share AllDevicesIsolationMode",
                    {
                        mode: new AllDevicesIsolationMode(false),
                        expectedStrategy: CollectStrategy.deviceBasedStrategy(false, false),
                        globalBlacklistUnverifiedDevices: false,
                    },
                ],
                [
                    "Share AllDevicesIsolationMode - with blacklist unverified",
                    {
                        mode: new AllDevicesIsolationMode(false),
                        expectedStrategy: CollectStrategy.deviceBasedStrategy(true, false),
                        globalBlacklistUnverifiedDevices: true,
                    },
                ],
                [
                    "Share OnlySigned - blacklist true",
                    {
                        mode: new OnlySignedDevicesIsolationMode(),
                        expectedStrategy: CollectStrategy.identityBasedStrategy(),
                        globalBlacklistUnverifiedDevices: true,
                    },
                ],
                [
                    "Share OnlySigned",
                    {
                        mode: new OnlySignedDevicesIsolationMode(),
                        expectedStrategy: CollectStrategy.identityBasedStrategy(),
                        globalBlacklistUnverifiedDevices: false,
                    },
                ],
                [
                    "Share AllDevicesIsolationMode - Verified user problems true",
                    {
                        mode: new AllDevicesIsolationMode(true),
                        expectedStrategy: CollectStrategy.deviceBasedStrategy(false, true),
                        globalBlacklistUnverifiedDevices: false,
                    },
                ],
                [
                    'Share AllDevicesIsolationMode - with blacklist unverified - Verified user problems true"',
                    {
                        mode: new AllDevicesIsolationMode(true),
                        expectedStrategy: CollectStrategy.deviceBasedStrategy(true, true),
                        globalBlacklistUnverifiedDevices: true,
                    },
                ],
            ];

            let capturedSettings: CollectStrategy | undefined = undefined;

            beforeEach(() => {
                capturedSettings = undefined;
                mockOlmMachine.shareRoomKey.mockImplementationOnce(async (roomId, users, encryptionSettings) => {
                    capturedSettings = encryptionSettings.sharingStrategy;
                });
            });

            it.each(testCases)(
                "prepareForEncryption should properly set sharing strategy based on crypto mode: %s",
                async (_, { mode, expectedStrategy, globalBlacklistUnverifiedDevices }) => {
                    await roomEncryptor.prepareForEncryption(globalBlacklistUnverifiedDevices, mode);
                    expect(mockOlmMachine.shareRoomKey).toHaveBeenCalled();
                    expect(capturedSettings).toBeDefined();
                    expect(expectedStrategy.eq(capturedSettings!)).toBeTruthy();
                },
            );

            it.each(testCases)(
                "encryptEvent should properly set sharing strategy based on crypto mode: %s",
                async (_, { mode, expectedStrategy, globalBlacklistUnverifiedDevices }) => {
                    await roomEncryptor.encryptEvent(createMockEvent("Hello"), globalBlacklistUnverifiedDevices, mode);
                    expect(mockOlmMachine.shareRoomKey).toHaveBeenCalled();
                    expect(capturedSettings).toBeDefined();
                    expect(expectedStrategy.eq(capturedSettings!)).toBeTruthy();
                },
            );
        });
    });
});
