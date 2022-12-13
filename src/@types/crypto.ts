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

import type { IClearEvent } from "../models/event";

export type OlmGroupSessionExtraData = {
    untrusted?: boolean;
    sharedHistory?: boolean;
};

/**
 * The result of a (successful) call to {@link Crypto.decryptEvent}
 */
export interface IEventDecryptionResult {
    /**
     * The plaintext payload for the event (typically containing <tt>type</tt> and <tt>content</tt> fields).
     */
    clearEvent: IClearEvent;
    /**
     * List of curve25519 keys involved in telling us about the senderCurve25519Key and claimedEd25519Key.
     * See {@link MatrixEvent#getForwardingCurve25519KeyChain}.
     */
    forwardingCurve25519KeyChain?: string[];
    /**
     * Key owned by the sender of this event.  See {@link MatrixEvent#getSenderKey}.
     */
    senderCurve25519Key?: string;
    /**
     * ed25519 key claimed by the sender of this event. See {@link MatrixEvent#getClaimedEd25519Key}.
     */
    claimedEd25519Key?: string;
    untrusted?: boolean;
}
