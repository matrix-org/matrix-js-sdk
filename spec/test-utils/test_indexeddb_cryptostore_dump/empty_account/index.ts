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

import { DumpDataSetInfo } from "../index";

/**
 * A key query response containing the current keys of the tested user.
 * To be used during tests with fetchmock.
 */
const KEYS_QUERY_RESPONSE = { device_keys: { "@emptyuser:example.com": {} } };

/**
 * A dataset containing the information for the tested user.
 * To be used during tests.
 */
export const EMPTY_ACCOUNT_DATASET: DumpDataSetInfo = {
    userId: "@emptyuser:example.com",
    deviceId: "EMPTYDEVIC",
    pickleKey: "+/bcdefghijklmnopqrstu1/zyxvutsrqponmlkjih2",
    keyQueryResponse: KEYS_QUERY_RESPONSE,
    dumpPath: "spec/test-utils/test_indexeddb_cryptostore_dump/empty_account/dump.json",
};
