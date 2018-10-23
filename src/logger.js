"use strict";
/**
 * @module logger
 */
const log = require("loglevel");

// This is to demonstrate, that you can use any namespace you want.
// Namespaces allow you to turn on/off the logging for specific parts of the
// application.
// An idea would be to control this via an environment variable (on Node.js).
// See https://www.npmjs.com/package/debug to see how this could be implemented
// Part of #332 is introducing a logging library in the first place.
const DEFAULT_NAME_SPACE = "matrix";
const logger = log.getLogger(DEFAULT_NAME_SPACE);
log.setDefaultLevel(log.levels.WARN);

/**
 * Drop-in replacement for <code>console</code> using {@link https://www.npmjs.com/package/loglevel|loglevel}.
 * Can be tailored down to specific use cases if needed.
*/
module.exports.logger = logger;
