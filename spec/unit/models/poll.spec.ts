/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import {
    PollStartEvent,
    M_POLL_KIND_DISCLOSED,
    M_POLL_RESPONSE,
    REFERENCE_RELATION,
    M_POLL_END,
} from "matrix-events-sdk";

import { IEvent, MatrixEvent, PollEvent } from "../../../src";
import { Poll } from "../../../src/models/poll";
import { getMockClientWithEventEmitter } from "../../test-utils/client";

jest.useFakeTimers();

describe("Poll", () => {
    const mockClient = getMockClientWithEventEmitter({
        relations: jest.fn(),
    });
    const roomId = "!room:server";
    // 14.03.2022 16:15
    const now = 1647270879403;

    const basePollStartEvent = new MatrixEvent({
        ...PollStartEvent.from("What?", ["a", "b"], M_POLL_KIND_DISCLOSED.name).serialize(),
        room_id: roomId,
    });
    basePollStartEvent.event.event_id = "$12345";

    beforeEach(() => {
        jest.clearAllMocks();
        jest.setSystemTime(now);

        mockClient.relations.mockResolvedValue({ events: [] });
    });

    let eventId = 1;
    const makeRelatedEvent = (eventProps: Partial<IEvent>, timestamp = now): MatrixEvent => {
        const event = new MatrixEvent({
            ...eventProps,
            content: {
                ...(eventProps.content || {}),
                "m.relates_to": {
                    rel_type: REFERENCE_RELATION.name,
                    event_id: basePollStartEvent.getId(),
                },
            },
        });
        event.event.origin_server_ts = timestamp;
        event.event.event_id = `${eventId++}`;
        return event;
    };

    it("initialises with root event", () => {
        const poll = new Poll(basePollStartEvent, mockClient);
        expect(poll.roomId).toEqual(roomId);
        expect(poll.pollId).toEqual(basePollStartEvent.getId());
        expect(poll.pollEvent).toEqual(basePollStartEvent.unstableExtensibleEvent);
        expect(poll.isEnded).toBe(false);
    });

    describe("fetching responses", () => {
        it("calls relations api and emits", async () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            const emitSpy = jest.spyOn(poll, "emit");
            const responses = await poll.getResponses();
            expect(mockClient.relations).toHaveBeenCalledWith(roomId, basePollStartEvent.getId(), "m.reference");
            expect(emitSpy).toHaveBeenCalledWith(PollEvent.Responses, responses);
        });

        it("returns existing responses object after initial fetch", async () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            const responses = await poll.getResponses();
            const responses2 = await poll.getResponses();
            // only fetched relations once
            expect(mockClient.relations).toHaveBeenCalledTimes(1);
            // strictly equal
            expect(responses).toBe(responses2);
        });

        it("waits for existing relations request to finish when getting responses", async () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            const firstResponsePromise = poll.getResponses();
            const secondResponsePromise = poll.getResponses();
            await firstResponsePromise;
            expect(firstResponsePromise).toEqual(secondResponsePromise);
            await secondResponsePromise;
            expect(mockClient.relations).toHaveBeenCalledTimes(1);
        });

        it("filters relations for relevent response events", async () => {
            const replyEvent = new MatrixEvent({ type: "m.room.message" });
            const stableResponseEvent = makeRelatedEvent({ type: M_POLL_RESPONSE.stable! });
            const unstableResponseEvent = makeRelatedEvent({ type: M_POLL_RESPONSE.unstable });

            mockClient.relations.mockResolvedValue({
                events: [replyEvent, stableResponseEvent, unstableResponseEvent],
            });
            const poll = new Poll(basePollStartEvent, mockClient);
            const responses = await poll.getResponses();
            expect(responses.getRelations()).toEqual([stableResponseEvent, unstableResponseEvent]);
        });

        describe("with poll end event", () => {
            const stablePollEndEvent = makeRelatedEvent({ type: M_POLL_END.stable! });
            const unstablePollEndEvent = makeRelatedEvent({ type: M_POLL_END.unstable! });
            const responseEventBeforeEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now - 1000);
            const responseEventAtEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now);
            const responseEventAfterEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now + 1000);

            beforeEach(() => {
                mockClient.relations.mockResolvedValue({
                    events: [responseEventAfterEnd, responseEventAtEnd, responseEventBeforeEnd, stablePollEndEvent],
                });
            });

            it("sets poll end event with stable event type", async () => {
                const poll = new Poll(basePollStartEvent, mockClient);
                jest.spyOn(poll, "emit");
                await poll.getResponses();

                expect(poll.isEnded).toBe(true);
                expect(poll.emit).toHaveBeenCalledWith(PollEvent.End);
            });

            it("sets poll end event with unstable event type", async () => {
                mockClient.relations.mockResolvedValue({
                    events: [unstablePollEndEvent],
                });
                const poll = new Poll(basePollStartEvent, mockClient);
                jest.spyOn(poll, "emit");
                await poll.getResponses();

                expect(poll.isEnded).toBe(true);
                expect(poll.emit).toHaveBeenCalledWith(PollEvent.End);
            });

            it("filters out responses that were sent after poll end", async () => {
                const poll = new Poll(basePollStartEvent, mockClient);
                const responses = await poll.getResponses();

                // just response type events
                // and response with ts after poll end event is excluded
                expect(responses.getRelations()).toEqual([responseEventAtEnd, responseEventBeforeEnd]);
            });
        });
    });

    describe("onNewRelation()", () => {
        it("discards response if poll responses have not been initialised", () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            jest.spyOn(poll, "emit");
            const responseEvent = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now);

            poll.onNewRelation(responseEvent);

            // did not add response -> no emit
            expect(poll.emit).not.toHaveBeenCalled();
        });

        it("sets poll end event when responses are not initialised", () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            jest.spyOn(poll, "emit");
            const stablePollEndEvent = makeRelatedEvent({ type: M_POLL_END.stable! });

            poll.onNewRelation(stablePollEndEvent);

            expect(poll.emit).toHaveBeenCalledWith(PollEvent.End);
        });

        it("sets poll end event and refilters responses based on timestamp", async () => {
            const stablePollEndEvent = makeRelatedEvent({ type: M_POLL_END.stable! });
            const responseEventBeforeEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now - 1000);
            const responseEventAtEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now);
            const responseEventAfterEnd = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now + 1000);
            mockClient.relations.mockResolvedValue({
                events: [responseEventAfterEnd, responseEventAtEnd, responseEventBeforeEnd],
            });
            const poll = new Poll(basePollStartEvent, mockClient);
            const responses = await poll.getResponses();
            jest.spyOn(poll, "emit");

            expect(responses.getRelations().length).toEqual(3);
            poll.onNewRelation(stablePollEndEvent);

            expect(poll.emit).toHaveBeenCalledWith(PollEvent.End);
            expect(poll.emit).toHaveBeenCalledWith(PollEvent.Responses, responses);
            expect(responses.getRelations().length).toEqual(2);
            // after end timestamp event is removed
            expect(responses.getRelations()).toEqual([responseEventAtEnd, responseEventBeforeEnd]);
        });

        it("filters out irrelevant relations", async () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            // init responses
            const responses = await poll.getResponses();
            jest.spyOn(poll, "emit");
            const replyEvent = new MatrixEvent({ type: "m.room.message" });

            poll.onNewRelation(replyEvent);

            // did not add response -> no emit
            expect(poll.emit).not.toHaveBeenCalled();
            expect(responses.getRelations().length).toEqual(0);
        });

        it("adds poll response relations to responses", async () => {
            const poll = new Poll(basePollStartEvent, mockClient);
            // init responses
            const responses = await poll.getResponses();
            jest.spyOn(poll, "emit");
            const responseEvent = makeRelatedEvent({ type: M_POLL_RESPONSE.name }, now);

            poll.onNewRelation(responseEvent);

            // did not add response -> no emit
            expect(poll.emit).toHaveBeenCalledWith(PollEvent.Responses, responses);
            expect(responses.getRelations()).toEqual([responseEvent]);
        });
    });
});
