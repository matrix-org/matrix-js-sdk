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

import { logger as rootLogger, type Logger } from "../logger.ts";
import { KeyTransportEvents, type KeyTransportEventsHandlerMap, type IKeyTransport } from "./IKeyTransport.ts";
import type { RoomKeyTransport } from "./RoomKeyTransport.ts";
import { NotSupportedError, type ToDeviceKeyTransport } from "./ToDeviceKeyTransport.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { type ParticipantDeviceInfo } from "./types.ts";

// Deprecate RoomAndToDeviceTransport: This whole class is only a stop gap until we remove RoomKeyTransport.
export interface EnabledTransports {
    toDevice: boolean;
    room: boolean;
}

export enum RoomAndToDeviceEvents {
    EnabledTransportsChanged = "enabled_transports_changed",
}
export type RoomAndToDeviceEventsHandlerMap = {
    [RoomAndToDeviceEvents.EnabledTransportsChanged]: (enabledTransports: EnabledTransports) => void;
};
/**
 * A custom transport that subscribes to room key events (via `RoomKeyTransport`) and to device key events (via: `ToDeviceKeyTransport`)
 * The public setEnabled method allows to turn one or the other on or off on the fly.
 * It will emit `RoomAndToDeviceEvents.EnabledTransportsChanged` if the enabled transport changes to allow comminitcating this to
 * the user in the ui.
 *
 * Since it will always subscribe to both (room and to device) but only emit for the enabled ones, it can detect
 * if a room key event was received and autoenable it.
 */
export class RoomAndToDeviceTransport
    extends TypedEventEmitter<
        KeyTransportEvents | RoomAndToDeviceEvents,
        KeyTransportEventsHandlerMap & RoomAndToDeviceEventsHandlerMap
    >
    implements IKeyTransport
{
    private readonly logger: Logger;
    private _enabled: EnabledTransports = { toDevice: true, room: false };
    public constructor(
        private toDeviceTransport: ToDeviceKeyTransport,
        private roomKeyTransport: RoomKeyTransport,
        parentLogger?: Logger,
    ) {
        super();
        this.logger = (parentLogger ?? rootLogger).getChild(`[RoomAndToDeviceTransport]`);
        // update parent loggers for the sub transports so filtering for `RoomAndToDeviceTransport` contains their logs too
        this.toDeviceTransport.setParentLogger(this.logger);
        this.roomKeyTransport.setParentLogger(this.logger);

        this.roomKeyTransport.on(KeyTransportEvents.ReceivedKeys, (...props) => {
            // Turn on the room transport if we receive a roomKey from another participant
            // and disable the toDevice transport.
            if (!this._enabled.room) {
                this.logger.debug("Received room key, enabling room key transport, disabling toDevice transport");
                this.setEnabled({ toDevice: false, room: true });
            }
            this.emit(KeyTransportEvents.ReceivedKeys, ...props);
        });
        this.toDeviceTransport.on(KeyTransportEvents.ReceivedKeys, (...props) => {
            if (this._enabled.toDevice) {
                this.emit(KeyTransportEvents.ReceivedKeys, ...props);
            } else {
                this.logger.debug("To Device transport is disabled, ignoring received keys");
            }
        });
    }

    /** Set which transport type should be used to send and receive keys.*/
    public setEnabled(enabled: { toDevice: boolean; room: boolean }): void {
        if (this.enabled.toDevice !== enabled.toDevice || this.enabled.room !== enabled.room) {
            this._enabled = enabled;
            this.emit(RoomAndToDeviceEvents.EnabledTransportsChanged, enabled);
        }
    }

    /** The currently enabled transports that are used to send and receive keys.*/
    public get enabled(): EnabledTransports {
        return this._enabled;
    }

    public start(): void {
        // always start the underlying transport since we need to enable room transport
        // when someone else sends us a room key. (we need to listen to roomKeyTransport)
        this.roomKeyTransport.start();
        this.toDeviceTransport.start();
    }

    public stop(): void {
        // always stop since it is always running
        this.roomKeyTransport.stop();
        this.toDeviceTransport.stop();
    }

    public async sendKey(keyBase64Encoded: string, index: number, members: ParticipantDeviceInfo[]): Promise<void> {
        this.logger.debug(
            `Sending key with index ${index} to call members (count=${members.length}) via:` +
                (this._enabled.room ? "room transport" : "") +
                (this._enabled.room && this._enabled.toDevice ? "and" : "") +
                (this._enabled.toDevice ? "to device transport" : ""),
        );
        if (this._enabled.room) await this.roomKeyTransport.sendKey(keyBase64Encoded, index, members);
        if (this._enabled.toDevice) {
            try {
                await this.toDeviceTransport.sendKey(keyBase64Encoded, index, members);
            } catch (error) {
                if (error instanceof NotSupportedError && !this._enabled.room) {
                    this.logger.warn(
                        "To device is not supported enabling room key transport, disabling toDevice transport",
                    );
                    this.setEnabled({ toDevice: false, room: true });
                    await this.sendKey(keyBase64Encoded, index, members);
                }
            }
        }
    }
}
