"use strict";

import 'source-map-support/register';
const callbacks = require("../../lib/realtime-callbacks");
const testUtils = require("../test-utils.js");

import expect from 'expect';
import lolex from 'lolex';

describe("realtime-callbacks", function() {
    let clock;

    function tick(millis) {
        clock.tick(millis);
    }

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this
        clock = lolex.install();
        const fakeDate = clock.Date;
        callbacks.setNow(fakeDate.now.bind(fakeDate));
    });

    afterEach(function() {
        callbacks.setNow();
        clock.uninstall();
    });

    describe("setTimeout", function() {
        it("should call the callback after the timeout", function() {
            const callback = expect.createSpy();
            callbacks.setTimeout(callback, 100);

            expect(callback).toNotHaveBeenCalled();
            tick(100);
            expect(callback).toHaveBeenCalled();
        });


        it("should default to a zero timeout", function() {
            const callback = expect.createSpy();
            callbacks.setTimeout(callback);

            expect(callback).toNotHaveBeenCalled();
            tick(0);
            expect(callback).toHaveBeenCalled();
        });

        it("should pass any parameters to the callback", function() {
            const callback = expect.createSpy();
            callbacks.setTimeout(callback, 0, "a", "b", "c");
            tick(0);
            expect(callback).toHaveBeenCalledWith("a", "b", "c");
        });

        it("should set 'this' to the global object", function() {
            let passed = false;
            const callback = function() {
                expect(this).toBe(global); // eslint-disable-line no-invalid-this
                expect(this.console).toBeTruthy(); // eslint-disable-line no-invalid-this
                passed = true;
            };
            callbacks.setTimeout(callback);
            tick(0);
            expect(passed).toBe(true);
        });

        it("should handle timeouts of several seconds", function() {
            const callback = expect.createSpy();
            callbacks.setTimeout(callback, 2000);

            expect(callback).toNotHaveBeenCalled();
            for (let i = 0; i < 4; i++) {
                tick(500);
            }
            expect(callback).toHaveBeenCalled();
        });

        it("should call multiple callbacks in the right order", function() {
            const callback1 = expect.createSpy();
            const callback2 = expect.createSpy();
            const callback3 = expect.createSpy();
            callbacks.setTimeout(callback2, 200);
            callbacks.setTimeout(callback1, 100);
            callbacks.setTimeout(callback3, 300);

            expect(callback1).toNotHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();
            expect(callback3).toNotHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();
            expect(callback3).toNotHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
            expect(callback3).toNotHaveBeenCalled();
            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
            expect(callback3).toHaveBeenCalled();
        });

        it("should treat -ve timeouts the same as a zero timeout", function() {
            const callback1 = expect.createSpy();
            const callback2 = expect.createSpy();

            // check that cb1 is called before cb2
            callback1.andCall(function() {
                expect(callback2).toNotHaveBeenCalled();
            });

            callbacks.setTimeout(callback1);
            callbacks.setTimeout(callback2, -100);

            expect(callback1).toNotHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });

        it("should not get confused by chained calls", function() {
            const callback2 = expect.createSpy();
            const callback1 = expect.createSpy();
            callback1.andCall(function() {
                callbacks.setTimeout(callback2, 0);
                expect(callback2).toNotHaveBeenCalled();
            });

            callbacks.setTimeout(callback1);
            expect(callback1).toNotHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            // the fake timer won't actually run callbacks registered during
            // one tick until the next tick.
            tick(1);
            expect(callback2).toHaveBeenCalled();
        });

        it("should be immune to exceptions", function() {
            const callback1 = expect.createSpy();
            callback1.andCall(function() {
                throw new Error("prepare to die");
            });
            const callback2 = expect.createSpy();
            callbacks.setTimeout(callback1, 0);
            callbacks.setTimeout(callback2, 0);

            expect(callback1).toNotHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();
            tick(0);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });
    });

    describe("cancelTimeout", function() {
        it("should cancel a pending timeout", function() {
            const callback = expect.createSpy();
            const k = callbacks.setTimeout(callback);
            callbacks.clearTimeout(k);
            tick(0);
            expect(callback).toNotHaveBeenCalled();
        });

        it("should not affect sooner timeouts", function() {
            const callback1 = expect.createSpy();
            const callback2 = expect.createSpy();

            callbacks.setTimeout(callback1, 100);
            const k = callbacks.setTimeout(callback2, 200);
            callbacks.clearTimeout(k);

            tick(100);
            expect(callback1).toHaveBeenCalled();
            expect(callback2).toNotHaveBeenCalled();

            tick(150);
            expect(callback2).toNotHaveBeenCalled();
        });
    });
});
