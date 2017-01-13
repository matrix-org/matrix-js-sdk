
"use strict";
let Crypto = require("../../lib/crypto");
let sdk = require("../..");

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()[0]).toEqual(2);
    });
});
