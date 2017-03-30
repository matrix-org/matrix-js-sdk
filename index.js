var matrixcs = require("./lib/matrix");
matrixcs.request(require("request"));
module.exports = matrixcs;

var utils = require("./lib/utils");
utils.runPolyfills();
