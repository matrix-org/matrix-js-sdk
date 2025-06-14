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

jest.mock("../src/http-api/utils", () => ({
    ...jest.requireActual("../src/http-api/utils"),
    // We mock timeoutSignal otherwise it causes tests to leave timers running
    timeoutSignal: () => new AbortController().signal,
}));

// Dont make test fail too soon due to timeouts while debugging.
if (process.env.VSCODE_INSPECTOR_OPTIONS) {
    jest.setTimeout(60 * 1000 * 5); // 5 minutes
}
