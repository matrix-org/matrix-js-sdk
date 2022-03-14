import { M_BEACON_INFO } from "../@types/beacon";
import { BeaconInfoState, parseBeaconInfoContent } from "../content-helpers";
import { MatrixEvent } from "../matrix";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum BeaconEvent {
    New = "Beacon.new",
}

type EmittedEvents = BeaconEvent.New;
type EventHandlerMap = {
    [BeaconEvent.New]: () => void;
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
    private readonly beaconInfo: BeaconInfoState;

    constructor(
        public readonly rootEvent: MatrixEvent,
    ) {
        super();
        this.beaconInfo = parseBeaconInfoContent(this.rootEvent.getContent());
    }

    public get isLive(): boolean {
        return this.beaconInfo?.live &&
            isTimestampInDuration(this.beaconInfo?.timestamp, this.beaconInfo?.timeout, Date.now());
    }

    public get beaconInfoId(): string {
        return this.rootEvent.getId();
    }
}
