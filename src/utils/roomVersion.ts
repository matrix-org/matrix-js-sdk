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

/**
 * Room versions strings that we know about and do not use hydra semantics.
 */
const PRE_HYDRA_ROOM_VERSIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];

/**
 * Checks if the given room version is one where new "hydra" power level
 * semantics (ie. room version 12 or later) should be used
 * (see https://github.com/matrix-org/matrix-spec-proposals/pull/4289).
 * This will return `false` for versions that are known to the js-sdk and
 * do not use hydra: any room versions unknown to the js-sdk (experimental or
 * otherwise) will cause the function to return true.
 *
 * @param roomVersion - The version of the room to check.
 * @returns `true` if hydra semantics should be used for the room version, `false` otherwise.
 */
export function shouldUseHydraForRoomVersion(roomVersion: string): boolean {
    return !PRE_HYDRA_ROOM_VERSIONS.includes(roomVersion);
}
