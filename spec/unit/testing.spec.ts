/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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
    decryptExistingEvent,
    mkDecryptionFailureMatrixEvent,
    mkEncryptedMatrixEvent,
    mkMatrixEvent,
} from "../../src/testing";
import { EventType } from "../../src";
import { DecryptionFailureCode } from "../../src/crypto-api";

describe("testing", () => {
    describe("mkMatrixEvent", () => {
        it("makes an event", () => {
            const event = mkMatrixEvent({
                content: { body: "blah" },
                sender: "@alice:test",
                type: EventType.RoomMessage,
                roomId: "!test:room",
            });

            expect(event.getContent()).toEqual({ body: "blah" });
            expect(event.sender?.userId).toEqual("@alice:test");
            expect(event.isState()).toBe(false);
        });

        it("makes a state event", () => {
            const event = mkMatrixEvent({
                content: { body: "blah" },
                sender: "@alice:test",
                type: EventType.RoomTopic,
                roomId: "!test:room",
                stateKey: "",
            });

            expect(event.getContent()).toEqual({ body: "blah" });
            expect(event.sender?.userId).toEqual("@alice:test");
            expect(event.isState()).toBe(true);
            expect(event.getStateKey()).toEqual("");
        });
    });

    describe("mkEncryptedMatrixEvent", () => {
        it("makes an event", async () => {
            const event = await mkEncryptedMatrixEvent({
                plainContent: { body: "blah" },
                sender: "@alice:test",
                plainType: EventType.RoomMessage,
                roomId: "!test:room",
            });

            expect(event.sender?.userId).toEqual("@alice:test");
            expect(event.isEncrypted()).toBe(true);
            expect(event.isDecryptionFailure()).toBe(false);
            expect(event.decryptionFailureReason).toBe(null);
            expect(event.getContent()).toEqual({ body: "blah" });
            expect(event.getType()).toEqual("m.room.message");
        });
    });

    describe("mkDecryptionFailureMatrixEvent", () => {
        it("makes an event", async () => {
            const event = await mkDecryptionFailureMatrixEvent({
                sender: "@alice:test",
                roomId: "!test:room",
                code: DecryptionFailureCode.UNKNOWN_ERROR,
                msg: "blah",
            });

            expect(event.sender?.userId).toEqual("@alice:test");
            expect(event.isEncrypted()).toBe(true);
            expect(event.isDecryptionFailure()).toBe(true);
            expect(event.decryptionFailureReason).toEqual(DecryptionFailureCode.UNKNOWN_ERROR);
            expect(event.getContent()).toEqual({
                body: "** Unable to decrypt: DecryptionError: blah **",
                msgtype: "m.bad.encrypted",
            });
            expect(event.getType()).toEqual("m.room.message");
            expect(event.isState()).toBe(false);
        });
    });

    describe("decryptExistingEvent", () => {
        it("decrypts an event", async () => {
            const event = await mkDecryptionFailureMatrixEvent({
                sender: "@alice:test",
                roomId: "!test:room",
                code: DecryptionFailureCode.UNKNOWN_ERROR,
                msg: "blah",
            });

            expect(event.isEncrypted()).toBe(true);
            expect(event.isDecryptionFailure()).toBe(true);
            await decryptExistingEvent(event, {
                plainContent: { body: "blah" },
                plainType: "m.room.test",
            });

            expect(event.isEncrypted()).toBe(true);
            expect(event.isDecryptionFailure()).toBe(false);
            expect(event.decryptionFailureReason).toBe(null);
            expect(event.getContent()).toEqual({ body: "blah" });
            expect(event.getType()).toEqual("m.room.test");
        });
    });
});
