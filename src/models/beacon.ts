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
}

type EmittedEvents = BeaconEvent.New | BeaconEvent.Update;
type EventHandlerMap = {
    [BeaconEvent.New]: (event: MatrixEvent, beacon: Beacon) => void;
    [BeaconEvent.Update]: (event: MatrixEvent, beacon: Beacon) => void;
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
export class Beacon extends TypedEventEmitter<EmittedEvents, EventHandlerMap> {
    private beaconInfo: BeaconInfoState;

    constructor(
        private rootEvent: MatrixEvent,
    ) {
        super();
        this.beaconInfo = parseBeaconInfoContent(this.rootEvent.getContent());
        this.emit(BeaconEvent.New, this.rootEvent, this);
    }

    public get isLive(): boolean {
        return this.beaconInfo?.live &&
            isTimestampInDuration(this.beaconInfo?.timestamp, this.beaconInfo?.timeout, Date.now());
    }

    public get beaconInfoId(): string {
        return this.rootEvent.getId();
    }

    public update(beaconInfoEvent: MatrixEvent): void {
        if (beaconInfoEvent.getId() !== this.beaconInfoId) {
            throw new Error('Invalid updating event');
        }
        this.rootEvent = beaconInfoEvent;
        this.beaconInfo = parseBeaconInfoContent(this.rootEvent.getContent());

        this.emit(BeaconEvent.Update, beaconInfoEvent, this);
    }
}
