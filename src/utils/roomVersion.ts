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
const HYDRA_ROOM_VERSIONS = ["org.matrix.hydra.11", "12"];

/**
 * Checks if the given room version is one where new "hydra" power level
 * semantics (ie. room version 12 or later) should be used
 * (see https://github.com/matrix-org/matrix-spec-proposals/pull/4289).
 * This will return `true` for versions that are known to the js-sdk and
 * use hydra: any room versions unknown to the js-sdk (experimental or
 * otherwise) will cause the function to return `false`.
 *
 * @param roomVersion - The version of the room to check.
 * @returns `true` if hydra semantics should be used for the room version, `false` otherwise.
 */
export function shouldUseHydraForRoomVersion(roomVersion: string): boolean {
    // Future new room versions must obviously be added to the constant above,
    // otherwise the js-sdk will use the old, pre-hydra semantics. At some point
    // it would make sense to assume hydra for unknown versions but this will break
    // any rooms using unknown versions, so at hydra switch time we've agreed all
    // Element clients will only use hydra for the two specific hydra versions.
    return HYDRA_ROOM_VERSIONS.includes(roomVersion);
}
