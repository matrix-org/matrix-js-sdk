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

import type { MatrixClient } from "../client.ts";
import { type EncryptionKeysEventContent, type ParticipantDeviceInfo, type Statistics } from "./types.ts";
import { EventType } from "../@types/event.ts";
import { type MatrixError } from "../http-api/errors.ts";
import { logger as rootLogger, type Logger } from "../logger.ts";
import { KeyTransportEvents, type KeyTransportEventsHandlerMap, type IKeyTransport } from "./IKeyTransport.ts";
import { type MatrixEvent } from "../models/event.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { type Room, RoomEvent } from "../models/room.ts";

export class RoomKeyTransport
    extends TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>
    implements IKeyTransport
{
    private logger: Logger = rootLogger;
    public setParentLogger(parentLogger: Logger): void {
        this.logger = parentLogger.getChild(`[RoomKeyTransport]`);
    }
    public constructor(
        private room: Pick<Room, "on" | "off" | "roomId">,
        private client: Pick<
            MatrixClient,
            "sendEvent" | "getDeviceId" | "getUserId" | "cancelPendingEvent" | "decryptEventIfNeeded"
        >,
        private statistics: Statistics,
        parentLogger?: Logger,
    ) {
        super();
        this.setParentLogger(parentLogger ?? rootLogger);
    }
    public start(): void {
        this.room.on(RoomEvent.Timeline, (ev) => void this.consumeCallEncryptionEvent(ev));
    }
    public stop(): void {
        this.room.off(RoomEvent.Timeline, (ev) => void this.consumeCallEncryptionEvent(ev));
    }

    private async consumeCallEncryptionEvent(event: MatrixEvent, isRetry = false): Promise<void> {
        await this.client.decryptEventIfNeeded(event);

        if (event.isDecryptionFailure()) {
            if (!isRetry) {
                this.logger.warn(
                    `Decryption failed for event ${event.getId()}: ${event.decryptionFailureReason} will retry once only`,
                );
                // retry after 1 second. After this we give up.
                setTimeout(() => void this.consumeCallEncryptionEvent(event, true), 1000);
            } else {
                this.logger.warn(`Decryption failed for event ${event.getId()}: ${event.decryptionFailureReason}`);
            }
            return;
        } else if (isRetry) {
            this.logger.info(`Decryption succeeded for event ${event.getId()} after retry`);
        }

        if (event.getType() !== EventType.CallEncryptionKeysPrefix) return Promise.resolve();

        if (!this.room) {
            this.logger.error(`Got room state event for unknown room ${event.getRoomId()}!`);
            return Promise.resolve();
        }

        this.onEncryptionEvent(event);
    }

    /** implements {@link IKeyTransport#sendKey} */
    public async sendKey(keyBase64Encoded: string, index: number, members: ParticipantDeviceInfo[]): Promise<void> {
        // members not used in room transports as the keys are sent to all room members
        const content: EncryptionKeysEventContent = {
            keys: [
                {
                    index: index,
                    key: keyBase64Encoded,
                },
            ],
            device_id: this.client.getDeviceId()!,
            call_id: "",
            sent_ts: Date.now(),
        };

        try {
            await this.client.sendEvent(this.room.roomId, EventType.CallEncryptionKeysPrefix, content);
        } catch (error) {
            this.logger.error("Failed to send call encryption keys", error);
            const matrixError = error as MatrixError;
            if (matrixError.event) {
                // cancel the pending event: we'll just generate a new one with our latest
                // keys when we resend
                this.client.cancelPendingEvent(matrixError.event);
            }
            throw error;
        }
    }

    public onEncryptionEvent(event: MatrixEvent): void {
        const userId = event.getSender();
        const content = event.getContent<EncryptionKeysEventContent>();

        const deviceId = content["device_id"];
        const callId = content["call_id"];

        if (!userId) {
            this.logger.warn(`Received m.call.encryption_keys with no userId: callId=${callId}`);
            return;
        }

        // We currently only handle callId = "" (which is the default for room scoped calls)
        if (callId !== "") {
            this.logger.warn(
                `Received m.call.encryption_keys with unsupported callId: userId=${userId}, deviceId=${deviceId}, callId=${callId}`,
            );
            return;
        }

        if (!Array.isArray(content.keys)) {
            this.logger.warn(`Received m.call.encryption_keys where keys wasn't an array: callId=${callId}`);
            return;
        }

        if (userId === this.client.getUserId() && deviceId === this.client.getDeviceId()) {
            // We store our own sender key in the same set along with keys from others, so it's
            // important we don't allow our own keys to be set by one of these events (apart from
            // the fact that we don't need it anyway because we already know our own keys).
            this.logger.info("Ignoring our own keys event");
            return;
        }

        this.statistics.counters.roomEventEncryptionKeysReceived += 1;
        const age = Date.now() - (typeof content.sent_ts === "number" ? content.sent_ts : event.getTs());
        this.statistics.totals.roomEventEncryptionKeysReceivedTotalAge += age;

        for (const key of content.keys) {
            if (!key) {
                this.logger.info("Ignoring false-y key in keys event");
                continue;
            }

            const encryptionKey = key.key;
            const encryptionKeyIndex = key.index;

            if (
                !encryptionKey ||
                encryptionKeyIndex === undefined ||
                encryptionKeyIndex === null ||
                callId === undefined ||
                callId === null ||
                typeof deviceId !== "string" ||
                typeof callId !== "string" ||
                typeof encryptionKey !== "string" ||
                typeof encryptionKeyIndex !== "number"
            ) {
                this.logger.warn(
                    `Malformed call encryption_key: userId=${userId}, deviceId=${deviceId}, encryptionKeyIndex=${encryptionKeyIndex} callId=${callId}`,
                );
            } else {
                this.logger.debug(
                    `onCallEncryption userId=${userId}:${deviceId} encryptionKeyIndex=${encryptionKeyIndex} age=${age}ms`,
                );
                this.emit(
                    KeyTransportEvents.ReceivedKeys,
                    userId,
                    deviceId,
                    encryptionKey,
                    encryptionKeyIndex,
                    event.getTs(),
                );
            }
        }
    }
}
