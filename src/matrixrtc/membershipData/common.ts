/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import type { IContent } from "../../models/event.ts";

/**
 * Whether the content of an `m.rtc.member` or `m.call.member` event represents a left membership.
 *
 * @experimental Part of [MSC4143](https://github.com/matrix-org/matrix-spec-proposals/pull/4143).
 */
export function isLeftMembershipContent(content: IContent): boolean {
    // Leaving a slot is expressed through setting membership to leave.
    if (content.member?.membership === "leave") return true;
    // Events predating the membership roperty instead emptied the content except for
    // the slot ID and the sticky key.
    return Object.keys(content).every((key) => key === "slot_id" || key === "msc4354_sticky_key");
}

/**
 * Thrown when an event is not valid for use with MatrixRTC.
 */
export class MatrixRTCMembershipParseError extends AggregateError {
    public constructor(
        public readonly type: string,
        errors: string[],
    ) {
        super(errors, `Does not match ${type}:\n${errors.join("\n")}`);
    }
}
