/*
Copyright 2018 André Jaenisch
Copyright 2019-2025 The Matrix.org Foundation C.I.C.

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

/** Backwards-compatibility hack to expose `log` to applications that might still be relying on it. */
interface LoggerWithLogMethod extends Logger {
    /**
     * Output debug message to the logger.
     *
     * @param msg - Data to log.
     *
     * @deprecated prefer {@link Logger.debug}.
     */
    log(...msg: any[]): void;
}

/** Logger interface used within the js-sdk codebase */
export interface Logger extends BaseLogger {
    /**
     * Create a child logger.
     *
     * This child will use the `methodFactory` of the parent, so any log extensions applied to the parent
     * at the time of calling `getChild` will be applied to the child as well.
     * It will NOT apply changes to the parent's `methodFactory` after the child was created.
     * Those changes need to be applied to the child manually.
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
 */
interface PrefixedLogger extends loglevel.Logger, LoggerWithLogMethod {
    prefix?: string;
}

/**
 * Internal utility function: gets a {@link Logger} based on `loglevel`.
 *
 * Child loggers produced by {@link Logger.getChild} add the name of the child logger as a prefix on each log line.
 *
 * @param prefix Prefix to add to each logged line. If undefined, no prefix will be added.
 */
function getPrefixedLogger(prefix?: string): PrefixedLogger {
    const loggerName = DEFAULT_NAMESPACE + (prefix === undefined ? "" : `-${prefix}`);
    const prefixLogger = loglevel.getLogger(loggerName) as PrefixedLogger;

    if (prefixLogger.getChild === undefined) {
        // This is a new loglevel Logger which has not been turned into a PrefixedLogger yet.
        prefixLogger.prefix = prefix;
        prefixLogger.getChild = (childPrefix): Logger => {
            // create the new child logger
            const childLogger = getPrefixedLogger((prefix ?? "") + childPrefix);
            // Assign the methodFactory from the parent logger.
            // This is useful if we add extensions to the parent logger that modifies
            // its methodFactory. (An example extension is: storing each log to a rageshake db)
            childLogger.methodFactory = prefixLogger.methodFactory;
            // Rebuild the child logger with the new methodFactory.
            childLogger.rebuild();
            return childLogger;
        };
        prefixLogger.setLevel(loglevel.levels.DEBUG, false);
    }

    return prefixLogger;
}

/**
 * Drop-in replacement for `console` using {@link https://www.npmjs.com/package/loglevel|loglevel}.
 * Can be tailored down to specific use cases if needed.
 *
 * @deprecated avoid the use of this unless you are the constructor of `MatrixClient`: you should be using the logger
 *    associated with `MatrixClient`.
 */
export const logger = getPrefixedLogger() as LoggerWithLogMethod;

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

/**
 * A simplification of the `Debugger` type exposed by the `debug` library. We reimplement the bits we need here
 * to avoid a dependency on `debug`.
 */
interface Debugger {
    (formatter: any, ...args: any[]): void;
    extend: (namespace: string, delimiter?: string) => Debugger;
}

/**
 * A `Logger` instance, suitable for use in {@link ICreateClientOpts.logger}, which will write to the `debug` library.
 *
 * @example
 * ```js
 *     import debug from "debug";
 *
 *     const client = createClient({
 *         baseUrl: homeserverUrl,
 *         userId: userId,
 *         accessToken: "akjgkrgjs",
 *         deviceId: "xzcvb",
 *         logger: new DebugLogger(debug(`matrix-js-sdk:${userId}`)),
 *     });
 * ```
 */
export class DebugLogger implements Logger {
    public constructor(private debugInstance: Debugger) {}

    public trace(...msg: any[]): void {
        this.debugWithPrefix("[TRACE]", ...msg);
    }

    public debug(...msg: any[]): void {
        this.debugWithPrefix("[DEBUG]", ...msg);
    }

    public info(...msg: any[]): void {
        this.debugWithPrefix("[INFO]", ...msg);
    }

    public warn(...msg: any[]): void {
        this.debugWithPrefix("[WARN]", ...msg);
    }

    public error(...msg: any[]): void {
        this.debugWithPrefix("[ERROR]", ...msg);
    }

    public getChild(namespace: string): DebugLogger {
        return new DebugLogger(this.debugInstance.extend(namespace));
    }

    private debugWithPrefix(prefix: string, ...msg: any[]): void {
        let formatter: string;

        // Convert the first argument to a string, so that we can safely add a prefix. This is much the same logic that
        // `debug()` uses.
        if (msg.length === 0) {
            formatter = "";
        } else if (msg[0] instanceof Error) {
            const err = msg.shift();
            formatter = err.stack || err.message;
        } else if (typeof msg[0] == "string") {
            formatter = msg.shift();
        } else {
            formatter = "%O";
        }
        this.debugInstance(prefix + " " + formatter, ...msg);
    }
}
