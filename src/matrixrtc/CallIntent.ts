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

import { type RTCCallIntent } from "./types.ts";

/**
 * The member intends to join the call sending audio only.
 *
 * @experimental Part of [MSC4196](https://github.com/matrix-org/matrix-spec-proposals/pull/4196).
 */
export const RTC_CALL_INTENT_AUDIO = "m.audio";

/**
 * The member intends to join the call with both audio and video.
 *
 * @experimental Part of [MSC4196](https://github.com/matrix-org/matrix-spec-proposals/pull/4196).
 */
export const RTC_CALL_INTENT_VIDEO = "m.video";

const UNSTABLE_RTC_CALL_INTENT_AUDIO = "audio";
const UNSTABLE_RTC_CALL_INTENT_VIDEO = "video";

/**
 * If the input is an unstable call intent (`audio` or `video`), maps it to the stable intent (`m.audio` or `m.video`).
 * Otherwise, returns the intent unchanged.
 *
 * @experimental Part of [MSC4196](https://github.com/matrix-org/matrix-spec-proposals/pull/4196).
 */
export function toStableCallIntent(intent: RTCCallIntent | undefined): RTCCallIntent | undefined {
    switch (intent) {
        case UNSTABLE_RTC_CALL_INTENT_AUDIO:
            return RTC_CALL_INTENT_AUDIO;
        case UNSTABLE_RTC_CALL_INTENT_VIDEO:
            return RTC_CALL_INTENT_VIDEO;
        default:
            return intent;
    }
}

/**
 * If the input is a stable call intent (`m.audio` or `m.video`), maps it to the unstable intent (`audio` or `video`).
 * Otherwise, returns the intent unchanged.
 *
 * @experimental Part of [MSC4196](https://github.com/matrix-org/matrix-spec-proposals/pull/4196).
 */
export function toUnstableCallIntent(intent: RTCCallIntent | undefined): RTCCallIntent | undefined {
    switch (intent) {
        case RTC_CALL_INTENT_AUDIO:
            return UNSTABLE_RTC_CALL_INTENT_AUDIO;
        case RTC_CALL_INTENT_VIDEO:
            return UNSTABLE_RTC_CALL_INTENT_VIDEO;
        default:
            return intent;
    }
}
