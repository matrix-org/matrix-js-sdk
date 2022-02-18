import { TestClient } from '../../TestClient';
import { CallEventHandler } from '../../../src/webrtc/callEventHandler';
import { MatrixEvent } from '../../../src/models/event';
import { EventType } from '../../../src/@types/event';

describe('CallEventHandler', function() {
    let client;

    beforeEach(function() {
        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {});
    });

    afterEach(function() {
        client.stop();
    });

    it('should enforce inbound toDevice message ordering', async function() {
        const callEventHandler = new CallEventHandler(client);

        const event1 = new MatrixEvent({
            type: EventType.CallInvite,
            content: {
                call_id: "123",
                seq: 0,
            },
        });
        callEventHandler["onToDeviceEvent"](event1);

        expect(callEventHandler.callEventBuffer.length).toBe(1);
        expect(callEventHandler.callEventBuffer[0]).toBe(event1);

        const event2 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 1,
            },
        });
        callEventHandler["onToDeviceEvent"](event2);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.callEventBuffer[1]).toBe(event2);

        const event3 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 3,
            },
        });
        callEventHandler["onToDeviceEvent"](event3);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(2);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(1);

        const event4 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 4,
            },
        });
        callEventHandler["onToDeviceEvent"](event4);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(2);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(2);

        const event5 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 2,
            },
        });
        callEventHandler["onToDeviceEvent"](event5);

        expect(callEventHandler.callEventBuffer.length).toBe(5);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(5);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(0);
    });
});
