"use strict";

var callbacks = require("../../lib/realtime-callbacks");
var test_utils = require("../test-utils.js");

describe("realtime-callbacks", function() {
    var clock = jasmine.Clock;
    var fakeDate;

    function tick(millis) {
        // make sure we tick the fakedate first, otherwise nothing will happen!
        fakeDate += millis;
        clock.tick(millis);
    }

    beforeEach(function() {
        test_utils.beforeEach(this);
        clock.useMock();
        fakeDate = Date.now();
        callbacks.setNow(function() { return fakeDate; });
    });

    afterEach(function() {
        callbacks.setNow();
    });

    describe("setTimeout", function() {
        it("should call the callback after the timeout", function() {
            var callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 100);

            expect(callback).not.toHaveBeenCalled();
            tick(100);
            expect(callback).toHaveBeenCalled();
        });


        it("should default to a zero timeout", function() {
            var callback = jasmine.createSpy();
            callbacks.setTimeout(callback);

            expect(callback).not.toHaveBeenCalled();
            tick(0);
            expect(callback).toHaveBeenCalled();
        });

        it("should pass any parameters to the callback", function() {
            var callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 0, "a", "b", "c");
            tick(0);
            expect(callback).toHaveBeenCalledWith("a", "b", "c");
        });

        it("should set 'this' to the global object", function() {
            var callback = jasmine.createSpy();
            callback.andCallFake(function() {
                expect(this).toBe(global);
                expect(this.console).toBeDefined();
            });
            callbacks.setTimeout(callback);
            tick(0);
            expect(callback).toHaveBeenCalled();
        });

        it("should handle timeouts of several seconds", function() {
            var callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 2000);

            expect(callback).not.toHaveBeenCalled();
            for (var i = 0; i < 4; i++) {
                tick(500);
            }
            expect(callback).toHaveBeenCalled();
        });

        it("should call multiple callbacks in the right order", function() {
            var callback1 = jasmine.createSpy("callback1");
            var callback2 = jasmine.createSpy("callback2");
            var callback3 = jasmine.createSpy("callback3");
            callbacks.setTimeout(callback2, 200);
            callbacks.setTimeout(callback1, 100);
            callbacks.setTimeout(callback3, 300);

            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            expect(callback3).not.toHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            expect(callback3).not.toHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
            expect(callback3).not.toHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
            expect(callback3).toHaveBeenCalled();
        });

        it("should treat -ve timeouts the same as a zero timeout", function() {
            var callback1 = jasmine.createSpy("callback1");
            var callback2 = jasmine.createSpy("callback2");

            // check that cb1 is called before cb2
            callback1.andCallFake(function() {
                expect(callback2).not.toHaveBeenCalled();
            });

            callbacks.setTimeout(callback1);
            callbacks.setTimeout(callback2, -100);

            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });

        it("should not get confused by chained calls", function() {
            var callback2 = jasmine.createSpy("callback2");
            var callback1 = jasmine.createSpy("callback1");
            callback1.andCallFake(function() {
                callbacks.setTimeout(callback2, 0);
                expect(callback2).not.toHaveBeenCalled();
            });

            callbacks.setTimeout(callback1);
            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });

        it("should be immune to exceptions", function() {
            var callback1 = jasmine.createSpy("callback1");
            callback1.andCallFake(function() {
                throw new Error("prepare to die");
            });
            var callback2 = jasmine.createSpy("callback2");
            callbacks.setTimeout(callback1, 0);
            callbacks.setTimeout(callback2, 0);

            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });

    });

    describe("cancelTimeout", function() {
        it("should cancel a pending timeout", function() {
            var callback = jasmine.createSpy();
            var k = callbacks.setTimeout(callback);
            callbacks.clearTimeout(k);
            tick(0);
            expect(callback).not.toHaveBeenCalled();
        });

        it("should not affect sooner timeouts", function() {
            var callback1 = jasmine.createSpy("callback1");
            var callback2 = jasmine.createSpy("callback2");

            callbacks.setTimeout(callback1, 100);
            var k = callbacks.setTimeout(callback2, 200);
            callbacks.clearTimeout(k);

            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();

            tick(150);
            expect(callback2).not.toHaveBeenCalled();
        });
    });
});
