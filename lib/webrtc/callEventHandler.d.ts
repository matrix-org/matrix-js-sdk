import { MatrixEvent } from '../models/event';
import { MatrixCall } from './call';
import { MatrixClient } from '../client';
export declare class CallEventHandler {
    client: MatrixClient;
    calls: Map<string, MatrixCall>;
    callEventBuffer: MatrixEvent[];
    candidateEventsByCall: Map<string, Array<MatrixEvent>>;
    constructor(client: MatrixClient);
    start(): void;
    stop(): void;
    private evaluateEventBuffer;
    private onRoomTimeline;
    private eventIsACall;
    private handleCallEvent;
}
//# sourceMappingURL=callEventHandler.d.ts.map