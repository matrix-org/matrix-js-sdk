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
 * Checks if the given room version is a version that is known to use
 * new "hydra" power level semantics (as of room version 12)
 * (see https://github.com/matrix-org/matrix-spec-proposals/pull/4289).
 * Note that this will only return true for versions that are known to
 * the js-sdk': any room version created subsequently will need to be added here
 * if it uses hydra semantics.
 *
 * Once hydra has been rolled out in production for "long enough", it would probably
 * makes sense to assume hydra semantiocs by default and hence check instead for room
 * versions known to use the old semantics.
 *
 * @param roomVersion - The version of the room to check.
 * @returns true if the room version is known to use hydra semantics, false otherwise.
 */
export function roomVersionIsHydra(roomVersion: string): boolean {
    return roomVersion === "org.matrix.hydra.11" || roomVersion === "12";
}
