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
 * The timezone the user is currently in. The value of this property should
 * match a timezone provided in https://www.iana.org/time-zones.
 *
 * This key was introduced in Matrix v1.16.
 */
export const ProfileKeyTimezone = "m.tz";

/**
 * The timezone the user is currently in. The value of this property should
 * match a timezone provided in https://www.iana.org/time-zones.
 *
 * @see https://github.com/matrix-org/matrix-spec-proposals/blob/clokep/profile-tz/proposals/4175-profile-field-time-zone.md
 * @experimental
 * @deprecated Unstable MSC field - Use `ProfileKeyTimezone`
 */
export const ProfileKeyMSC4175Timezone = "us.cloke.msc4175.tz";
