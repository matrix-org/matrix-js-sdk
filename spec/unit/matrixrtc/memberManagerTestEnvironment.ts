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

/*
This file adds a custom test environment for the MembershipManager.spec.ts
It can be used with the comment at the top of the file:

@jest-environment ./spec/unit/matrixrtc/memberManagerTestEnvironment.ts

It is very specific to the MembershipManager.spec.ts file and introduces the following behaviour:
 - The describe each block in the MembershipManager.spec.ts will go through describe block names `LegacyMembershipManager` and `MembershipManager`
 - It will check all tests that are a child or indirect child of the `LegacyMembershipManager` block and skip the ones which include "!FailsForLegacy"
   in their test name.
*/

import { TestEnvironment } from "jest-environment-jsdom";

import { logger as rootLogger } from "../../../src/logger";
const logger = rootLogger.getChild("MatrixRTCSession");

class MemberManagerTestEnvironment extends TestEnvironment {
    handleTestEvent(event: any) {
        if (event.name === "test_start" && event.test.name.includes("!FailsForLegacy")) {
            let parent = event.test.parent;
            let isLegacy = false;
            while (parent) {
                if (parent.name === "LegacyMembershipManager") {
                    isLegacy = true;
                    break;
                } else {
                    parent = parent.parent;
                }
            }
            if (isLegacy) {
                logger.info("skip test: ", event.test.name);
                event.test.mode = "skip";
            }
        }
    }
}
module.exports = MemberManagerTestEnvironment;
