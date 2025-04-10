/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { KeyBuffer } from "../../../src/matrixrtc/utils.ts";
import { type InboundEncryptionSession } from "../../../src/matrixrtc";

describe("KeyBuffer Test", () => {
    it("Should buffer and disambiguate keys by timestamp", () => {
        jest.useFakeTimers();

        const buffer = new KeyBuffer(1000);

        const aKey = fakeInboundSessionWithTimestamp(1000);
        const olderKey = fakeInboundSessionWithTimestamp(300);
        // Simulate receiving out of order keys

        const init = buffer.disambiguate(aKey.participantId, aKey);
        expect(init).toEqual(aKey);
        // Some time pass
        jest.advanceTimersByTime(600);
        // Then we receive the most recent key out of order

        const key = buffer.disambiguate(aKey.participantId, olderKey);
        // this key is older and should be ignored even if received after
        expect(key).toBe(null);
    });

    it("Should clear buffer after ttl", () => {
        jest.useFakeTimers();

        const buffer = new KeyBuffer(1000);

        const aKey = fakeInboundSessionWithTimestamp(1000);
        const olderKey = fakeInboundSessionWithTimestamp(300);
        // Simulate receiving out of order keys

        const init = buffer.disambiguate(aKey.participantId, aKey);
        expect(init).toEqual(aKey);

        // Similar to previous test but there is too much delay
        // We don't want to keep key material for too long
        jest.advanceTimersByTime(1200);

        const key = buffer.disambiguate(aKey.participantId, olderKey);
        // The buffer is cleared so should return this key
        expect(key).toBe(olderKey);
    });

    function fakeInboundSessionWithTimestamp(ts: number): InboundEncryptionSession {
        return {
            keyId: 0,
            creationTS: ts,
            participantId: "@alice:localhost|ABCDE",
            key: new Uint8Array(16),
        };
    }
});
