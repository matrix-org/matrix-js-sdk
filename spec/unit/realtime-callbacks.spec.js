"use strict";

const callbacks = require("../../lib/realtime-callbacks");
const testUtils = require("../test-utils.js");

describe("realtime-callbacks", function() {
    const clock = jasmine.Clock;
    let fakeDate;

    function tick(millis) {
        // make sure we tick the fakedate first, otherwise nothing will happen!
        fakeDate += millis;
        clock.tick(millis);
    }

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this
        clock.useMock();
        fakeDate = Date.now();
        callbacks.setNow(function() {
            return fakeDate;
        });
    });

    afterEach(function() {
        callbacks.setNow();
    });

    describe("setTimeout", function() {
        it("should call the callback after the timeout", function() {
            const callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 100);

            expect(callback).not.toHaveBeenCalled();
            tick(100);
            expect(callback).toHaveBeenCalled();
        });


        it("should default to a zero timeout", function() {
            const callback = jasmine.createSpy();
            callbacks.setTimeout(callback);

            expect(callback).not.toHaveBeenCalled();
            tick(0);
            expect(callback).toHaveBeenCalled();
        });

        it("should pass any parameters to the callback", function() {
            const callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 0, "a", "b", "c");
            tick(0);
            expect(callback).toHaveBeenCalledWith("a", "b", "c");
        });

        it("should set 'this' to the global object", function() {
            const callback = jasmine.createSpy();
            callback.andCallFake(function() {
                expect(this).toBe(global); // eslint-disable-line no-invalid-this
                expect(this.console).toBeDefined(); // eslint-disable-line no-invalid-this
            });
            callbacks.setTimeout(callback);
            tick(0);
            expect(callback).toHaveBeenCalled();
        });

        it("should handle timeouts of several seconds", function() {
            const callback = jasmine.createSpy();
            callbacks.setTimeout(callback, 2000);

            expect(callback).not.toHaveBeenCalled();
            for (let i = 0; i < 4; i++) {
                tick(500);
            }
            expect(callback).toHaveBeenCalled();
        });

        it("should call multiple callbacks in the right order", function() {
            const callback1 = jasmine.createSpy("callback1");
            const callback2 = jasmine.createSpy("callback2");
            const callback3 = jasmine.createSpy("callback3");
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
            const callback1 = jasmine.createSpy("callback1");
            const callback2 = jasmine.createSpy("callback2");

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
            const callback2 = jasmine.createSpy("callback2");
            const callback1 = jasmine.createSpy("callback1");
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
            const callback1 = jasmine.createSpy("callback1");
            callback1.andCallFake(function() {
                throw new Error("prepare to die");
            });
            const callback2 = jasmine.createSpy("callback2");
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
            const callback = jasmine.createSpy();
            const k = callbacks.setTimeout(callback);
            callbacks.clearTimeout(k);
            tick(0);
            expect(callback).not.toHaveBeenCalled();
        });

        it("should not affect sooner timeouts", function() {
            const callback1 = jasmine.createSpy("callback1");
            const callback2 = jasmine.createSpy("callback2");

            callbacks.setTimeout(callback1, 100);
            const k = callbacks.setTimeout(callback2, 200);
            callbacks.clearTimeout(k);

            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();

            tick(150);
            expect(callback2).not.toHaveBeenCalled();
        });
    });
});
