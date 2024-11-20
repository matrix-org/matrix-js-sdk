/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { MockedObject } from "jest-mock";

import { MatrixEvent, MatrixEventEvent } from "../../../src/models/event";
import { emitPromise } from "../../test-utils/test-utils";
import { Crypto, IEventDecryptionResult } from "../../../src/crypto";
import {
    IAnnotatedPushRule,
    MatrixClient,
    PushRuleActionName,
    Room,
    THREAD_RELATION_TYPE,
    TweakName,
} from "../../../src";
import { DecryptionFailureCode } from "../../../src/crypto-api";
import { DecryptionError } from "../../../src/common-crypto/CryptoBackend";

describe("MatrixEvent", () => {
    it("should create copies of itself", () => {
        const a = new MatrixEvent({
            type: "com.example.test",
            content: {
                isTest: true,
                num: 42,
            },
        });

        const clone = a.toSnapshot();
        expect(clone).toBeDefined();
        expect(clone).not.toBe(a);
        expect(clone.event).not.toBe(a.event);
        expect(clone.event).toMatchObject(a.event);

        // The other properties we're not super interested in, honestly.
    });

    it("should compare itself to other events using json", () => {
        const a = new MatrixEvent({
            type: "com.example.test",
            content: {
                isTest: true,
                num: 42,
            },
        });
        const b = new MatrixEvent({
            type: "com.example.test______B",
            content: {
                isTest: true,
                num: 42,
            },
        });
        expect(a.isEquivalentTo(b)).toBe(false);
        expect(a.isEquivalentTo(a)).toBe(true);
        expect(b.isEquivalentTo(a)).toBe(false);
        expect(b.isEquivalentTo(b)).toBe(true);
        expect(a.toSnapshot().isEquivalentTo(a)).toBe(true);
        expect(a.toSnapshot().isEquivalentTo(b)).toBe(false);
    });

    describe("redaction", () => {
        it("should prune clearEvent when being redacted", () => {
            const ev = createEvent("$event1:server", "Test");

            expect(ev.getContent().body).toBe("Test");
            expect(ev.getWireContent().body).toBe("Test");
            ev.makeEncrypted("m.room.encrypted", { ciphertext: "xyz" }, "", "");
            expect(ev.getContent().body).toBe("Test");
            expect(ev.getWireContent().body).toBeUndefined();
            expect(ev.getWireContent().ciphertext).toBe("xyz");

            const mockClient = {} as unknown as MockedObject<MatrixClient>;
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const redaction = createRedaction(ev.getId()!);

            ev.makeRedacted(redaction, room);
            expect(ev.getContent().body).toBeUndefined();
            expect(ev.getWireContent().body).toBeUndefined();
            expect(ev.getWireContent().ciphertext).toBeUndefined();
        });

        it("should remain in the main timeline when redacted", async () => {
            // Given an event in the main timeline
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const ev = createEvent("$event1:server");

            await room.addLiveEvents([ev]);
            await room.createThreadsTimelineSets();
            expect(ev.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([ev.getId()]);

            // When I redact it
            const redaction = createRedaction(ev.getId()!);
            ev.makeRedacted(redaction, room);

            // Then it remains in the main timeline
            expect(ev.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([ev.getId()]);
        });

        it("should keep thread roots in both timelines when redacted", async () => {
            // Given a thread exists
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const threadRoot = createEvent("$threadroot:server");
            const ev = createThreadedEvent("$event1:server", threadRoot.getId()!);

            await room.addLiveEvents([threadRoot, ev]);
            await room.createThreadsTimelineSets();
            expect(threadRoot.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([threadRoot.getId(), ev.getId()]);

            // When I redact the thread root
            const redaction = createRedaction(ev.getId()!);
            threadRoot.makeRedacted(redaction, room);

            // Then it remains in the main timeline and the thread
            expect(threadRoot.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([threadRoot.getId(), ev.getId()]);
        });

        it("should move into the main timeline when redacted", async () => {
            // Given an event in a thread
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const threadRoot = createEvent("$threadroot:server");
            const ev = createThreadedEvent("$event1:server", threadRoot.getId()!);

            await room.addLiveEvents([threadRoot, ev]);
            await room.createThreadsTimelineSets();
            expect(ev.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([threadRoot.getId(), ev.getId()]);

            // When I redact it
            const redaction = createRedaction(ev.getId()!);
            ev.makeRedacted(redaction, room);

            // Then it disappears from the thread and appears in the main timeline
            expect(ev.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId(), ev.getId()]);
            expect(threadLiveEventIds(room, 0)).not.toContain(ev.getId());
        });

        it("should move reactions to a redacted event into the main timeline", async () => {
            // Given an event in a thread with a reaction
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const threadRoot = createEvent("$threadroot:server");
            const ev = createThreadedEvent("$event1:server", threadRoot.getId()!);
            const reaction = createReactionEvent("$reaction:server", ev.getId()!);

            await room.addLiveEvents([threadRoot, ev, reaction]);
            await room.createThreadsTimelineSets();
            expect(reaction.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([threadRoot.getId(), ev.getId(), reaction.getId()]);

            // When I redact the event
            const redaction = createRedaction(ev.getId()!);
            ev.makeRedacted(redaction, room);

            // Then the reaction moves into the main timeline
            expect(reaction.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId(), ev.getId(), reaction.getId()]);
            expect(threadLiveEventIds(room, 0)).not.toContain(reaction.getId());
        });

        it("should move edits of a redacted event into the main timeline", async () => {
            // Given an event in a thread with a reaction
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const threadRoot = createEvent("$threadroot:server");
            const ev = createThreadedEvent("$event1:server", threadRoot.getId()!);
            const edit = createEditEvent("$edit:server", ev.getId()!);

            await room.addLiveEvents([threadRoot, ev, edit]);
            await room.createThreadsTimelineSets();
            expect(edit.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([threadRoot.getId(), ev.getId(), edit.getId()]);

            // When I redact the event
            const redaction = createRedaction(ev.getId()!);
            ev.makeRedacted(redaction, room);

            // Then the edit moves into the main timeline
            expect(edit.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId(), ev.getId(), edit.getId()]);
            expect(threadLiveEventIds(room, 0)).not.toContain(edit.getId());
        });

        it("should move reactions to replies to replies a redacted event into the main timeline", async () => {
            // Given an event in a thread with a reaction
            const mockClient = createMockClient();
            const room = new Room("!roomid:e.xyz", mockClient, "myname");
            const threadRoot = createEvent("$threadroot:server");
            const ev = createThreadedEvent("$event1:server", threadRoot.getId()!);
            const reply1 = createReplyEvent("$reply1:server", ev.getId()!);
            const reply2 = createReplyEvent("$reply2:server", reply1.getId()!);
            const reaction = createReactionEvent("$reaction:server", reply2.getId()!);

            await room.addLiveEvents([threadRoot, ev, reply1, reply2, reaction]);
            await room.createThreadsTimelineSets();
            expect(reaction.threadRootId).toEqual(threadRoot.getId());
            expect(mainTimelineLiveEventIds(room)).toEqual([threadRoot.getId()]);
            expect(threadLiveEventIds(room, 0)).toEqual([
                threadRoot.getId(),
                ev.getId(),
                reply1.getId(),
                reply2.getId(),
                reaction.getId(),
            ]);

            // When I redact the event
            const redaction = createRedaction(ev.getId()!);
            ev.makeRedacted(redaction, room);

            // Then the replies move to the main thread and the reaction disappears
            expect(reaction.threadRootId).toBeUndefined();
            expect(mainTimelineLiveEventIds(room)).toEqual([
                threadRoot.getId(),
                ev.getId(),
                reply1.getId(),
                reply2.getId(),
                reaction.getId(),
            ]);
            expect(threadLiveEventIds(room, 0)).not.toContain(reply1.getId());
            expect(threadLiveEventIds(room, 0)).not.toContain(reply2.getId());
            expect(threadLiveEventIds(room, 0)).not.toContain(reaction.getId());
        });

        function createMockClient(): MatrixClient {
            return {
                supportsThreads: jest.fn().mockReturnValue(true),
                decryptEventIfNeeded: jest.fn().mockReturnThis(),
                getUserId: jest.fn().mockReturnValue("@user:server"),
            } as unknown as MockedObject<MatrixClient>;
        }

        function createEvent(eventId: string, body?: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.message",
                content: {
                    body: body ?? eventId,
                },
                event_id: eventId,
            });
        }

        function createThreadedEvent(eventId: string, threadRootId: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.message",
                content: {
                    "body": eventId,
                    "m.relates_to": {
                        rel_type: THREAD_RELATION_TYPE.name,
                        event_id: threadRootId,
                    },
                },
                event_id: eventId,
            });
        }

        function createEditEvent(eventId: string, repliedToId: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.message",
                content: {
                    "body": "Edited",
                    "m.new_content": {
                        body: "Edited",
                    },
                    "m.relates_to": {
                        event_id: repliedToId,
                        rel_type: "m.replace",
                    },
                },
                event_id: eventId,
            });
        }

        function createReplyEvent(eventId: string, repliedToId: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.message",
                content: {
                    "m.relates_to": {
                        event_id: repliedToId,
                        key: "x",
                        rel_type: "m.in_reply_to",
                    },
                },
                event_id: eventId,
            });
        }

        function createReactionEvent(eventId: string, reactedToId: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.reaction",
                content: {
                    "m.relates_to": {
                        event_id: reactedToId,
                        key: "x",
                        rel_type: "m.annotation",
                    },
                },
                event_id: eventId,
            });
        }

        function createRedaction(redactedEventid: string): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.redaction",
                redacts: redactedEventid,
            });
        }
    });

    describe("applyVisibilityEvent", () => {
        it("should emit VisibilityChange if a change was made", async () => {
            const ev = new MatrixEvent({
                type: "m.room.message",
                content: {
                    body: "Test",
                },
                event_id: "$event1:server",
            });

            const prom = emitPromise(ev, MatrixEventEvent.VisibilityChange);
            ev.applyVisibilityEvent({ visible: false, eventId: ev.getId()!, reason: null });
            await prom;
        });
    });

    describe(".attemptDecryption", () => {
        let encryptedEvent: MatrixEvent;
        const eventId = "test_encrypted_event";

        beforeEach(() => {
            encryptedEvent = new MatrixEvent({
                event_id: eventId,
                type: "m.room.encrypted",
                content: {
                    ciphertext: "secrets",
                },
            });
        });

        it("should report unknown decryption errors", async () => {
            const decryptionListener = jest.fn();
            encryptedEvent.addListener(MatrixEventEvent.Decrypted, decryptionListener);

            const testError = new Error("test error");
            const crypto = {
                decryptEvent: jest.fn().mockRejectedValue(testError),
            } as unknown as Crypto;

            await encryptedEvent.attemptDecryption(crypto);
            expect(encryptedEvent.isEncrypted()).toBeTruthy();
            expect(encryptedEvent.isBeingDecrypted()).toBeFalsy();
            expect(encryptedEvent.isDecryptionFailure()).toBeTruthy();
            expect(encryptedEvent.decryptionFailureReason).toEqual(DecryptionFailureCode.UNKNOWN_ERROR);
            expect(encryptedEvent.isEncryptedDisabledForUnverifiedDevices).toBeFalsy();
            expect(encryptedEvent.getContent()).toEqual({
                msgtype: "m.bad.encrypted",
                body: "** Unable to decrypt: Error: test error **",
            });
            expect(decryptionListener).toHaveBeenCalledWith(encryptedEvent, testError);
        });

        it("should report known decryption errors", async () => {
            const decryptionListener = jest.fn();
            encryptedEvent.addListener(MatrixEventEvent.Decrypted, decryptionListener);

            const testError = new DecryptionError(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID, "uisi");
            const crypto = {
                decryptEvent: jest.fn().mockRejectedValue(testError),
            } as unknown as Crypto;

            await encryptedEvent.attemptDecryption(crypto);
            expect(encryptedEvent.isEncrypted()).toBeTruthy();
            expect(encryptedEvent.isBeingDecrypted()).toBeFalsy();
            expect(encryptedEvent.isDecryptionFailure()).toBeTruthy();
            expect(encryptedEvent.decryptionFailureReason).toEqual(
                DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
            );
            expect(encryptedEvent.isEncryptedDisabledForUnverifiedDevices).toBeFalsy();
            expect(encryptedEvent.getContent()).toEqual({
                msgtype: "m.bad.encrypted",
                body: "** Unable to decrypt: DecryptionError: uisi **",
            });
            expect(decryptionListener).toHaveBeenCalledWith(encryptedEvent, testError);
        });

        it(`should report "DecryptionError: The sender has disabled encrypting to unverified devices."`, async () => {
            const crypto = {
                decryptEvent: jest
                    .fn()
                    .mockRejectedValue(
                        new DecryptionError(
                            DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
                            "The sender has disabled encrypting to unverified devices.",
                        ),
                    ),
            } as unknown as Crypto;

            await encryptedEvent.attemptDecryption(crypto);
            expect(encryptedEvent.isEncrypted()).toBeTruthy();
            expect(encryptedEvent.isBeingDecrypted()).toBeFalsy();
            expect(encryptedEvent.isDecryptionFailure()).toBeTruthy();
            expect(encryptedEvent.isEncryptedDisabledForUnverifiedDevices).toBeTruthy();
            expect(encryptedEvent.getContent()).toEqual({
                msgtype: "m.bad.encrypted",
                body: "** Unable to decrypt: DecryptionError: The sender has disabled encrypting to unverified devices. **",
            });
        });

        it("should retry decryption if a retry is queued", async () => {
            const eventAttemptDecryptionSpy = jest.spyOn(encryptedEvent, "attemptDecryption");

            const crypto = {
                decryptEvent: jest
                    .fn()
                    .mockImplementationOnce(() => {
                        // schedule a second decryption attempt while
                        // the first one is still running.
                        encryptedEvent.attemptDecryption(crypto);

                        const error = new Error("nope");
                        error.name = "DecryptionError";
                        return Promise.reject(error);
                    })
                    .mockImplementationOnce(() => {
                        return Promise.resolve({
                            clearEvent: {
                                type: "m.room.message",
                            },
                        });
                    }),
            } as unknown as Crypto;

            await encryptedEvent.attemptDecryption(crypto);

            expect(eventAttemptDecryptionSpy).toHaveBeenCalledTimes(2);
            expect(crypto.decryptEvent).toHaveBeenCalledTimes(2);
            expect(encryptedEvent.getType()).toEqual("m.room.message");
            expect(encryptedEvent.isDecryptionFailure()).toBe(false);
            expect(encryptedEvent.decryptionFailureReason).toBe(null);
        });
    });

    describe("replyEventId", () => {
        it("should ignore 'm.relates_to' from encrypted content even if cleartext lacks one", async () => {
            const eventId = "test_encrypted_event";
            const encryptedEvent = new MatrixEvent({
                event_id: eventId,
                type: "m.room.encrypted",
                content: {
                    ciphertext: "secrets",
                },
            });

            const crypto = {
                decryptEvent: jest.fn().mockImplementationOnce(() => {
                    return Promise.resolve<IEventDecryptionResult>({
                        clearEvent: {
                            type: "m.room.message",
                            content: {
                                "m.relates_to": {
                                    "m.in_reply_to": {
                                        event_id: "!anotherEvent",
                                    },
                                },
                            },
                        },
                    });
                }),
            } as unknown as Crypto;

            await encryptedEvent.attemptDecryption(crypto);
            expect(encryptedEvent.getType()).toEqual("m.room.message");
            expect(encryptedEvent.replyEventId).toBeUndefined();
        });
    });

    describe("push details", () => {
        const pushRule = {
            actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Highlight, value: true }],
            pattern: "banana",
            rule_id: "banana",
            kind: "override",
            default: false,
            enabled: true,
        } as IAnnotatedPushRule;

        describe("setPushDetails()", () => {
            it("sets actions and rule on event", () => {
                const actions = { notify: false, tweaks: {} };
                const event = new MatrixEvent({
                    type: "com.example.test",
                    content: {
                        isTest: true,
                    },
                });
                event.setPushDetails(actions, pushRule);

                expect(event.getPushDetails()).toEqual({
                    actions,
                    rule: pushRule,
                });
            });
            it("clears existing push rule", () => {
                const prevActions = { notify: true, tweaks: { highlight: true } };
                const actions = { notify: false, tweaks: {} };
                const event = new MatrixEvent({
                    type: "com.example.test",
                    content: {
                        isTest: true,
                    },
                });
                event.setPushDetails(prevActions, pushRule);

                event.setPushDetails(actions);

                // rule is not in event push cache
                expect(event.getPushDetails()).toEqual({ actions });
            });
        });
    });

    it("should ignore thread relation on state events", async () => {
        const stateEvent = new MatrixEvent({
            event_id: "$event_id",
            type: "some_state_event",
            content: {
                "foo": "bar",
                "m.relates_to": {
                    "event_id": "$thread_id",
                    "m.in_reply_to": {
                        event_id: "$thread_id",
                    },
                    "rel_type": "m.thread",
                },
            },
            state_key: "",
        });

        expect(stateEvent.isState()).toBeTruthy();
        expect(stateEvent.threadRootId).toBeUndefined();
    });
});

function mainTimelineLiveEventIds(room: Room): Array<string> {
    return room
        .getLiveTimeline()
        .getEvents()
        .map((e) => e.getId()!);
}

function threadLiveEventIds(room: Room, threadIndex: number): Array<string> {
    return room
        .getThreads()
        [threadIndex].getUnfilteredTimelineSet()
        .getLiveTimeline()
        .getEvents()
        .map((e) => e.getId()!);
}
