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

import { describe, beforeEach, it, expect, vi, type Mocked } from "vitest";

import {
    ClientEvent,
    EventType,
    type ICreateClientOpts,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent,
    RoomMember,
    RoomMemberEvent,
} from "../../src";
import { KnownMembership, type Membership } from "../../src/@types/membership";
import { type CryptoBackend } from "../../src/common-crypto/CryptoBackend";
import { flushPromises } from "../test-utils/flushPromises";

const userId = "@alice:example.org";
const inviter = "@bob:example.org";
const roomId = "!room:example.org";

describe("MatrixClient key bundles for server-initiated joins", () => {
    let client: MatrixClient;
    let mockCrypto: Mocked<CryptoBackend>;

    function makeClient(opts: Partial<ICreateClientOpts> = {}): void {
        client = new MatrixClient({
            baseUrl: "https://test.example.org",
            userId,
            accessToken: "token",
            fetchFn: vi.fn(),
            ...opts,
        });
        mockCrypto = {
            markRoomAsPendingKeyBundle: vi.fn().mockResolvedValue(undefined),
            maybeAcceptKeyBundle: vi.fn().mockResolvedValue(undefined),
        } as unknown as Mocked<CryptoBackend>;
        client["cryptoBackend"] = mockCrypto;
    }

    function emitMembership(
        membership: Membership,
        oldMembership: Membership,
        { sender = inviter, unsigned = {} }: { sender?: string; unsigned?: object } = {},
    ): void {
        const event = new MatrixEvent({
            type: EventType.RoomMember,
            room_id: roomId,
            state_key: userId,
            sender,
            content: { membership },
            unsigned,
        });
        const member = new RoomMember(roomId, userId);
        member.membership = membership;
        client.emit(RoomMemberEvent.Membership, event, member, oldMembership);
    }

    function emitClaim(claimRoomId: unknown, sender = userId): void {
        client.emit(
            ClientEvent.ToDeviceEvent,
            new MatrixEvent({
                type: "org.matrix.msc4509.key_bundle_claim",
                sender,
                content: { room_id: claimRoomId as string },
            }),
        );
    }

    describe("with MSC4509 disabled (the default)", () => {
        beforeEach(() => {
            makeClient();
        });

        it("eagerly accepts the key bundle on an invite -> join transition", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();
            expect(mockCrypto.markRoomAsPendingKeyBundle).toHaveBeenCalledWith(roomId, inviter);
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledWith(roomId, inviter);
        });

        it("recovers the inviter from unsigned.prev_sender when the invite was not seen", async () => {
            emitMembership(KnownMembership.Join, KnownMembership.Invite, {
                sender: userId,
                unsigned: { prev_content: { membership: KnownMembership.Invite }, prev_sender: inviter },
            });
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledWith(roomId, inviter);
        });

        it("ignores key_bundle_claim to-device messages", async () => {
            emitClaim(roomId);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();
        });

        it("logs rather than throwing when accepting the bundle fails", async () => {
            const loggerError = vi.spyOn(client["logger"], "error").mockImplementation(() => {});
            mockCrypto.maybeAcceptKeyBundle.mockRejectedValue(new Error("nope"));
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();
            expect(loggerError).toHaveBeenCalledWith(expect.stringContaining(roomId), expect.any(Error));
        });
    });

    describe("with MSC4509 enabled", () => {
        beforeEach(() => {
            makeClient({ unstableMSC4509KeyBundleClaim: true });
        });

        it("defers the key bundle on a knock -> join transition until designated", async () => {
            // An accepted knock can be auto-joined straight past the invited state, with the
            // invite coalesced away: the join's prev_content carries the invite.
            emitMembership(KnownMembership.Join, KnownMembership.Knock, {
                sender: userId,
                unsigned: { prev_content: { membership: KnownMembership.Invite }, prev_sender: inviter },
            });
            await flushPromises();
            expect(mockCrypto.markRoomAsPendingKeyBundle).toHaveBeenCalledWith(roomId, inviter);
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();

            emitClaim(roomId);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledWith(roomId, inviter);
        });

        it("accepts at join time when the designation raced ahead of the join", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitClaim(roomId);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();

            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledWith(roomId, inviter);
        });

        it("claims the deferred bundle upon an undecryptable event in the room", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();

            const undecryptable = new MatrixEvent({
                type: EventType.RoomMessageEncrypted,
                room_id: roomId,
                event_id: "$undecryptable",
                sender: inviter,
            });
            vi.spyOn(undecryptable, "isDecryptionFailure").mockReturnValue(true);
            client.emit(MatrixEventEvent.Decrypted, undecryptable);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledWith(roomId, inviter);
            // A second undecryptable event should not claim again.
            client.emit(MatrixEventEvent.Decrypted, undecryptable);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).toHaveBeenCalledTimes(1);
        });

        it("only trusts designations from our own user with a valid room_id", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();

            emitClaim(roomId, "@mallory:example.org");
            emitClaim(undefined);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();
        });

        it("does nothing on designation if the crypto backend has gone away", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();

            client["cryptoBackend"] = undefined;
            emitClaim(roomId);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();
        });

        it("logs rather than throwing when the deferred claim fails", async () => {
            const loggerError = vi.spyOn(client["logger"], "error").mockImplementation(() => {});
            mockCrypto.maybeAcceptKeyBundle.mockRejectedValue(new Error("nope"));
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();

            emitClaim(roomId);
            await flushPromises();
            expect(loggerError).toHaveBeenCalledWith(expect.stringContaining(roomId), expect.any(Error));
        });

        it("forgets the deferred bundle when we leave the room", async () => {
            emitMembership(KnownMembership.Invite, KnownMembership.Leave);
            emitMembership(KnownMembership.Join, KnownMembership.Invite, { sender: userId });
            await flushPromises();

            emitMembership(KnownMembership.Leave, KnownMembership.Join, { sender: userId });
            emitClaim(roomId);
            await flushPromises();
            expect(mockCrypto.maybeAcceptKeyBundle).not.toHaveBeenCalled();
        });
    });
});
