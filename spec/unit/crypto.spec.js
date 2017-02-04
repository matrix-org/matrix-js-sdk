
"use strict";
const Crypto = require("../../lib/crypto");
const sdk = require("../..");

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()[0]).toEqual(2);
    });
});
