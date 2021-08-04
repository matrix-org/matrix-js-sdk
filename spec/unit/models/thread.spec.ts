import { MatrixEvent } from "../../../src/models/event";
import { Thread } from "../../../src/models/thread";

const mockMessage = (id: string, body: string, sender: string, replyId?: string) => {
    const opts = {
        content: {
            body,
        },
        event_id: id,
        origin_server_ts: 1628082832517,
        sender: sender,
        type: "m.room.message",
        room_id: "!room123:hs1",
    };

    if (replyId) {
        opts.content["m.relates_to"] = {
            "m.in_reply_to": {
                "event_id": replyId,
            },
        };
    }

    return new MatrixEvent(opts);
};

const mockAnnotation = (id: string, body: string, sender: string, replyId: string) => {
    return new MatrixEvent({
        "content": {
            "m.relates_to": {
                "event_id": replyId,
                "key": body,
                "rel_type": "m.annotation",
            },
        },
        "origin_server_ts": 1628084947352,
        "sender": sender,
        "type": "m.reaction",
        "event_id": id,
        "room_id": "!room123:hs1",
    });
};

const mockThread = () => {
    const events = [
        mockMessage("event1", "Hello", "alice"),
        mockMessage("event2", "Bonjour", "bob", "event1"),
        mockMessage("event3", "How are you?", "bob", "event2"),
    ];

    return new Thread(events);
};

describe('Thread', () => {
    it('should count participants', () => {
        const thread = mockThread();

        expect(thread.participants.size).toBe(2);

        thread.addEvent(mockMessage("event4", "Ça va?", "bob", "event2"));
        thread.addEvent(mockMessage("event5", "Cześć", "charlie", "event2"));

        expect(thread.participants.size).toBe(3);
    });

    it('should store reference to root and tails', () => {
        const thread = mockThread();
        expect(thread.id).toBe("event1");
        expect(thread.tail.size).toBe(1);

        thread.addEvent(mockMessage("event4", "Ça va?", "bob", "event2"));
        expect(thread.tail.size).toBe(2);

        thread.addEvent(mockMessage("event5", "Ça va?", "bob", "event4"));
        expect(thread.tail.size).toBe(2);

        thread.addEvent(mockMessage("event6", "Ça va?", "bob", "event1"));
        expect(thread.tail.size).toBe(3);
    });

    it('should only count message events', () => {
        const thread = mockThread();
        expect(thread.length).toBe(3);

        thread.addEvent(mockMessage("event4", "Ça va?", "bob", "event2"));
        expect(thread.length).toBe(4);

        const reaction = mockAnnotation("event6", "✅", "bob", "event2");

        thread.addEvent(reaction);

        expect(thread.length).toBe(4);
        expect(thread.eventTimeline.length).toBe(5);
    });

    it('tails event can only be m.room.message', () => {
        const thread = mockThread();
        expect(thread.length).toBe(3);

        const reaction = mockAnnotation("event10", "✅", "bob", "event2");
        thread.addEvent(reaction);

        expect(Array.from(thread.tail)[0]).toBe("event3");
    });
});
