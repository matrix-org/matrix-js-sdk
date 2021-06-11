import * as utils from "../../src/utils";
import {
    alphabetPad,
    averageBetweenStrings,
    baseToString,
    DEFAULT_ALPHABET,
    lexicographicCompare,
    nextString,
    prevString,
    stringToBase,
} from "../../src/utils";
import { logger } from "../../src/logger";

// TODO: Fix types throughout

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

            // TODO: Fix type
            const target: any = {};
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
                    resolve(null);
                });
            }

            function fn2() {
                return new Promise(function(resolve, reject) {
                    expect(promiseCount).toEqual(1);
                    ++promiseCount;
                    resolve(null);
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
            const len = 12;
            expect(alphabetPad("a", len)).toEqual("a" + ("".padEnd(len - 1, DEFAULT_ALPHABET[0])));
            expect(alphabetPad("a", len, "123")).toEqual("a" + ("".padEnd(len - 1, '1')));
        });
    });

    describe('baseToString', () => {
        it('should calculate the appropriate string from numbers', () => {
            expect(baseToString(BigInt(10))).toEqual(DEFAULT_ALPHABET[10]);
            expect(baseToString(BigInt(10), "abcdefghijklmnopqrstuvwxyz")).toEqual('k');
            expect(baseToString(BigInt(6241))).toEqual("ab");
            expect(baseToString(BigInt(53), "abcdefghijklmnopqrstuvwxyz")).toEqual('cb');
        });
    });

    describe('stringToBase', () => {
        it('should calculate the appropriate number for a string', () => {
            expect(stringToBase(" ")).toEqual(BigInt(0));
            expect(stringToBase("a", "abcdefghijklmnopqrstuvwxyz")).toEqual(BigInt(0));
            expect(stringToBase("a")).toEqual(BigInt(65));
            expect(stringToBase("c", "abcdefghijklmnopqrstuvwxyz")).toEqual(BigInt(2));
            expect(stringToBase("ab")).toEqual(BigInt(6241));
            expect(stringToBase("cb", "abcdefghijklmnopqrstuvwxyz")).toEqual(BigInt(53));
        });
    });

    describe('averageBetweenStrings', () => {
        it('should average appropriately', () => {
            expect(averageBetweenStrings('A', 'z')).toEqual(']');
            expect(averageBetweenStrings('a', 'z', "abcdefghijklmnopqrstuvwxyz")).toEqual('m');
            expect(averageBetweenStrings('AA', 'zz')).toEqual('^.');
            expect(averageBetweenStrings('aa', 'zz', "abcdefghijklmnopqrstuvwxyz")).toEqual('mz');
            expect(averageBetweenStrings('cat', 'doggo')).toEqual("d9>Cw");
            expect(averageBetweenStrings('cat', 'doggo', "abcdefghijklmnopqrstuvwxyz")).toEqual("cumqh");
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

    // Let's just ensure the ordering is sensible for lexicographic ordering
    describe('string averaging unified', () => {
        it('should be truly previous and next', () => {
            let midpoint = "cat";

            // We run this test 100 times to ensure we end up with a sane sequence.
            for (let i = 0; i < 100; i++) {
                const next = nextString(midpoint);
                const prev = prevString(midpoint);
                logger.log({ i, midpoint, next, prev }); // for test debugging

                expect(lexicographicCompare(midpoint, next) < 0).toBe(true);
                expect(lexicographicCompare(midpoint, prev) > 0).toBe(true);
                expect(averageBetweenStrings(prev, next)).toBe(midpoint);

                midpoint = next;
            }
        });

        it('should roll over', () => {
            const lastAlpha = DEFAULT_ALPHABET[DEFAULT_ALPHABET.length - 1];
            const firstAlpha = DEFAULT_ALPHABET[0];
            const secondAlpha = DEFAULT_ALPHABET[1];

            // You may be looking at this and wondering how on this planet we end up with
            // the next string being +2 on the ASCII table, and this comment is here to tell
            // you that you're not insane. Due to a property of the baseN conversion, our
            // +1 (and -1 for prevString) turns into +2 because the first character in the
            // alphabet is equivalent to zero rather than one. Thus, we're actually adding
            // the second character of the alphabet (due to adding a numeric 1) to the
            // input string, thus resulting in a human-understandable +2 jump rather than
            // a +1 one.

            // Let's validate that +1 behaviour with math
            expect(stringToBase(DEFAULT_ALPHABET[0])).toEqual(BigInt(0));
            expect(stringToBase(DEFAULT_ALPHABET[1])).toEqual(BigInt(1));

            const highRoll = secondAlpha + firstAlpha;
            const lowRoll = lastAlpha;

            expect(nextString(lowRoll)).toEqual(highRoll);
            expect(prevString(highRoll)).toEqual(lowRoll);
        });

        it('should be reversible on small strings', () => {
            // Large scale reversibility is tested for max space order value
            const input = "cats";
            expect(prevString(nextString(input))).toEqual(input);
        });

        // We want to explicitly make sure that Space order values are supported and roll appropriately
        it('should properly handle rolling over at 50 characters', () => {
            // Note: we also test reversibility of large strings here.

            // See rollover test for why we use weird parts of the alphabet
            const maxSpaceValue = DEFAULT_ALPHABET[DEFAULT_ALPHABET.length - 1].repeat(50);
            const fiftyFirstChar = DEFAULT_ALPHABET[1] + DEFAULT_ALPHABET[0].repeat(50);

            expect(nextString(maxSpaceValue)).toBe(fiftyFirstChar);
            expect(prevString(fiftyFirstChar)).toBe(maxSpaceValue);

            // We're testing that the rollover happened, which means that the next string come before
            // the maximum space order value lexicographically.
            expect(lexicographicCompare(maxSpaceValue, fiftyFirstChar) > 0).toBe(true);
        });
    });

    describe('lexicographicCompare', () => {
        it('should work', () => {
            // Simple tests
            expect(lexicographicCompare('a', 'b') < 0).toBe(true);
            expect(lexicographicCompare('ab', 'b') < 0).toBe(true);
            expect(lexicographicCompare('cat', 'dog') < 0).toBe(true);

            // Simple tests (reversed)
            expect(lexicographicCompare('b', 'a') > 0).toBe(true);
            expect(lexicographicCompare('b', 'ab') > 0).toBe(true);
            expect(lexicographicCompare('dog', 'cat') > 0).toBe(true);

            // Simple equality tests
            expect(lexicographicCompare('a', 'a') === 0).toBe(true);
            expect(lexicographicCompare('A', 'A') === 0).toBe(true);

            // ASCII rule testing
            expect(lexicographicCompare('A', 'a') < 0).toBe(true);
            expect(lexicographicCompare('a', 'A') > 0).toBe(true);
        });
    });
});
