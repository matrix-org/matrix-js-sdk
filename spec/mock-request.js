"use strict";
const q = require("q");
let fakeDate;
let callbacks = require("../lib/realtime-callbacks");

let tick = function tick(millis) {
    // make sure we tick the fakedate first, otherwise nothing will happen!
    fakeDate += millis;
    jasmine.Clock.tick(millis);
};


/**
 * Construct a mock HTTP backend, heavily inspired by Angular.js.
 * @constructor
 */
function HttpBackend(useMockClock) {
    this.requests = [];
    this.expectedRequests = [];
    this.useMockClock = useMockClock ? true : false
    const self = this;

    // the request function dependency that the SDK needs.
    this.requestFn = function(opts, callback) {
        const req = new Request(opts, callback);
        console.log("HTTP backend received request: %s", req);
        self.requests.push(req);

        const abort = function() {
            const idx = self.requests.indexOf(req);
            if (idx >= 0) {
                console.log("Aborting HTTP request: %s %s", opts.method,
                            opts.uri);
                self.requests.splice(idx, 1);
                req.callback("aborted");
            }
        };

        return {
            abort: abort,
        };
    };
}
HttpBackend.prototype = {
    /**
     * Respond to all of the requests (flush the queue).
     * @param {string} path The path to flush (optional) default: all.
     * @param {integer} numToFlush The number of things to flush (optional), default: all.
     * @return {Promise} resolved when there is nothing left to flush.
     */
    flush: function(path, numToFlush) {
        const defer = q.defer();
        const self = this;
        let flushed = 0;
        let waitLoops = 0;
        console.log(
            "HTTP backend flushing... (path=%s  numToFlush=%s)", path, numToFlush,
        );
        // Mock out Clock for .timeout() tests
        if (this.useMockClock) {
            jasmine.Clock.useMock();
            fakeDate = Date.now();
            callbacks.setNow(function() {
                return fakeDate;
            });
        }

        const tryFlush = function tryFlush() {
            // if there's more real requests and more expected requests, flush 'em.
            console.log(
                "  trying to flush queue => reqs=%s expected=%s [%s]",
                self.requests.length, self.expectedRequests.length, path,
            );
            if (self._takeFromQueue(path)) {
                // try again on the next tick.
                console.log("  flushed. Trying for more. [%s]", path);
                flushed += 1;
                if (numToFlush && flushed === numToFlush) {
                    console.log("  [%s] Flushed assigned amount: %s", path, numToFlush);
                    // Restore Clock
                    if (self.useMockClock) {
                        callbacks.setNow();
                    }
                    defer.resolve();
                } else {
                    setImmediate(tryFlush);
                }
            } else if (flushed === 0 && waitLoops < 50) {
                waitLoops += 1
                setImmediate(tryFlush);
            } else {
                console.log("  no more flushes. [%s]", path);
                // Restore Clock
                if (self.useMockClock) {
                    callbacks.setNow();
                }
                defer.resolve();
            }
        };
        setImmediate(tryFlush);
        return defer.promise;
    },

    /**
     * Attempts to resolve requests/expected requests.
     * @param {string} path The path to flush (optional) default: all.
     * @return {boolean} true if something was resolved.
     */
    _takeFromQueue: function(path) {
        let req = null;
        let i;
        let j;
        let matchingReq = null;
        let expectedReq = null;
        let testResponse = null;
        for (i = 0; i < this.requests.length; i++) {
            req = this.requests[i];
            for (j = 0; j < this.expectedRequests.length; j++) {
                expectedReq = this.expectedRequests[j];
                if (path && path !== expectedReq.path) {
                    continue;
                }
                if (expectedReq.method === req.method &&
                        req.path.indexOf(expectedReq.path) !== -1) {
                    if (!expectedReq.data || (JSON.stringify(expectedReq.data) ===
                            JSON.stringify(req.data))) {
                        matchingReq = expectedReq;
                        this.expectedRequests.splice(j, 1);
                        break;
                    }
                }
            }

            if (matchingReq) {
                // remove from request queue
                this.requests.splice(i, 1);
                i--;

                for (j = 0; j < matchingReq.checks.length; j++) {
                    matchingReq.checks[j](req);
                }
                testResponse = matchingReq.response;
                if (matchingReq._waitMs) {
                    tick(matchingReq._waitMs);
                }
                console.log("    responding to %s", matchingReq.path);
                let body = testResponse.body;
                if (Object.prototype.toString.call(body) == "[object Function]") {
                    body = body(req.path, req.data);
                }
                req.callback(
                    testResponse.err, testResponse.response, body,
                );
                matchingReq = null;
            }
        }
        if (testResponse) {  // flushed something
            return true;
        }
        return false;
    },

    /**
     * Makes sure that the SDK hasn't sent any more requests to the backend.
     */
    verifyNoOutstandingRequests: function() {
        const firstOutstandingReq = this.requests[0] || {};
        expect(this.requests.length).toEqual(0,
            "Expected no more HTTP requests but received request to " +
            firstOutstandingReq.path,
        );
    },

    /**
     * Makes sure that the test doesn't have any unresolved requests.
     */
    verifyNoOutstandingExpectation: function() {
        const firstOutstandingExpectation = this.expectedRequests[0] || {};
        expect(this.expectedRequests.length).toEqual(0,
            "Expected to see HTTP request for " + firstOutstandingExpectation.path,
        );
    },

    /**
     * Create an expected request.
     * @param {string} method The HTTP method
     * @param {string} path The path (which can be partial)
     * @param {Object} data The expected data.
     * @return {Request} An expected request.
     */
    when: function(method, path, data) {
        const pendingReq = new ExpectedRequest(method, path, data);
        this.expectedRequests.push(pendingReq);
        return pendingReq;
    },
};

/**
 * Represents the expectation of a request.
 *
 * <p>Includes the conditions to be matched against, the checks to be made,
 * and the response to be returned.
 *
 * @constructor
 * @param {string} method
 * @param {string} path
 * @param {object?} data
 */
function ExpectedRequest(method, path, data) {
    this.method = method;
    this.path = path;
    this.data = data;
    this.response = null;
    this.checks = [];
}

ExpectedRequest.prototype = {
    /**
     * Execute a check when this request has been satisfied.
     * @param {Function} fn The function to execute.
     * @return {Request} for chaining calls.
     */
    check: function(fn) {
        this.checks.push(fn);
        return this;
    },

    /**
     * Respond with the given data when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Object|Function} data The HTTP JSON body. If this is a function,
     * it will be invoked when the JSON body is required (which should be returned).
     * @return {Request} for chaining calls.
     */
    respond: function(code, data) {
        this.response = {
            response: {
                statusCode: code,
                headers: {},
            },
            body: data,
            err: null,
        };
        return this;
    },

    /**
     * Fail with an Error when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Error} err The error to throw (e.g. Network Error)
     */
    fail: function(code, err) {
        this.response = {
            response: {
                statusCode: code,
                headers: {},
            },
            body: null,
            err: err,
        };
    },

    /**
     * Advance the time before processing a request by waitMs.
     *
     * @param {Number} waitMs number of miliseconds of timeout.
     * @return {Request} for chaining calls.
     */
    waitFor: function(waitMs) {
        this._waitMs = waitMs;
        return this;
    },
};

/**
 * Represents a request made by the app.
 *
 * @constructor
 * @param {object} opts opts passed to request()
 * @param {function} callback
 */
function Request(opts, callback) {
    this.opts = opts;
    this.callback = callback;

    Object.defineProperty(this, 'method', {
        get: function() {
            return opts.method;
        },
    });

    Object.defineProperty(this, 'path', {
        get: function() {
            return opts.uri;
        },
    });

    Object.defineProperty(this, 'data', {
        get: function() {
            return opts.body;
        },
    });

    Object.defineProperty(this, 'queryParams', {
        get: function() {
            return opts.qs;
        },
    });

    Object.defineProperty(this, 'headers', {
        get: function() {
            return opts.headers || {};
        },
    });
}

Request.prototype = {
    toString: function() {
        return this.method + " " + this.path;
    },
};

/**
 * The HttpBackend class.
 */
module.exports = HttpBackend;
