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

/* eslint-disable no-console */

import loglevel from "loglevel";

import { DebugLogger, logger } from "../../src/logger.ts";

afterEach(() => {
    jest.restoreAllMocks();
});

describe("logger", () => {
    it("should log to console by default", () => {
        jest.spyOn(console, "debug").mockReturnValue(undefined);
        logger.debug("test1");
        logger.log("test2");

        expect(console.debug).toHaveBeenCalledWith("test1");
        expect(console.debug).toHaveBeenCalledWith("test2");
    });

    it("should allow creation of child loggers which add a prefix", () => {
        jest.spyOn(loglevel, "getLogger");
        jest.spyOn(console, "debug").mockReturnValue(undefined);

        const childLogger = logger.getChild("[prefix1]");
        expect(loglevel.getLogger).toHaveBeenCalledWith("matrix-[prefix1]");
        childLogger.debug("test1");
        expect(console.debug).toHaveBeenCalledWith("[prefix1]", "test1");

        const grandchildLogger = childLogger.getChild("[prefix2]");
        expect(loglevel.getLogger).toHaveBeenCalledWith("matrix-[prefix1][prefix2]");
        grandchildLogger.debug("test2");
        expect(console.debug).toHaveBeenCalledWith("[prefix1][prefix2]", "test2");
    });
});

describe("DebugLogger", () => {
    it("should handle empty log messages", () => {
        const mockTarget = jest.fn();
        const logger = new DebugLogger(mockTarget as any);
        logger.info();
        expect(mockTarget).toHaveBeenCalledTimes(1);
        expect(mockTarget).toHaveBeenCalledWith("[INFO] ");
    });

    it("should handle logging an Error", () => {
        const mockTarget = jest.fn();
        const logger = new DebugLogger(mockTarget as any);

        // If there is a stack and a message, we use the stack.
        const error = new Error("I am an error");
        logger.error(error);
        expect(mockTarget).toHaveBeenCalledTimes(1);
        expect(mockTarget).toHaveBeenCalledWith(expect.stringMatching(/^\[ERROR\] Error: I am an error\n\s*at/));

        mockTarget.mockClear();

        // If there is only a message, we use that.
        error.stack = undefined;
        logger.error(error);
        expect(mockTarget).toHaveBeenCalledTimes(1);
        expect(mockTarget).toHaveBeenCalledWith("[ERROR] I am an error");
    });

    it("should handle logging an object", () => {
        const mockTarget = jest.fn();
        const logger = new DebugLogger(mockTarget as any);

        const obj = { a: 1 };
        logger.warn(obj);
        expect(mockTarget).toHaveBeenCalledTimes(1);
        expect(mockTarget).toHaveBeenCalledWith("[WARN] %O", obj);
    });
});
