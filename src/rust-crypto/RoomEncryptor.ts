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

import { EncryptionSettings, OlmMachine, RoomId, UserId } from "@matrix-org/matrix-sdk-crypto-wasm";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { EventType } from "../@types/event";
import { IContent, MatrixEvent } from "../models/event";
import { Room } from "../models/room";
import { Logger, logger } from "../logger";
import { KeyClaimManager } from "./KeyClaimManager";
import { RoomMember } from "../models/room-member";
import { OutgoingRequestsManager } from "./OutgoingRequestsManager";

/**
 * RoomEncryptor: responsible for encrypting messages to a given room
 *
 * @internal
 */
export class RoomEncryptor {
    private readonly prefixedLogger: Logger;

    /** whether the room members have been loaded and tracked for the first time */
    private lazyLoadedMembersResolved = false;

    /**
     * @param olmMachine - The rust-sdk's OlmMachine
     * @param keyClaimManager - Our KeyClaimManager, which manages the queue of one-time-key claim requests
     * @param outgoingRequestManager - The OutgoingRequestManager, which manages the queue of outgoing requests.
     * @param room - The room we want to encrypt for
     * @param encryptionSettings - body of the m.room.encryption event currently in force in this room
     */
    public constructor(
        private readonly olmMachine: OlmMachine,
        private readonly keyClaimManager: KeyClaimManager,
        private readonly outgoingRequestManager: OutgoingRequestsManager,
        private readonly room: Room,
        private encryptionSettings: IContent,
    ) {
        this.prefixedLogger = logger.getChild(`[${room.roomId} encryption]`);

        // start tracking devices for any users already known to be in this room.
        // Do not load members here, would defeat lazy loading.
        const members = room.getJoinedMembers();
        // At this point just mark the known members as tracked, it might not be the full list of members
        // because of lazy loading. This is fine, because we will get a member list update when sending a message for
        // the first time, see `RoomEncryptor#ensureEncryptionSession`
        this.olmMachine.updateTrackedUsers(members.map((u) => new RustSdkCryptoJs.UserId(u.userId))).then(() => {
            this.prefixedLogger.debug(`Updated tracked users for room ${room.roomId}`);
        });
    }

    /**
     * Handle a new `m.room.encryption` event in this room
     *
     * @param config - The content of the encryption event
     */
    public onCryptoEvent(config: IContent): void {
        if (JSON.stringify(this.encryptionSettings) != JSON.stringify(config)) {
            this.prefixedLogger.error(`Ignoring m.room.encryption event which requests a change of config`);
        }
    }

    /**
     * Handle a new `m.room.member` event in this room
     *
     * @param member - new membership state
     */
    public onRoomMembership(member: RoomMember): void {
        if (
            member.membership == "join" ||
            (member.membership == "invite" && this.room.shouldEncryptForInvitedMembers())
        ) {
            // make sure we are tracking the deviceList for this user
            this.olmMachine.updateTrackedUsers([new UserId(member.userId)]).catch((e) => {
                this.prefixedLogger.error("Unable to update tracked users", e);
            });
        }

        // TODO: handle leaves (including our own)
    }

    /**
     * Prepare to encrypt events in this room.
     *
     * This ensures that we have a megolm session ready to use and that we have shared its key with all the devices
     * in the room.
     */
    public async ensureEncryptionSession(): Promise<void> {
        if (this.encryptionSettings.algorithm !== "m.megolm.v1.aes-sha2") {
            throw new Error(
                `Cannot encrypt in ${this.room.roomId} for unsupported algorithm '${this.encryptionSettings.algorithm}'`,
            );
        }

        // Manually call `loadMembersIfNeeded` here, because we want to know if it's the first
        // time the room is loaded (due to lazy loading), so we can update the tracked users.
        const fromServer = await this.room.loadMembersIfNeeded();
        const members = await this.room.getEncryptionTargetMembers();

        if (fromServer && !this.lazyLoadedMembersResolved) {
            // It's the first time the room is loaded, so we need to update the tracked users
            await this.olmMachine.updateTrackedUsers(members.map((u) => new RustSdkCryptoJs.UserId(u.userId)));
            this.lazyLoadedMembersResolved = true;
            this.prefixedLogger.debug(`Updated tracked users for room ${this.room.roomId}`);
        }

        // Query keys in case we don't have them for newly tracked members.
        // This must be done before ensuring sessions. If not the devices of these users are not
        // known yet and will not get the room key.
        // We don't have API to only get the keys queries related to this member list, so we just
        // process the pending requests from the olmMachine. (usually these are processed
        // at the end of the sync, but we can't wait for that).
        // XXX future improvement process only KeysQueryRequests for the tracked users.
        await this.outgoingRequestManager.requestLoop();

        this.prefixedLogger.debug(
            `Encrypting for users (shouldEncryptForInvitedMembers: ${this.room.shouldEncryptForInvitedMembers()}):`,
            members.map((u) => `${u.userId} (${u.membership})`),
        );

        const userList = members.map((u) => new UserId(u.userId));
        await this.keyClaimManager.ensureSessionsForUsers(userList);

        this.prefixedLogger.debug("Sessions for users are ready; now sharing room key");

        const rustEncryptionSettings = new EncryptionSettings();
        /* FIXME historyVisibility, rotation, etc */

        const shareMessages = await this.olmMachine.shareRoomKey(
            new RoomId(this.room.roomId),
            userList,
            rustEncryptionSettings,
        );
        if (shareMessages) {
            for (const m of shareMessages) {
                await this.outgoingRequestManager.outgoingRequestProcessor.makeOutgoingRequest(m);
            }
        }
    }

    /**
     * Discard any existing group session for this room
     */
    public async forceDiscardSession(): Promise<void> {
        const r = await this.olmMachine.invalidateGroupSession(new RoomId(this.room.roomId));
        if (r) {
            this.prefixedLogger.info("Discarded existing group session");
        }
    }

    /**
     * Encrypt an event for this room
     *
     * This will ensure that we have a megolm session for this room, share it with the devices in the room, and
     * then encrypt the event using the session.
     *
     * @param event - Event to be encrypted.
     */
    public async encryptEvent(event: MatrixEvent): Promise<void> {
        await this.ensureEncryptionSession();

        const encryptedContent = await this.olmMachine.encryptRoomEvent(
            new RoomId(this.room.roomId),
            event.getType(),
            JSON.stringify(event.getContent()),
        );

        event.makeEncrypted(
            EventType.RoomMessageEncrypted,
            JSON.parse(encryptedContent),
            this.olmMachine.identityKeys.curve25519.toBase64(),
            this.olmMachine.identityKeys.ed25519.toBase64(),
        );
    }
}
