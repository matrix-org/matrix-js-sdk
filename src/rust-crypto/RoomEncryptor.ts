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

import {
    EncryptionAlgorithm,
    EncryptionSettings,
    OlmMachine,
    RoomId,
    UserId,
    HistoryVisibility as RustHistoryVisibility,
    ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { EventType } from "../@types/event";
import { IContent, MatrixEvent } from "../models/event";
import { Room } from "../models/room";
import { Logger, logger, LogSpan } from "../logger";
import { KeyClaimManager } from "./KeyClaimManager";
import { RoomMember } from "../models/room-member";
import { HistoryVisibility } from "../@types/partials";
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
        this.olmMachine
            .updateTrackedUsers(members.map((u) => new RustSdkCryptoJs.UserId(u.userId)))
            .catch((e) => this.prefixedLogger.error("Error initializing tracked users", e));
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
     *
     * @param globalBlacklistUnverifiedDevices - When `true`, it will not send encrypted messages to unverified devices
     */
    public async prepareForEncryption(globalBlacklistUnverifiedDevices: boolean): Promise<void> {
        const logger = new LogSpan(this.prefixedLogger, "prepareForEncryption");
        await this.ensureEncryptionSession(logger, globalBlacklistUnverifiedDevices);
    }

    /**
     * Prepare to encrypt events in this room.
     *
     * This ensures that we have a megolm session ready to use and that we have shared its key with all the devices
     * in the room.
     *
     * @param logger - a place to write diagnostics to
     * @param globalBlacklistUnverifiedDevices - When `true`, it will not send encrypted messages to unverified devices
     */
    private async ensureEncryptionSession(logger: LogSpan, globalBlacklistUnverifiedDevices: boolean): Promise<void> {
        if (this.encryptionSettings.algorithm !== "m.megolm.v1.aes-sha2") {
            throw new Error(
                `Cannot encrypt in ${this.room.roomId} for unsupported algorithm '${this.encryptionSettings.algorithm}'`,
            );
        }
        logger.debug("Starting encryption");

        const members = await this.room.getEncryptionTargetMembers();

        // If this is the first time we are sending a message to the room, we may not yet have seen all the members
        // (so the Crypto SDK might not have a device list for them). So, if this is the first time we are encrypting
        // for this room, give the SDK the full list of members, to be on the safe side.
        //
        // This could end up being racy (if two calls to ensureEncryptionSession happen at the same time), but that's
        // not a particular problem, since `OlmMachine.updateTrackedUsers` just adds any users that weren't already tracked.
        if (!this.lazyLoadedMembersResolved) {
            await this.olmMachine.updateTrackedUsers(members.map((u) => new RustSdkCryptoJs.UserId(u.userId)));
            logger.debug(`Updated tracked users`);
            this.lazyLoadedMembersResolved = true;

            // Query keys in case we don't have them for newly tracked members.
            // It's important after loading members for the first time, as likely most of them won't be
            // known yet and will be unable to decrypt messages despite being in the room for long.
            // This must be done before ensuring sessions. If not the devices of these users are not
            // known yet and will not get the room key.
            // We don't have API to only get the keys queries related to this member list, so we just
            // process the pending requests from the olmMachine. (usually these are processed
            // at the end of the sync, but we can't wait for that).
            // XXX future improvement process only KeysQueryRequests for the users that have never been queried.
            logger.debug(`Processing outgoing requests`);
            await this.outgoingRequestManager.doProcessOutgoingRequests();
        } else {
            // If members are already loaded it's less critical to await on key queries.
            // We might still want to trigger a processOutgoingRequests here.
            // The call to `ensureSessionsForUsers` below will wait a bit on in-flight key queries we are
            // interested in. If a sync handling happens in the meantime, and some new members are added to the room
            // or have new devices it would give us a chance to query them before sending.
            // It's less critical due to the racy nature of this process.
            logger.debug(`Processing outgoing requests in background`);
            this.outgoingRequestManager.doProcessOutgoingRequests();
        }

        logger.debug(
            `Encrypting for users (shouldEncryptForInvitedMembers: ${this.room.shouldEncryptForInvitedMembers()}):`,
            members.map((u) => `${u.userId} (${u.membership})`),
        );

        const userList = members.map((u) => new UserId(u.userId));
        await this.keyClaimManager.ensureSessionsForUsers(logger, userList);

        const rustEncryptionSettings = new EncryptionSettings();
        rustEncryptionSettings.historyVisibility = toRustHistoryVisibility(this.room.getHistoryVisibility());

        // We only support megolm
        rustEncryptionSettings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;

        // We need to convert the rotation period from milliseconds to microseconds
        // See https://spec.matrix.org/v1.8/client-server-api/#mroomencryption and
        // https://matrix-org.github.io/matrix-rust-sdk-crypto-wasm/classes/EncryptionSettings.html#rotationPeriod
        if (typeof this.encryptionSettings.rotation_period_ms === "number") {
            rustEncryptionSettings.rotationPeriod = BigInt(this.encryptionSettings.rotation_period_ms * 1000);
        }

        if (typeof this.encryptionSettings.rotation_period_msgs === "number") {
            rustEncryptionSettings.rotationPeriodMessages = BigInt(this.encryptionSettings.rotation_period_msgs);
        }

        // When this.room.getBlacklistUnverifiedDevices() === null, the global settings should be used
        // See Room#getBlacklistUnverifiedDevices
        rustEncryptionSettings.onlyAllowTrustedDevices =
            this.room.getBlacklistUnverifiedDevices() ?? globalBlacklistUnverifiedDevices;

        const shareMessages: ToDeviceRequest[] = await this.olmMachine.shareRoomKey(
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
     * @param globalBlacklistUnverifiedDevices - When `true`, it will not send encrypted messages to unverified devices
     */
    public async encryptEvent(event: MatrixEvent, globalBlacklistUnverifiedDevices: boolean): Promise<void> {
        const logger = new LogSpan(this.prefixedLogger, event.getTxnId() ?? "");
        await this.ensureEncryptionSession(logger, globalBlacklistUnverifiedDevices);

        logger.debug("Encrypting actual message content");
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

        logger.debug("Encrypted event successfully");
    }
}

/**
 * Convert a HistoryVisibility to a RustHistoryVisibility
 * @param visibility - HistoryVisibility enum
 * @returns a RustHistoryVisibility enum
 */
export function toRustHistoryVisibility(visibility: HistoryVisibility): RustHistoryVisibility {
    switch (visibility) {
        case HistoryVisibility.Invited:
            return RustHistoryVisibility.Invited;
        case HistoryVisibility.Joined:
            return RustHistoryVisibility.Joined;
        case HistoryVisibility.Shared:
            return RustHistoryVisibility.Shared;
        case HistoryVisibility.WorldReadable:
            return RustHistoryVisibility.WorldReadable;
    }
}
