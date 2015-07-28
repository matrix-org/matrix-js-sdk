"use strict";
var utils = require("../../lib/utils");
var testUtils = require("../test-utils");

describe("utils", function() {
    beforeEach(function() {
        testUtils.beforeEach(this);
    });

    describe("encodeParams", function() {
        it("should url encode and concat with &s", function() {
            var params = {
                foo: "bar",
                baz: "beer@"
            };
            expect(utils.encodeParams(params)).toEqual(
                "foo=bar&baz=beer%40"
            );
        });
    });

    describe("encodeUri", function() {
        it("should replace based on object keys and url encode", function() {
            var path = "foo/bar/%something/%here";
            var vals = {
                "%something": "baz",
                "%here": "beer@"
            };
            expect(utils.encodeUri(path, vals)).toEqual(
                "foo/bar/baz/beer%40"
            );
        });
    });

    describe("forEach", function() {
        it("should be invoked for each element", function() {
            var arr = [];
            utils.forEach([55, 66, 77], function(element) {
                arr.push(element);
            });
            expect(arr).toEqual([55, 66, 77]);
        });
    });

    describe("findElement", function() {
        it("should find only 1 element if there is a match", function() {
            var matchFn = function() { return true; };
            var arr = [55, 66, 77];
            expect(utils.findElement(arr, matchFn)).toEqual(55);
        });
        it("should be able to find in reverse order", function() {
            var matchFn = function() { return true; };
            var arr = [55, 66, 77];
            expect(utils.findElement(arr, matchFn, true)).toEqual(77);
        });
        it("should find nothing if the function never returns true", function() {
            var matchFn = function() { return false; };
            var arr = [55, 66, 77];
            expect(utils.findElement(arr, matchFn)).toBeFalsy();
        });
    });

    describe("removeElement", function() {
        it("should remove only 1 element if there is a match", function() {
            var matchFn = function() { return true; };
            var arr = [55, 66, 77];
            utils.removeElement(arr, matchFn);
            expect(arr).toEqual([66, 77]);
        });
        it("should be able to remove in reverse order", function() {
            var matchFn = function() { return true; };
            var arr = [55, 66, 77];
            utils.removeElement(arr, matchFn, true);
            expect(arr).toEqual([55, 66]);
        });
        it("should remove nothing if the function never returns true", function() {
            var matchFn = function() { return false; };
            var arr = [55, 66, 77];
            utils.removeElement(arr, matchFn);
            expect(arr).toEqual(arr);
        });
    });

    describe("isFunction", function() {
        it("should return true for functions", function() {
            expect(utils.isFunction([])).toBe(false);
            expect(utils.isFunction([5, 3, 7])).toBe(false);
            expect(utils.isFunction()).toBe(false);
            expect(utils.isFunction(null)).toBe(false);
            expect(utils.isFunction({})).toBe(false);
            expect(utils.isFunction("foo")).toBe(false);
            expect(utils.isFunction(555)).toBe(false);

            expect(utils.isFunction(function() {})).toBe(true);
            var s = { foo: function() {} };
            expect(utils.isFunction(s.foo)).toBe(true);
        });
    });

    describe("isArray", function() {
        it("should return true for arrays", function() {
            expect(utils.isArray([])).toBe(true);
            expect(utils.isArray([5, 3, 7])).toBe(true);

            expect(utils.isArray()).toBe(false);
            expect(utils.isArray(null)).toBe(false);
            expect(utils.isArray({})).toBe(false);
            expect(utils.isArray("foo")).toBe(false);
            expect(utils.isArray(555)).toBe(false);
            expect(utils.isArray(function() {})).toBe(false);
        });
    });

    describe("checkObjectHasKeys", function() {
        it("should throw for missing keys", function() {
            expect(function() { utils.checkObjectHasKeys({}, ["foo"]); }).toThrow();
            expect(function() { utils.checkObjectHasKeys({
                foo: "bar"
            }, ["foo"]); }).not.toThrow();
        });
    });

    describe("checkObjectHasNoAdditionalKeys", function() {
        it("should throw for extra keys", function() {
            expect(function() { utils.checkObjectHasNoAdditionalKeys({
                foo: "bar",
                baz: 4
            }, ["foo"]); }).toThrow();

            expect(function() { utils.checkObjectHasNoAdditionalKeys({
                foo: "bar"
            }, ["foo"]); }).not.toThrow();
        });
    });
});
