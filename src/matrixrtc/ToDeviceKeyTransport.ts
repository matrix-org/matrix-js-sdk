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
import { type EncryptionKeysToDeviceEventContent, type ParticipantDeviceInfo, type Statistics } from "./types.ts";
import { ClientEvent, type MatrixClient } from "../client.ts";
import type { MatrixEvent } from "../models/event.ts";
import { EventType } from "../@types/event.ts";

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
        private userId: string,
        private deviceId: string,
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

    public async sendKey(keyBase64Encoded: string, index: number, members: ParticipantDeviceInfo[]): Promise<void> {
        const content: EncryptionKeysToDeviceEventContent = {
            keys: {
                index: index,
                key: keyBase64Encoded,
            },
            room_id: this.roomId,
            member: {
                claimed_device_id: this.deviceId,
            },
            session: {
                call_id: "",
                application: "m.call",
                scope: "m.room",
            },
            sent_ts: Date.now(),
        };

        const targets = members
            .map((member) => {
                return {
                    userId: member.userId!,
                    deviceId: member.deviceId!,
                };
            })
            // filter out me
            .filter((member) => !(member.userId == this.userId && member.deviceId == this.deviceId));

        if (targets.length > 0) {
            await this.client
                .encryptAndSendToDevice(EventType.CallEncryptionKeysPrefix, targets, content)
                .catch((error: WidgetApiResponseError) => {
                    const msg: string = error.message;
                    // This is not ideal. We would want to have a custom error type for unsupported actions.
                    // This is not part of the widget API spec. Since as of now there are only two implementations:
                    // Rust SDK + JS-SDK, and the JS-SDK does support to-device sending, we can assume that
                    // this is a widget driver issue error message.
                    if (
                        (msg.includes("unknown variant") && msg.includes("send_to_device")) ||
                        msg.includes("not supported")
                    ) {
                        throw new NotSupportedError("The widget driver does not support to-device encryption");
                    }
                });
            this.statistics.counters.roomEventEncryptionKeysSent += 1;
        } else {
            this.logger.warn("No targets found for sending key");
        }
    }

    private receiveCallKeyEvent(fromUser: string, content: EncryptionKeysToDeviceEventContent): void {
        // The event has already been validated at this point.

        this.statistics.counters.roomEventEncryptionKeysReceived += 1;

        // What is this, and why is it needed?
        // Also to device events do not have an origin server ts
        const now = Date.now();
        const age = now - (typeof content.sent_ts === "number" ? content.sent_ts : now);
        this.statistics.totals.roomEventEncryptionKeysReceivedTotalAge += age;

        this.emit(
            KeyTransportEvents.ReceivedKeys,
            // TODO this is claimed information
            fromUser,
            // TODO: This is claimed information
            content.member.claimed_device_id!,
            content.keys.key,
            content.keys.index,
            now,
        );
    }

    private onToDeviceEvent = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.CallEncryptionKeysPrefix) {
            // Ignore this is not a call encryption event
            return;
        }

        // TODO: Not possible to check if the event is encrypted or not
        // see https://github.com/matrix-org/matrix-rust-sdk/issues/4883
        // if (evnt.getWireType() != EventType.RoomMessageEncrypted) {
        //     // WARN: The call keys were sent in clear. Ignore them
        //     logger.warn(`Call encryption keys sent in clear from: ${event.getSender()}`);
        //     return;
        // }

        const content = this.getValidEventContent(event);
        if (!content) return;

        if (!event.getSender()) return;

        this.receiveCallKeyEvent(event.getSender()!, content);
    };

    private getValidEventContent(event: MatrixEvent): EncryptionKeysToDeviceEventContent | undefined {
        const content = event.getContent();
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

        if (!content.keys || !content.keys.key || typeof content.keys.index !== "number") {
            this.logger.warn("Malformed Event: Missing keys field");
            return;
        }

        if (!content.member || !content.member.claimed_device_id) {
            this.logger.warn("Malformed Event: Missing claimed_device_id");
            return;
        }

        // TODO check for session related fields once the to-device encryption uses the new format.
        return content as EncryptionKeysToDeviceEventContent;
    }
}
