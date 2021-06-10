import * as utils from "../../src/utils";
import {
    alphabetPad,
    averageBetweenStrings,
    baseToString,
    DEFAULT_ALPHABET,
    nextString,
    prevString,
    stringToBase,
} from "../../src/utils";

describe("utils", function() {
    describe("encodeParams", function() {
        it("should url encode and concat with &s", function() {
            const params = {
                foo: "bar",
                baz: "beer@",
            };
            expect(utils.encodeParams(params)).toEqual(
                "foo=bar&baz=beer%40",
            );
        });
    });

    describe("encodeUri", function() {
        it("should replace based on object keys and url encode", function() {
            const path = "foo/bar/%something/%here";
            const vals = {
                "%something": "baz",
                "%here": "beer@",
            };
            expect(utils.encodeUri(path, vals)).toEqual(
                "foo/bar/baz/beer%40",
            );
        });
    });

    describe("removeElement", function() {
        it("should remove only 1 element if there is a match", function() {
            const matchFn = function() {
                return true;
            };
            const arr = [55, 66, 77];
            utils.removeElement(arr, matchFn);
            expect(arr).toEqual([66, 77]);
        });
        it("should be able to remove in reverse order", function() {
            const matchFn = function() {
                return true;
            };
            const arr = [55, 66, 77];
            utils.removeElement(arr, matchFn, true);
            expect(arr).toEqual([55, 66]);
        });
        it("should remove nothing if the function never returns true", function() {
            const matchFn = function() {
                return false;
            };
            const arr = [55, 66, 77];
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
            const s = { foo: function() {} };
            expect(utils.isFunction(s.foo)).toBe(true);
        });
    });

    describe("checkObjectHasKeys", function() {
        it("should throw for missing keys", function() {
            expect(function() {
                utils.checkObjectHasKeys({}, ["foo"]);
            }).toThrow();
            expect(function() {
                utils.checkObjectHasKeys({
                    foo: "bar",
                }, ["foo"]);
            }).not.toThrow();
        });
    });

    describe("checkObjectHasNoAdditionalKeys", function() {
        it("should throw for extra keys", function() {
            expect(function() {
                utils.checkObjectHasNoAdditionalKeys({
                            foo: "bar",
                            baz: 4,
                        }, ["foo"]);
            }).toThrow();

            expect(function() {
                utils.checkObjectHasNoAdditionalKeys({
                            foo: "bar",
                        }, ["foo"]);
            }).not.toThrow();
        });
    });

    describe("deepCompare", function() {
        const assert = {
            isTrue: function(x) {
                expect(x).toBe(true);
            },
            isFalse: function(x) {
                expect(x).toBe(false);
            },
        };

        it("should handle primitives", function() {
            assert.isTrue(utils.deepCompare(null, null));
            assert.isFalse(utils.deepCompare(null, undefined));
            assert.isTrue(utils.deepCompare("hi", "hi"));
            assert.isTrue(utils.deepCompare(5, 5));
            assert.isFalse(utils.deepCompare(5, 10));
        });

        it("should handle regexps", function() {
            assert.isTrue(utils.deepCompare(/abc/, /abc/));
            assert.isFalse(utils.deepCompare(/abc/, /123/));
            const r = /abc/;
            assert.isTrue(utils.deepCompare(r, r));
        });

        it("should handle dates", function() {
            assert.isTrue(utils.deepCompare(new Date("2011-03-31"),
                                            new Date("2011-03-31")));
            assert.isFalse(utils.deepCompare(new Date("2011-03-31"),
                                             new Date("1970-01-01")));
        });

        it("should handle arrays", function() {
            assert.isTrue(utils.deepCompare([], []));
            assert.isTrue(utils.deepCompare([1, 2], [1, 2]));
            assert.isFalse(utils.deepCompare([1, 2], [2, 1]));
            assert.isFalse(utils.deepCompare([1, 2], [1, 2, 3]));
        });

        it("should handle simple objects", function() {
            assert.isTrue(utils.deepCompare({}, {}));
            assert.isTrue(utils.deepCompare({ a: 1, b: 2 }, { a: 1, b: 2 }));
            assert.isTrue(utils.deepCompare({ a: 1, b: 2 }, { b: 2, a: 1 }));
            assert.isFalse(utils.deepCompare({ a: 1, b: 2 }, { a: 1, b: 3 }));

            assert.isTrue(utils.deepCompare({ 1: { name: "mhc", age: 28 },
                                             2: { name: "arb", age: 26 } },
                                            { 1: { name: "mhc", age: 28 },
                                             2: { name: "arb", age: 26 } }));

            assert.isFalse(utils.deepCompare({ 1: { name: "mhc", age: 28 },
                                              2: { name: "arb", age: 26 } },
                                             { 1: { name: "mhc", age: 28 },
                                              2: { name: "arb", age: 27 } }));

            assert.isFalse(utils.deepCompare({}, null));
            assert.isFalse(utils.deepCompare({}, undefined));
        });

        it("should handle functions", function() {
            // no two different function is equal really, they capture their
            // context variables so even if they have same toString(), they
            // won't have same functionality
            const func = function(x) {
                return true;
            };
            const func2 = function(x) {
                return true;
            };
            assert.isTrue(utils.deepCompare(func, func));
            assert.isFalse(utils.deepCompare(func, func2));
            assert.isTrue(utils.deepCompare({ a: { b: func } }, { a: { b: func } }));
            assert.isFalse(utils.deepCompare({ a: { b: func } }, { a: { b: func2 } }));
        });
    });

    describe("extend", function() {
        const SOURCE = { "prop2": 1, "string2": "x", "newprop": "new" };

        it("should extend", function() {
            const target = {
                "prop1": 5, "prop2": 7, "string1": "baz", "string2": "foo",
            };
            const merged = {
                "prop1": 5, "prop2": 1, "string1": "baz", "string2": "x",
                "newprop": "new",
            };
            const sourceOrig = JSON.stringify(SOURCE);

            utils.extend(target, SOURCE);
            expect(JSON.stringify(target)).toEqual(JSON.stringify(merged));

            // check the originial wasn't modified
            expect(JSON.stringify(SOURCE)).toEqual(sourceOrig);
        });

        it("should ignore null", function() {
            const target = {
                "prop1": 5, "prop2": 7, "string1": "baz", "string2": "foo",
            };
            const merged = {
                "prop1": 5, "prop2": 1, "string1": "baz", "string2": "x",
                "newprop": "new",
            };
            const sourceOrig = JSON.stringify(SOURCE);

            utils.extend(target, null, SOURCE);
            expect(JSON.stringify(target)).toEqual(JSON.stringify(merged));

            // check the originial wasn't modified
            expect(JSON.stringify(SOURCE)).toEqual(sourceOrig);
        });

        it("should handle properties created with defineProperties", function() {
            const source = Object.defineProperties({}, {
                "enumerableProp": {
                    get: function() {
                        return true;
                    },
                    enumerable: true,
                },
                "nonenumerableProp": {
                    get: function() {
                        return true;
                    },
                },
            });

            const target = {};
            utils.extend(target, source);
            expect(target.enumerableProp).toBe(true);
            expect(target.nonenumerableProp).toBe(undefined);
        });
    });

    describe("chunkPromises", function() {
        it("should execute promises in chunks", async function() {
            let promiseCount = 0;

            function fn1() {
                return new Promise(async function(resolve, reject) {
                    await utils.sleep(1);
                    expect(promiseCount).toEqual(0);
                    ++promiseCount;
                    resolve();
                });
            }

            function fn2() {
                return new Promise(function(resolve, reject) {
                    expect(promiseCount).toEqual(1);
                    ++promiseCount;
                    resolve();
                });
            }

            await utils.chunkPromises([fn1, fn2], 1);
            expect(promiseCount).toEqual(2);
        });
    });

    describe('DEFAULT_ALPHABET', () => {
        it('should be usefully printable ASCII in order', () => {
            expect(DEFAULT_ALPHABET).toEqual(
                " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
            );
        });
    });

    describe('alphabetPad', () => {
        it('should pad to the alphabet length', () => {
            const defaultPrefixFor1char = [""].reduce(() => {
                let s = "";
                for (let i = 0; i < DEFAULT_ALPHABET.length - 1; i++) {
                    s += DEFAULT_ALPHABET[0];
                }
                return s;
            }, "");
            expect(alphabetPad("a")).toEqual(defaultPrefixFor1char + "a");
            expect(alphabetPad("a", "123")).toEqual("11a");
        });
    });

    describe('baseToString', () => {
        it('should calculate the appropriate string from numbers', () => {
            expect(baseToString(10)).toEqual(DEFAULT_ALPHABET[10]);
            expect(baseToString(10, "abcdefghijklmnopqrstuvwxyz")).toEqual('k');
            expect(baseToString(6241)).toEqual("ab");
            expect(baseToString(53, "abcdefghijklmnopqrstuvwxyz")).toEqual('cb');
        });
    });

    describe('stringToBase', () => {
        it('should calculate the appropriate number for a string', () => {
            expect(stringToBase(" ")).toEqual(0);
            expect(stringToBase("a", "abcdefghijklmnopqrstuvwxyz")).toEqual(0);
            expect(stringToBase("a")).toEqual(65);
            expect(stringToBase("c", "abcdefghijklmnopqrstuvwxyz")).toEqual(2);
            expect(stringToBase("ab")).toEqual(6241);
            expect(stringToBase("cb", "abcdefghijklmnopqrstuvwxyz")).toEqual(53);
        });
    });

    describe('averageBetweenStrings', () => {
        it('should average appropriately', () => {
            expect(averageBetweenStrings('A', 'z')).toEqual(']');
            expect(averageBetweenStrings('a', 'z', "abcdefghijklmnopqrstuvwxyz")).toEqual('m');
            expect(averageBetweenStrings('AA', 'zz')).toEqual('^.');
            expect(averageBetweenStrings('aa', 'zz', "abcdefghijklmnopqrstuvwxyz")).toEqual('mz');
            expect(averageBetweenStrings('cat', 'doggo')).toEqual("BH65B");
            expect(averageBetweenStrings('cat', 'doggo', "abcdefghijklmnopqrstuvwxyz")).toEqual("buedq");
        });
    });

    describe('nextString', () => {
        it('should find the next string appropriately', () => {
            expect(nextString('A')).toEqual('B');
            expect(nextString('b', 'abcdefghijklmnopqrstuvwxyz')).toEqual('c');
            expect(nextString('cat')).toEqual('cau');
            expect(nextString('cat', 'abcdefghijklmnopqrstuvwxyz')).toEqual('cau');
        });
    });

    describe('prevString', () => {
        it('should find the next string appropriately', () => {
            expect(prevString('B')).toEqual('A');
            expect(prevString('c', 'abcdefghijklmnopqrstuvwxyz')).toEqual('b');
            expect(prevString('cau')).toEqual('cat');
            expect(prevString('cau', 'abcdefghijklmnopqrstuvwxyz')).toEqual('cat');
        });
    });
});
