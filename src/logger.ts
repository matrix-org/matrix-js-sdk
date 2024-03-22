/*
Copyright 2018 André Jaenisch
Copyright 2019, 2021 The Matrix.org Foundation C.I.C.

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

import loglevel from "loglevel";

/** Logger interface used within the js-sdk codebase */
export interface Logger extends BaseLogger {
    /**
     * Create a child logger.
     *
     * @param namespace - name to add to the current logger to generate the child. Some implementations of `Logger`
     *    use this as a prefix; others use a different mechanism.
     */
    getChild(namespace: string): Logger;
}

/** The basic interface for a logger which doesn't support children */
export interface BaseLogger {
    /**
     * Output trace message to the logger, with stack trace.
     *
     * @param msg - Data to log.
     */
    trace(...msg: any[]): void;

    /**
     * Output debug message to the logger.
     *
     * @param msg - Data to log.
     */
    debug(...msg: any[]): void;

    /**
     * Output info message to the logger.
     *
     * @param msg - Data to log.
     */
    info(...msg: any[]): void;

    /**
     * Output warn message to the logger.
     *
     * @param msg - Data to log.
     */
    warn(...msg: any[]): void;

    /**
     * Output error message to the logger.
     *
     * @param msg - Data to log.
     */
    error(...msg: any[]): void;
}

// This is to demonstrate, that you can use any namespace you want.
// Namespaces allow you to turn on/off the logging for specific parts of the
// application.
// An idea would be to control this via an environment variable (on Node.js).
// See https://www.npmjs.com/package/debug to see how this could be implemented
// Part of #332 is introducing a logging library in the first place.
const DEFAULT_NAMESPACE = "matrix";

// because rageshakes in react-sdk hijack the console log, also at module load time,
// initializing the logger here races with the initialization of rageshakes.
// to avoid the issue, we override the methodFactory of loglevel that binds to the
// console methods at initialization time by a factory that looks up the console methods
// when logging so we always get the current value of console methods.
loglevel.methodFactory = function (methodName, logLevel, loggerName) {
    return function (this: PrefixedLogger, ...args): void {
        /* eslint-disable @typescript-eslint/no-invalid-this */
        if (this.prefix) {
            args.unshift(this.prefix);
        }
        /* eslint-enable @typescript-eslint/no-invalid-this */
        const supportedByConsole =
            methodName === "error" ||
            methodName === "warn" ||
            methodName === "trace" ||
            methodName === "info" ||
            methodName === "debug";
        /* eslint-disable no-console */
        if (supportedByConsole) {
            return console[methodName](...args);
        } else {
            return console.log(...args);
        }
        /* eslint-enable no-console */
    };
};

/**
 * Implementation of {@link Logger} based on `loglevel`.
 *
 * @deprecated this shouldn't be public; prefer {@link Logger}.
 */
export interface PrefixedLogger extends loglevel.Logger, Logger {
    /** @deprecated prefer {@link Logger.getChild} */
    withPrefix: (prefix: string) => PrefixedLogger;

    /** @deprecated internal property */
    prefix: string;
}

/** Internal utility function to turn a `loglevel.Logger` into a `PrefixedLogger` */
function extendLogger(logger: loglevel.Logger): void {
    const prefixedLogger = <PrefixedLogger>logger;
    prefixedLogger.getChild = prefixedLogger.withPrefix = function (prefix: string): PrefixedLogger {
        const existingPrefix = this.prefix || "";
        return getPrefixedLogger(existingPrefix + prefix);
    };
}

function getPrefixedLogger(prefix: string): PrefixedLogger {
    const prefixLogger = loglevel.getLogger(`${DEFAULT_NAMESPACE}-${prefix}`) as PrefixedLogger;
    if (prefixLogger.prefix !== prefix) {
        // Only do this setup work the first time through, as loggers are saved by name.
        extendLogger(prefixLogger);
        prefixLogger.prefix = prefix;
        prefixLogger.setLevel(loglevel.levels.DEBUG, false);
    }
    return prefixLogger;
}

/**
 * Drop-in replacement for `console` using {@link https://www.npmjs.com/package/loglevel|loglevel}.
 * Can be tailored down to specific use cases if needed.
 */
export const logger = loglevel.getLogger(DEFAULT_NAMESPACE) as PrefixedLogger;
logger.setLevel(loglevel.levels.DEBUG, false);
extendLogger(logger);

/**
 * A "span" for grouping related log lines together.
 *
 * The current implementation just adds the name at the start of each log line.
 *
 * This offers a lighter-weight alternative to 'child' loggers returned by {@link Logger#getChild}. In particular,
 * it's not possible to apply individual filters to the LogSpan such as setting the verbosity level. On the other hand,
 * no reference to the LogSpan is retained in the logging framework, so it is safe to make lots of them over the course
 * of an application's life and just drop references to them when the job is done.
 */
export class LogSpan implements BaseLogger {
    private readonly name;

    public constructor(
        private readonly parent: BaseLogger,
        name: string,
    ) {
        this.name = name + ":";
    }

    public trace(...msg: any[]): void {
        this.parent.trace(this.name, ...msg);
    }

    public debug(...msg: any[]): void {
        this.parent.debug(this.name, ...msg);
    }

    public info(...msg: any[]): void {
        this.parent.info(this.name, ...msg);
    }

    public warn(...msg: any[]): void {
        this.parent.warn(this.name, ...msg);
    }

    public error(...msg: any[]): void {
        this.parent.error(this.name, ...msg);
    }
}
