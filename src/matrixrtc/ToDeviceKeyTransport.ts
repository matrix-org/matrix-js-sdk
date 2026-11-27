/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { type WidgetApiResponseError } from "matrix-widget-api";

import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { type IKeyTransport, KeyTransportEvents, type KeyTransportEventsHandlerMap } from "./IKeyTransport.ts";
import { type Logger, logger as rootLogger } from "../logger.ts";
import {
    type EncryptionKeysToDeviceEventContent,
    type ParticipantDeviceInfo,
    type RTCEncryptionKeyMediaKey,
    type RTCEncryptionKeyToDeviceEventContent,
    type Statistics,
} from "./types.ts";
import { ClientEvent, type MatrixClient } from "../client.ts";
import type { MatrixEvent } from "../models/event.ts";
import { EventType } from "../@types/event.ts";
import { type CallMembershipIdentityParts } from "./EncryptionManager.ts";

/**
 * The information extracted from a validated key event.
 */
interface ReceivedKey {
    mediaKey: RTCEncryptionKeyMediaKey;
    memberId?: string;
    deviceId: string;
}

/** A device that a key event is sent to. */
interface ToDeviceTarget {
    userId: string;
    deviceId: string;
}

/** Returns the given value as a media key if it is a valid one, otherwise `undefined`. */
function parseMediaKey(mediaKey: unknown): RTCEncryptionKeyMediaKey | undefined {
    if (typeof mediaKey !== "object" || mediaKey === null) return undefined;
    const { key, index } = mediaKey as Partial<RTCEncryptionKeyMediaKey>;
    if (typeof key !== "string" || key === "" || typeof index !== "number") return undefined;
    return mediaKey as RTCEncryptionKeyMediaKey;
}

export class NotSupportedError extends Error {
    public constructor(message?: string) {
        super(message);
    }
    public get name(): string {
        return "NotSupportedError";
    }
}
/**
 * ToDeviceKeyTransport is used to send MatrixRTC keys to other devices using the
 * to-device CS-API.
 */
export class ToDeviceKeyTransport
    extends TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>
    implements IKeyTransport
{
    private logger: Logger = rootLogger;

    public setParentLogger(parentLogger: Logger): void {
        this.logger = parentLogger.getChild(`[ToDeviceKeyTransport]`);
    }

    public constructor(
        private membership: CallMembershipIdentityParts,
        private roomId: string,
        private client: Pick<MatrixClient, "encryptAndSendToDevice" | "on" | "off">,
        private statistics: Statistics,
        parentLogger?: Logger,
    ) {
        super();
        this.setParentLogger(parentLogger ?? rootLogger);
    }

    public start(): void {
        this.client.on(ClientEvent.ToDeviceEvent, this.onToDeviceEvent);
    }

    public stop(): void {
        this.client.off(ClientEvent.ToDeviceEvent, this.onToDeviceEvent);
    }

    /**
     * Sends the key to the given members, excluding ourselves.
     *
     * Members that use sticky events receive the stable {@link EventType.RTCEncryptionKey} event. Members that
     * use state events receive the legacy {@link EventType.CallEncryptionKeysPrefix} event.
     */
    public async sendKey(keyBase64Encoded: string, index: number, members: ParticipantDeviceInfo[]): Promise<void> {
        const mediaKey: RTCEncryptionKeyMediaKey = {
            index: index,
            key: keyBase64Encoded,
        };
        const stableContent: RTCEncryptionKeyToDeviceEventContent = {
            room_id: this.roomId,
            member_id: this.membership.memberId,
            media_key: mediaKey,
            member: {
                claimed_device_id: this.membership.deviceId,
            },
        };
        const legacyContent: EncryptionKeysToDeviceEventContent = {
            room_id: this.roomId,
            member_id: this.membership.memberId,
            media_key: mediaKey,
            // Deprecated but still sent for backwards compatibility.
            keys: mediaKey,
            member: {
                claimed_device_id: this.membership.deviceId,
                // Deprecated but still sent for backwards compatibility.
                id: this.membership.memberId,
            },
        };

        const stableTargets: ToDeviceTarget[] = [];
        const legacyTargets: ToDeviceTarget[] = [];
        for (const member of members) {
            // filter out me
            if (member.userId == this.membership.userId && member.deviceId == this.membership.deviceId) continue;
            const target = { userId: member.userId, deviceId: member.deviceId };
            if (member.isStickyMembership) {
                stableTargets.push(target);
            } else {
                legacyTargets.push(target);
            }
        }

        if (stableTargets.length === 0 && legacyTargets.length === 0) {
            this.logger.warn("No targets found for sending key");
            return;
        }

        const sends: Promise<void>[] = [];
        if (legacyTargets.length > 0) {
            sends.push(this.encryptAndSendToDevice(EventType.CallEncryptionKeysPrefix, legacyTargets, legacyContent));
        }
        if (stableTargets.length > 0) {
            sends.push(this.encryptAndSendToDevice(EventType.RTCEncryptionKey, stableTargets, stableContent));
        }
        await Promise.all(sends);
        this.statistics.counters.roomEventEncryptionKeysSent += 1;
    }

    private async encryptAndSendToDevice(
        eventType: EventType.CallEncryptionKeysPrefix | EventType.RTCEncryptionKey,
        targets: ToDeviceTarget[],
        content: RTCEncryptionKeyToDeviceEventContent | EncryptionKeysToDeviceEventContent,
    ): Promise<void> {
        await this.client.encryptAndSendToDevice(eventType, targets, content).catch((error: WidgetApiResponseError) => {
            const msg: string = error.message;
            // This is not ideal. We would want to have a custom error type for unsupported actions.
            // This is not part of the widget API spec. Since as of now there are only two implementations:
            // Rust SDK + JS-SDK, and the JS-SDK does support to-device sending, we can assume that
            // this is a widget driver issue error message.
            //
            // This can only be resolved once Element Call stops relying on widgets. See
            // https://github.com/element-hq/element-call/issues/4468 for further details.
            if ((msg.includes("unknown variant") && msg.includes("send_to_device")) || msg.includes("not supported")) {
                throw new NotSupportedError("The widget driver does not support to-device encryption");
            }
            this.logger.warn(`Failed to send ${eventType} to ${targets.length} target(s): ${msg}`);
        });
    }

    private receiveCallKeyEvent(fromUser: string, { mediaKey, memberId, deviceId }: ReceivedKey): void {
        // The event has already been validated at this point.

        this.statistics.counters.roomEventEncryptionKeysReceived += 1;

        this.emit(
            KeyTransportEvents.ReceivedKeys,
            // TODO userId this is claimed information, deviceId is claimed information
            {
                userId: fromUser,
                deviceId,
                memberId: memberId ?? `${fromUser}:${deviceId}`,
            },
            mediaKey.key,
            mediaKey.index,
            Date.now(),
        );
    }

    private onToDeviceEvent = (event: MatrixEvent): void => {
        const eventType = event.getType();
        if (eventType !== EventType.RTCEncryptionKey && eventType !== EventType.CallEncryptionKeysPrefix) {
            // Ignore this is not a call encryption event
            return;
        }

        // NB: When received via the widget driver, the to-device events
        // are properly reconstructed as if they are encrypted (see MatrixEvent#makeEncrypted).
        if (event.getWireType() != EventType.RoomMessageEncrypted) {
            // WARN: The call keys were sent in clear. Ignore them
            this.logger.warn(`Call encryption keys sent in clear from: ${event.getSender()}`);
            return;
        }

        const receivedKey = this.getValidEventContent(event);
        if (!receivedKey) return;

        if (!event.getSender()) return;

        this.receiveCallKeyEvent(event.getSender()!, receivedKey);
    };

    /** Validates a received key event and extracts the key information from it. */
    private getValidEventContent(event: MatrixEvent): ReceivedKey | undefined {
        const isStable = event.getType() === EventType.RTCEncryptionKey;
        const content = event.getContent<Partial<EncryptionKeysToDeviceEventContent>>();
        const roomId = content.room_id;
        if (!roomId) {
            // Invalid event
            this.logger.warn("Malformed Event: invalid call encryption keys event, no roomId");
            return;
        }
        if (roomId !== this.roomId) {
            this.logger.warn("Malformed Event: Mismatch roomId");
            return;
        }

        // The stable event only carries `media_key`. For the legacy event, prefer `media_key` and fall back to
        // the deprecated `keys` property for backwards compatibility.
        const mediaKey = parseMediaKey(content.media_key) ?? (isStable ? undefined : parseMediaKey(content.keys));
        if (!mediaKey) {
            this.logger.warn("Malformed Event: Missing media key");
            return;
        }

        // The stable event requires `member_id`. For the legacy event, prefer `member_id` and fall back to the
        // deprecated `member.id` property for backwards compatibility.
        const memberId = content.member_id ?? (isStable ? undefined : content.member?.id);
        if (isStable && memberId === undefined) {
            this.logger.warn("Malformed Event: Missing member id");
            return;
        }
        if (memberId !== undefined && typeof memberId !== "string") {
            this.logger.warn("Malformed Event: Invalid member id");
            return;
        }

        const deviceId = content.member?.claimed_device_id;
        if (!deviceId || typeof deviceId !== "string") {
            this.logger.warn("Malformed Event: Missing claimed_device_id");
            return;
        }

        return { mediaKey, memberId, deviceId };
    }
}
