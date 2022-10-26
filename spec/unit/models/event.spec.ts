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

import { MatrixEvent, MatrixEventEvent } from "../../../src/models/event";
import { emitPromise } from "../../test-utils/test-utils";
import { EventType } from "../../../src";
import { Crypto } from "../../../src/crypto";

describe('MatrixEvent', () => {
    it('should create copies of itself', () => {
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

    it('should compare itself to other events using json', () => {
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

    it("should prune clearEvent when being redacted", () => {
        const ev = new MatrixEvent({
            type: "m.room.message",
            content: {
                body: "Test",
            },
            event_id: "$event1:server",
        });

        expect(ev.getContent().body).toBe("Test");
        expect(ev.getWireContent().body).toBe("Test");
        ev.makeEncrypted("m.room.encrypted", { ciphertext: "xyz" }, "", "");
        expect(ev.getContent().body).toBe("Test");
        expect(ev.getWireContent().body).toBeUndefined();
        expect(ev.getWireContent().ciphertext).toBe("xyz");

        const redaction = new MatrixEvent({
            type: "m.room.redaction",
            redacts: ev.getId(),
        });

        ev.makeRedacted(redaction);
        expect(ev.getContent().body).toBeUndefined();
        expect(ev.getWireContent().body).toBeUndefined();
        expect(ev.getWireContent().ciphertext).toBeUndefined();
    });

    it("should abort decryption if fails with an error other than a DecryptionError", async () => {
        const ev = new MatrixEvent({
            type: EventType.RoomMessageEncrypted,
            content: {
                body: "Test",
            },
            event_id: "$event1:server",
        });
        await ev.attemptDecryption({
            decryptEvent: jest.fn().mockRejectedValue(new Error("Not a DecryptionError")),
        } as unknown as Crypto);
        expect(ev.isEncrypted()).toBeTruthy();
        expect(ev.isBeingDecrypted()).toBeFalsy();
        expect(ev.isDecryptionFailure()).toBeFalsy();
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
        let encryptedEvent;
        const eventId = 'test_encrypted_event';

        beforeEach(() => {
            encryptedEvent = new MatrixEvent({
                event_id: eventId,
                type: 'm.room.encrypted',
                content: {
                    ciphertext: 'secrets',
                },
            });
        });

        it('should retry decryption if a retry is queued', async () => {
            const eventAttemptDecryptionSpy = jest.spyOn(encryptedEvent, 'attemptDecryption');

            const crypto = {
                decryptEvent: jest.fn()
                    .mockImplementationOnce(() => {
                        // schedule a second decryption attempt while
                        // the first one is still running.
                        encryptedEvent.attemptDecryption(crypto);

                        const error = new Error("nope");
                        error.name = 'DecryptionError';
                        return Promise.reject(error);
                    })
                    .mockImplementationOnce(() => {
                        return Promise.resolve({
                            clearEvent: {
                                type: 'm.room.message',
                            },
                        });
                    }),
            };

            await encryptedEvent.attemptDecryption(crypto);

            expect(eventAttemptDecryptionSpy).toHaveBeenCalledTimes(2);
            expect(crypto.decryptEvent).toHaveBeenCalledTimes(2);
            expect(encryptedEvent.getType()).toEqual('m.room.message');
        });
    });
});
