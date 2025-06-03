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
 * Custom vscode option so that we can debug the tests in peace without running into timeouts.
 */
export function setVSCodeJestDebugTimeoutOverride(): void {
    if (process.env.VSCODE_INSPECTOR_OPTIONS) {
        jest.setTimeout(60 * 1000 * 5); // 5 minutes
    }
}
