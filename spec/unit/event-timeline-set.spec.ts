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

import * as utils from "../test-utils/test-utils";
import {
    EventTimeline,
    EventTimelineSet,
    EventType,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent,
    Room,
    DuplicateStrategy,
} from '../../src';

describe('EventTimelineSet', () => {
    const roomId = '!foo:bar';
    const userA = "@alice:bar";

    let room: Room;
    let eventTimeline: EventTimeline;
    let eventTimelineSet: EventTimelineSet;
    let client: MatrixClient;

    let messageEvent: MatrixEvent;
    let replyEvent: MatrixEvent;

    const itShouldReturnTheRelatedEvents = () => {
        it('should return the related events', () => {
            eventTimelineSet.aggregateRelations(messageEvent);
            const relations = eventTimelineSet.getRelationsForEvent(
                messageEvent.getId(),
                "m.in_reply_to",
                EventType.RoomMessage,
            );
            expect(relations).toBeDefined();
            expect(relations.getRelations().length).toBe(1);
            expect(relations.getRelations()[0].getId()).toBe(replyEvent.getId());
        });
    };

    beforeEach(() => {
        client = utils.mock(MatrixClient, 'MatrixClient');
        room = new Room(roomId, client, userA);
        eventTimelineSet = new EventTimelineSet(room, {
            unstableClientRelationAggregation: true,
        });
        eventTimeline = new EventTimeline(eventTimelineSet);
        messageEvent = utils.mkMessage({
            room: roomId,
            user: userA,
            msg: 'Hi!',
            event: true,
        }) as MatrixEvent;
        replyEvent = utils.mkReplyMessage({
            room: roomId,
            user: userA,
            msg: 'Hoo!',
            event: true,
            replyToMessage: messageEvent,
        }) as MatrixEvent;
    });

    describe('addLiveEvent', () => {
        it("Adds event to the live timeline in the timeline set", () => {
            const liveTimeline = eventTimelineSet.getLiveTimeline();
            expect(liveTimeline.getEvents().length).toStrictEqual(0);
            eventTimelineSet.addLiveEvent(messageEvent);
            expect(liveTimeline.getEvents().length).toStrictEqual(1);
        });

        it("should replace a timeline event if dupe strategy is 'replace'", () => {
            const liveTimeline = eventTimelineSet.getLiveTimeline();
            expect(liveTimeline.getEvents().length).toStrictEqual(0);
            eventTimelineSet.addLiveEvent(messageEvent, {
                duplicateStrategy: DuplicateStrategy.Replace,
            });
            expect(liveTimeline.getEvents().length).toStrictEqual(1);

            // make a duplicate
            const duplicateMessageEvent = utils.mkMessage({
                room: roomId, user: userA, msg: "dupe", event: true,
            }) as MatrixEvent;
            duplicateMessageEvent.event.event_id = messageEvent.getId();

            // Adding the duplicate event should replace the `messageEvent`
            // because it has the same `event_id` and duplicate strategy is
            // replace.
            eventTimelineSet.addLiveEvent(duplicateMessageEvent, {
                duplicateStrategy: DuplicateStrategy.Replace,
            });

            const eventsInLiveTimeline = liveTimeline.getEvents();
            expect(eventsInLiveTimeline.length).toStrictEqual(1);
            expect(eventsInLiveTimeline[0]).toStrictEqual(duplicateMessageEvent);
        });

        it("Make sure legacy overload passing options directly as parameters still works", () => {
            expect(() => eventTimelineSet.addLiveEvent(messageEvent, DuplicateStrategy.Replace, false)).not.toThrow();
            expect(() => eventTimelineSet.addLiveEvent(messageEvent, DuplicateStrategy.Ignore, true)).not.toThrow();
        });
    });

    describe('addEventToTimeline', () => {
        it("Adds event to timeline", () => {
            const liveTimeline = eventTimelineSet.getLiveTimeline();
            expect(liveTimeline.getEvents().length).toStrictEqual(0);
            eventTimelineSet.addEventToTimeline(messageEvent, liveTimeline, {
                toStartOfTimeline: true,
            });
            expect(liveTimeline.getEvents().length).toStrictEqual(1);
        });

        it("Make sure legacy overload passing options directly as parameters still works", () => {
            const liveTimeline = eventTimelineSet.getLiveTimeline();
            expect(() => {
                eventTimelineSet.addEventToTimeline(
                    messageEvent,
                    liveTimeline,
                    true,
                );
            }).not.toThrow();
            expect(() => {
                eventTimelineSet.addEventToTimeline(
                    messageEvent,
                    liveTimeline,
                    true,
                    false,
                );
            }).not.toThrow();
        });
    });

    describe('aggregateRelations', () => {
        describe('with unencrypted events', () => {
            beforeEach(() => {
                eventTimelineSet.addEventsToTimeline(
                    [
                        messageEvent,
                        replyEvent,
                    ],
                    true,
                    eventTimeline,
                    'foo',
                );
            });

            itShouldReturnTheRelatedEvents();
        });

        describe('with events to be decrypted', () => {
            let messageEventShouldAttemptDecryptionSpy: jest.SpyInstance;
            let messageEventIsDecryptionFailureSpy: jest.SpyInstance;

            let replyEventShouldAttemptDecryptionSpy: jest.SpyInstance;
            let replyEventIsDecryptionFailureSpy: jest.SpyInstance;

            beforeEach(() => {
                messageEventShouldAttemptDecryptionSpy = jest.spyOn(messageEvent, 'shouldAttemptDecryption');
                messageEventShouldAttemptDecryptionSpy.mockReturnValue(true);
                messageEventIsDecryptionFailureSpy = jest.spyOn(messageEvent, 'isDecryptionFailure');

                replyEventShouldAttemptDecryptionSpy = jest.spyOn(replyEvent, 'shouldAttemptDecryption');
                replyEventShouldAttemptDecryptionSpy.mockReturnValue(true);
                replyEventIsDecryptionFailureSpy = jest.spyOn(messageEvent, 'isDecryptionFailure');

                eventTimelineSet.addEventsToTimeline(
                    [
                        messageEvent,
                        replyEvent,
                    ],
                    true,
                    eventTimeline,
                    'foo',
                );
            });

            it('should not return the related events', () => {
                eventTimelineSet.aggregateRelations(messageEvent);
                const relations = eventTimelineSet.getRelationsForEvent(
                    messageEvent.getId(),
                    "m.in_reply_to",
                    EventType.RoomMessage,
                );
                expect(relations).toBeUndefined();
            });

            describe('after decryption', () => {
                beforeEach(() => {
                    // simulate decryption failure once
                    messageEventIsDecryptionFailureSpy.mockReturnValue(true);
                    replyEventIsDecryptionFailureSpy.mockReturnValue(true);

                    messageEvent.emit(MatrixEventEvent.Decrypted, messageEvent);
                    replyEvent.emit(MatrixEventEvent.Decrypted, replyEvent);

                    // simulate decryption
                    messageEventIsDecryptionFailureSpy.mockReturnValue(false);
                    replyEventIsDecryptionFailureSpy.mockReturnValue(false);

                    messageEventShouldAttemptDecryptionSpy.mockReturnValue(false);
                    replyEventShouldAttemptDecryptionSpy.mockReturnValue(false);

                    messageEvent.emit(MatrixEventEvent.Decrypted, messageEvent);
                    replyEvent.emit(MatrixEventEvent.Decrypted, replyEvent);
                });

                itShouldReturnTheRelatedEvents();
            });
        });
    });
});
