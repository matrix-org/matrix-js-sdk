
"use strict";
import 'source-map-support/register';

const sdk = require("../..");
let Crypto;
if (sdk.CRYPTO_ENABLED) {
    Crypto = require("../../lib/crypto");
}

import expect from 'expect';

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }
    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()[0]).toEqual(2);
    });
});
