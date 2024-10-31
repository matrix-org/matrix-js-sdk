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
 * A list of the spec versions which the js-sdk is compatible with.
 *
 * In practice, this means: when we connect to a server, it must declare support for one of the versions in this list.
 *
 * Note that it does not *necessarily* mean that the js-sdk has good support for all the features in the listed spec
 * versions; only that we should be able to provide a base level of functionality with a server that offers support for
 * any of the listed versions.
 */
export const SUPPORTED_MATRIX_VERSIONS = ["v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9"];

/**
 * The oldest Matrix specification version the js-sdk supports.
 */
export const MINIMUM_MATRIX_VERSION = SUPPORTED_MATRIX_VERSIONS[0];

/**
 * The most recent Matrix specification version the js-sdk supports.
 */
export const MAXIMUM_MATRIX_VERSION = SUPPORTED_MATRIX_VERSIONS[SUPPORTED_MATRIX_VERSIONS.length - 1];
