"use strict";

/**
 * This is a mock framework for an HTTP backend, heavily inspired by Angular.js
 */

function HttpBackend() {
    this.requests = [];
    this.expectedRequests = [];
    var self = this;
    // the request function dependency that the SDK needs.
    this.requestFn = function(opts, callback) {
        var realReq = new Request(opts.method, opts.uri, opts.body, opts.qs);
        realReq.callback = callback;
        self.requests.push(realReq);
    };
}
HttpBackend.prototype = {
    /**
     * Respond to all of the requests (flush the queue).
     */
    flush: function() {
        // if there's more real requests and more expected requests, flush 'em.
        while(this.requests.length > 0 && this.expectedRequests.length > 0) {
            var req = this.requests.shift();
            var i;

            var matchingReq = null;
            for (i = 0; i < this.expectedRequests.length; i++) {
                var expectedReq = this.expectedRequests[i];
                if (expectedReq.method === req.method && 
                        req.path.indexOf(expectedReq.path) !== -1) {
                    if (!expectedReq.data || (JSON.stringify(expectedReq.data) ===
                            JSON.stringify(req.data))) {
                        matchingReq = expectedReq;
                        this.expectedRequests.splice(i, 1);
                        break;
                    }
                }
            }

            if (matchingReq) {
                for (i = 0; i < matchingReq.checks.length; i++) {
                    matchingReq.checks[i](req);
                }
                var testResponse = matchingReq.response;
                req.callback(
                    testResponse.err, testResponse.response, testResponse.body
                );
            }
        }
    },

    /**
     * Makes sure that the SDK hasn't sent any more requests to the backend.
     */
    verifyNoOutstandingRequests: function() {
        var firstOutstandingReq = this.requests[0] || {};
        expect(this.requests.length).toEqual(0,
            "Expected no more HTTP requests but received request to "+
            firstOutstandingReq.path
        );
    },

    /**
     * Makes sure that the test doesn't have any unresolved requests.
     */
    verifyNoOutstandingExpectation: function() {
        var firstOutstandingExpectation = this.expectedRequests[0] || {};
        expect(this.expectedRequests.length).toEqual(0,
            "Expected to see HTTP request for "+firstOutstandingExpectation.path
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
        var pendingReq = new Request(method, path, data);
        this.expectedRequests.push(pendingReq);
        return pendingReq;
    }
};

function Request(method, path, data, queryParams) {
    this.method = method;
    this.path = path;
    this.data = data;
    this.queryParams = queryParams;
    this.callback = null;
    this.response = null;
    this.checks = [];
}
Request.prototype = {
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
     * @param {Object} data The HTTP JSON body.
     */
    respond: function(code, data) {
        this.response = {
            response: {
                statusCode: code,
                headers: {}
            },
            body: data,
            err: null
        };
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
                headers: {}
            },
            body: null,
            err: err
        };
    }
};

module.exports = HttpBackend;
