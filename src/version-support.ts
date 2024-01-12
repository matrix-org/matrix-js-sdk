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

/**
 * The minimum Matrix specification version the js-sdk supports.
 *
 * (This means that we require any servers we connect to to declare support for this spec version, so it is important
 * for it not to be too old, as well as not too new.)
 */
export const MINIMUM_MATRIX_VERSION = "v1.5";
