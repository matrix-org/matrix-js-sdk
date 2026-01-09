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

/* eslint-disable no-console */

import { Reporter } from "vitest/reporters";
import { TestCase, TestModule, TestResult, TestSuite } from "vitest/node";

interface Options {
    numTests: number;
}

interface Result {
    duration: number;
    path: string;
    name?: string;
}

export default class VitestSlowTestReporter implements Reporter {
    private tests: Result[] = [];
    private modules: Result[] = [];
    private options: Partial<Options>;

    constructor(options?: Partial<Options>) {
        this.options = options;
    }

    onTestSuiteResult(testSuite: TestSuite) {
        const displayResult = (results: Result[], isModule = false) => {
            if (!isModule) console.log();

            results.sort((a, b) => b.duration - a.duration);
            const rootPathRegex = new RegExp(`^${process.cwd()}`);
            const slowestTests = results.slice(0, this.options.numTests || 10);
            const slowTestTime = this._slowTestTime(slowestTests);
            const allTestTime = this._allTestTime(results);
            const percentTime = (slowTestTime / allTestTime) * 100;

            if (isModule) {
                console.log(
                    `Top ${slowestTests.length} slowest test suites (${slowTestTime / 1000} seconds,` +
                        ` ${percentTime.toFixed(1)}% of total time):`,
                );
            } else {
                console.log(
                    `Top ${slowestTests.length} slowest tests (${slowTestTime / 1000} seconds,` +
                        ` ${percentTime.toFixed(1)}% of total time):`,
                );
            }

            for (let i = 0; i < slowestTests.length; i++) {
                const duration = slowestTests[i].duration;
                const filePath = slowestTests[i].path.replace(rootPathRegex, ".");

                if (isModule) {
                    console.log(`  ${duration / 1000} seconds ${filePath}`);
                } else {
                    const fullName = slowestTests[i].name;
                    console.log(`  ${fullName}`);
                    console.log(`    ${duration / 1000} seconds ${filePath}`);
                }
            }
            console.log();
        };

        displayResult(this.tests);
        displayResult(this.modules, true);
    }

    onTestModuleEnd(testModule: TestModule) {
        this.modules.push({
            duration: testModule.diagnostic().duration,
            path: testModule.location, // TODO
        });
    }

    onTestCaseResult(testCase: TestCase) {
        this.tests.push({
            duration: testCase.diagnostic().duration,
            name: testCase.fullName,
            path: testCase.module.moduleId,
        });
    }

    _slowTestTime(slowestTests) {
        let slowTestTime = 0;
        for (let i = 0; i < slowestTests.length; i++) {
            slowTestTime += slowestTests[i].duration;
        }
        return slowTestTime;
    }

    _allTestTime(result) {
        let allTestTime = 0;
        for (let i = 0; i < result.length; i++) {
            allTestTime += result[i].duration;
        }
        return allTestTime;
    }
}
