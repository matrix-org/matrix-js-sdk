
"use strict";
import 'source-map-support/register';
import Crypto from '../../lib/crypto';
import expect from 'expect';

const sdk = require("../..");

const Olm = global.Olm;

describe("Crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    beforeEach(function(done) {
        Olm.init().then(done);
    });

    it("Crypto exposes the correct olm library version", function() {
        expect(Crypto.getOlmVersion()[0]).toEqual(3);
    });
});
