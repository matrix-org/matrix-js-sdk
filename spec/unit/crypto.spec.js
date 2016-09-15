
"use strict";
var Crypto = require("../../lib/crypto");
var sdk = require("../..");
var testUtils = require("../test-utils");

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()).toEqual([1,3,0]);
    });
});
