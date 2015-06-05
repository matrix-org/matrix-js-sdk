"use strict";

function HttpBackend() {
    this.requests = [];
    this.expectedRequests = [];
    var self = this;
    this.requestFn = function(opts, callback) {
        var realReq = new Request(opts.method, opts.uri, opts.body, opts.qs);
        realReq.callback = callback;
        self.requests.push(realReq);
    }
};
HttpBackend.prototype = {
    flush: function() {
        // if there's more real requests and more expected requests, flush 'em.
        while(this.requests.length > 0 && this.expectedRequests.length > 0) {
            var req = this.requests.shift();

            var matchingReq = null;
            for (var i = 0; i < this.expectedRequests.length; i++) {
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
                matchingReq.checks.forEach(function(check) {
                    check(req);
                });
                var testResponse = matchingReq.response;
                req.callback(
                    testResponse.err, testResponse.response, testResponse.body
                );
            }
        }
    },
    verifyNoOutstandingRequests: function() {
        var firstOutstandingReq = this.requests[0] || {};
        expect(this.requests.length).toEqual(0,
            "Expected no more HTTP requests but received request to "+
            firstOutstandingReq.path
        );
    },
    verifyNoOutstandingExpectation: function() {
        var firstOutstandingExpectation = this.expectedRequests[0] || {};
        expect(this.expectedRequests.length).toEqual(0,
            "Expected to see HTTP request for "+firstOutstandingExpectation.path
        );
    },
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
};
Request.prototype = {
    check: function(fn) {
        this.checks.push(fn);
        return this;
    },
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
