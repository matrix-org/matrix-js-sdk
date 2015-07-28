"use strict";
var q = require("q");
var sdk = require("../..");
var MatrixScheduler = sdk.MatrixScheduler;
var MatrixError = sdk.MatrixError;
var utils = require("../test-utils");

describe("MatrixScheduler", function() {
    var scheduler;
    var retryFn, queueFn;
    var defer;
    var roomId = "!foo:bar";
    var eventA = utils.mkMessage({
        user: "@alice:bar", room: roomId, event: true
    });
    var eventB = utils.mkMessage({
        user: "@alice:bar", room: roomId, event: true
    });

    beforeEach(function() {
        utils.beforeEach(this);
        jasmine.Clock.useMock();
        scheduler = new MatrixScheduler(function(ev, attempts, err) {
            if (retryFn) {
                return retryFn(ev, attempts, err);
            }
            return -1;
        }, function(event) {
            if (queueFn) {
                return queueFn(event);
            }
            return null;
        });
        retryFn = null;
        queueFn = null;
        defer = q.defer();
    });

    it("should process events in a queue in a FIFO manner", function(done) {
        retryFn = function() {
            return 0;
        };
        queueFn = function() {
            return "one_big_queue";
        };
        var deferA = q.defer();
        var deferB = q.defer();
        var resolvedA = false;
        scheduler.setProcessFunction(function(event) {
            if (resolvedA) {
                expect(event).toEqual(eventB);
                return deferB.promise;
            }
            else {
                expect(event).toEqual(eventA);
                return deferA.promise;
            }
        });
        scheduler.queueEvent(eventA);
        scheduler.queueEvent(eventB).done(function() {
            expect(resolvedA).toBe(true);
            done();
        });
        deferA.resolve({});
        resolvedA = true;
        deferB.resolve({});
    });

    it("should invoke the retryFn on failure and wait the amount of time specified",
    function(done) {
        var waitTimeMs = 1500;
        var retryDefer = q.defer();
        retryFn = function() {
            retryDefer.resolve();
            return waitTimeMs;
        };
        queueFn = function() { return "yep"; };

        var procCount = 0;
        scheduler.setProcessFunction(function(ev) {
            procCount += 1;
            if (procCount === 1) {
                expect(ev).toEqual(eventA);
                return defer.promise;
            }
            else if (procCount === 2) {
                // don't care about this defer
                return q.defer().promise;
            }
            expect(procCount).toBeLessThan(3);
        });

        scheduler.queueEvent(eventA);
        expect(procCount).toEqual(1);
        defer.reject({});
        retryDefer.promise.done(function() {
            expect(procCount).toEqual(1);
            jasmine.Clock.tick(waitTimeMs);
            expect(procCount).toEqual(2);
            done();
        });
    });

    it("should give up if the retryFn on failure returns -1 and try the next event",
    function(done) {
        // Queue A & B.
        // Reject A and return -1 on retry.
        // Expect B to be tried next and the promise for A to be rejected.
        retryFn = function() {
            return -1;
        };
        queueFn = function() { return "yep"; };

        var deferA = q.defer();
        var deferB = q.defer();
        var procCount = 0;
        scheduler.setProcessFunction(function(ev) {
            procCount += 1;
            if (procCount === 1) {
                expect(ev).toEqual(eventA);
                return deferA.promise;
            }
            else if (procCount === 2) {
                expect(ev).toEqual(eventB);
                return deferB.promise;
            }
            expect(procCount).toBeLessThan(3);
        });

        var globalA = scheduler.queueEvent(eventA);
        scheduler.queueEvent(eventB);

        expect(procCount).toEqual(1);
        deferA.reject({});
        globalA.catch(function() {
            expect(procCount).toEqual(2);
            done();
        });
    });

    it("should treat each queue separately", function(done) {
        // Queue messages A B C D.
        // Bucket A&D into queue_A
        // Bucket B&C into queue_B
        // Expect to have processFn invoked for A&B.
        // Resolve A.
        // Expect to have processFn invoked for D.
        var eventC = utils.mkMessage({user: "@a:bar", room: roomId, event: true});
        var eventD = utils.mkMessage({user: "@b:bar", room: roomId, event: true});

        var buckets = {};
        buckets[eventA.getId()] = "queue_A";
        buckets[eventD.getId()] = "queue_A";
        buckets[eventB.getId()] = "queue_B";
        buckets[eventC.getId()] = "queue_B";

        retryFn = function() {
            return 0;
        };
        queueFn = function(event) {
            return buckets[event.getId()];
        };

        var expectOrder = [
            eventA.getId(), eventB.getId(), eventD.getId()
        ];
        var deferA = q.defer();
        scheduler.setProcessFunction(function(event) {
            var id = expectOrder.shift();
            expect(id).toEqual(event.getId());
            if (expectOrder.length === 0) {
                done();
            }
            return id === eventA.getId() ? deferA.promise : defer.promise;
        });
        scheduler.queueEvent(eventA);
        scheduler.queueEvent(eventB);
        scheduler.queueEvent(eventC);
        scheduler.queueEvent(eventD);

        // wait a bit then resolve A and we should get D (not C) next.
        setTimeout(function() {
            deferA.resolve({});
        }, 1000);
        jasmine.Clock.tick(1000);
    });

    describe("queueEvent", function() {
        it("should return null if the event shouldn't be queued", function() {
            queueFn = function() {
                return null;
            };
            expect(scheduler.queueEvent(eventA)).toEqual(null);
        });

        it("should return a Promise if the event is queued", function() {
            queueFn = function() {
                return "yep";
            };
            var prom = scheduler.queueEvent(eventA);
            expect(prom).toBeDefined();
            expect(prom.then).toBeDefined();
        });
    });

    describe("getQueueForEvent", function() {
        it("should return null if the event doesn't map to a queue name", function() {
            queueFn = function() {
                return null;
            };
            expect(scheduler.getQueueForEvent(eventA)).toBeNull();
        });

        it("should return null if the mapped queue doesn't exist", function() {
            queueFn = function() {
                return "yep";
            };
            expect(scheduler.getQueueForEvent(eventA)).toBeNull();
        });

        it("should return a list of events in the queue and modifications to" +
        " the list should not affect the underlying queue.", function() {
            queueFn = function() {
                return "yep";
            };
            scheduler.queueEvent(eventA);
            scheduler.queueEvent(eventB);
            var queue = scheduler.getQueueForEvent(eventA);
            expect(queue.length).toEqual(2);
            expect(queue).toEqual([eventA, eventB]);
            // modify the queue
            var eventC = utils.mkMessage(
                {user: "@a:bar", room: roomId, event: true}
            );
            queue.push(eventC);
            var queueAgain = scheduler.getQueueForEvent(eventA);
            expect(queueAgain.length).toEqual(2);
        });

        it("should return a list of events in the queue and modifications to" +
        " an event in the queue should affect the underlying queue.", function() {
            queueFn = function() {
                return "yep";
            };
            scheduler.queueEvent(eventA);
            scheduler.queueEvent(eventB);
            var queue = scheduler.getQueueForEvent(eventA);
            queue[1].event.content.body = "foo";
            var queueAgain = scheduler.getQueueForEvent(eventA);
            expect(queueAgain[1].event.content.body).toEqual("foo");
        });
    });

    describe("removeEventFromQueue", function() {
        it("should return false if the event doesn't map to a queue name", function() {
            queueFn = function() {
                return null;
            };
            expect(scheduler.removeEventFromQueue(eventA)).toBe(false);
        });

        it("should return false if the event isn't in the queue", function() {
            queueFn = function() {
                return "yep";
            };
            expect(scheduler.removeEventFromQueue(eventA)).toBe(false);
        });

        it("should return true if the event was removed", function() {
            queueFn = function() {
                return "yep";
            };
            scheduler.queueEvent(eventA);
            expect(scheduler.removeEventFromQueue(eventA)).toBe(true);
        });
    });

    describe("setProcessFunction", function() {
        it("should call the processFn if there are queued events", function() {
            queueFn = function() {
                return "yep";
            };
            var procCount = 0;
            scheduler.queueEvent(eventA);
            scheduler.setProcessFunction(function(ev) {
                procCount += 1;
                expect(ev).toEqual(eventA);
                return defer.promise;
            });
            expect(procCount).toEqual(1);
        });

        it("should not call the processFn if there are no queued events", function() {
            queueFn = function() {
                return "yep";
            };
            var procCount = 0;
            scheduler.setProcessFunction(function(ev) {
                procCount += 1;
                return defer.promise;
            });
            expect(procCount).toEqual(0);
        });
    });

    describe("QUEUE_MESSAGES", function() {
        it("should queue m.room.message events only", function() {
            expect(MatrixScheduler.QUEUE_MESSAGES(eventA)).toEqual("message");
            expect(MatrixScheduler.QUEUE_MESSAGES(
                utils.mkMembership({
                    user: "@alice:bar", room: roomId, mship: "join", event: true
                })
            )).toEqual(null);
        });
    });

    describe("RETRY_BACKOFF_RATELIMIT", function() {
        it("should wait at least the time given on M_LIMIT_EXCEEDED", function() {
            var res = MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 1, new MatrixError({
                    errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 5000
                })
            );
            expect(res >= 500).toBe(true, "Didn't wait long enough.");
        });

        it("should give up after 5 attempts", function() {
            var res = MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 5, {}
            );
            expect(res).toBe(-1, "Didn't give up.");
        });

        it("should do exponential backoff", function() {
            expect(MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 1, {}
            )).toEqual(2000);
            expect(MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 2, {}
            )).toEqual(4000);
            expect(MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 3, {}
            )).toEqual(8000);
            expect(MatrixScheduler.RETRY_BACKOFF_RATELIMIT(
                eventA, 4, {}
            )).toEqual(16000);
        });
    });
});
