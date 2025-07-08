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

import { OutdatedKeyFilter } from "../../../src/matrixrtc/utils.ts";
import { type InboundEncryptionSession } from "../../../src/matrixrtc";

describe("OutdatedKeyFilter Test", () => {
    it("Should buffer and disambiguate keys by timestamp", () => {
        const filter = new OutdatedKeyFilter();

        const aKey = fakeInboundSessionWithTimestamp(1000);
        const olderKey = fakeInboundSessionWithTimestamp(300);
        // Simulate receiving out of order keys

        expect(filter.isOutdated(aKey.participantId, aKey)).toBe(false);
        // Then we receive the most recent key out of order
        const isOutdated = filter.isOutdated(aKey.participantId, olderKey);
        // this key is older and should be ignored even if received after
        expect(isOutdated).toBe(true);
    });

    function fakeInboundSessionWithTimestamp(ts: number): InboundEncryptionSession {
        return {
            keyIndex: 0,
            creationTS: ts,
            participantId: "@alice:localhost|ABCDE",
            key: new Uint8Array(16),
        };
    }
});
