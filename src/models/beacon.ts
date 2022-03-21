/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { M_BEACON_INFO } from "../@types/beacon";
import { BeaconInfoState, parseBeaconInfoContent } from "../content-helpers";
import { MatrixEvent } from "../matrix";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum BeaconEvent {
    New = "Beacon.new",
    Update = "Beacon.update",
    LivenessChange = "Beacon.LivenessChange",
}

export type BeaconEventHandlerMap = {
    [BeaconEvent.Update]: (event: MatrixEvent, beacon: Beacon) => void;
    [BeaconEvent.LivenessChange]: (isLive: boolean, beacon: Beacon) => void;
};

export const isTimestampInDuration = (
    startTimestamp: number,
    durationMs: number,
    timestamp: number,
): boolean => timestamp >= startTimestamp && startTimestamp + durationMs >= timestamp;

export const isBeaconInfoEventType = (type: string) =>
    type.startsWith(M_BEACON_INFO.name) ||
    type.startsWith(M_BEACON_INFO.altName);

// https://github.com/matrix-org/matrix-spec-proposals/pull/3489
export class Beacon extends TypedEventEmitter<Exclude<BeaconEvent, BeaconEvent.New>, BeaconEventHandlerMap> {
    public readonly roomId: string;
    private _beaconInfo: BeaconInfoState;
    private _isLive: boolean;
    private livenessWatchInterval: number;

    constructor(
        private rootEvent: MatrixEvent,
    ) {
        super();
        this.setBeaconInfo(this.rootEvent);
        this.roomId = this.rootEvent.getRoomId();
    }

    public get isLive(): boolean {
        return this._isLive;
    }

    public get identifier(): string {
        return this.beaconInfoEventType;
    }

    public get beaconInfoId(): string {
        return this.rootEvent.getId();
    }

    public get beaconInfoOwner(): string {
        return this.rootEvent.getStateKey();
    }

    public get beaconInfoEventType(): string {
        return this.rootEvent.getType();
    }

    public get beaconInfo(): BeaconInfoState {
        return this._beaconInfo;
    }

    public update(beaconInfoEvent: MatrixEvent): void {
        if (beaconInfoEvent.getType() !== this.beaconInfoEventType) {
            throw new Error('Invalid updating event');
        }
        this.rootEvent = beaconInfoEvent;
        this.setBeaconInfo(this.rootEvent);

        this.emit(BeaconEvent.Update, beaconInfoEvent, this);
    }

    public destroy(): void {
        if (this.livenessWatchInterval) {
            clearInterval(this.livenessWatchInterval);
        }
    }

    /**
     * Monitor liveness of a beacon
     * Emits BeaconEvent.LivenessChange when beacon expires
     */
    public monitorLiveness(): void {
        if (this.livenessWatchInterval) {
            clearInterval(this.livenessWatchInterval);
        }

        if (this.isLive) {
            const expiryInMs = (this._beaconInfo?.timestamp + this._beaconInfo?.timeout + 1) - Date.now();
            if (expiryInMs > 1) {
                this.livenessWatchInterval = setInterval(this.checkLiveness.bind(this), expiryInMs);
            }
        }
    }

    private setBeaconInfo(event: MatrixEvent): void {
        this._beaconInfo = parseBeaconInfoContent(event.getContent());
        this.checkLiveness();
    }

    private checkLiveness(): void {
        const prevLiveness = this.isLive;
        this._isLive = this._beaconInfo?.live &&
            isTimestampInDuration(this._beaconInfo?.timestamp, this._beaconInfo?.timeout, Date.now());

        if (prevLiveness !== this.isLive) {
            this.emit(BeaconEvent.LivenessChange, this.isLive, this);
        }
    }
}
