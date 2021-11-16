/**
 * @module logger
 */
import { Logger } from "loglevel";
/**
 * Drop-in replacement for <code>console</code> using {@link https://www.npmjs.com/package/loglevel|loglevel}.
 * Can be tailored down to specific use cases if needed.
 */
export declare const logger: PrefixedLogger;
export interface PrefixedLogger extends Logger {
    withPrefix?: (prefix: string) => PrefixedLogger;
    prefix?: string;
}
//# sourceMappingURL=logger.d.ts.map