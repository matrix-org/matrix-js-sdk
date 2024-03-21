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

/*
 * This file is a secondary entrypoint for the js-sdk library, for use by Typescript projects.
 * It exposes low-level types and interfaces reflecting structures defined in the Matrix specification.
 *
 * Remember to only export *public* types from this file.
 */

export type * from "./@types/media";
export * from "./@types/membership";
export type * from "./@types/event";
export type * from "./@types/state_events";
