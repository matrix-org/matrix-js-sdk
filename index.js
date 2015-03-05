var matrixcs = require("./lib/matrix");
matrixcs.request(require("request"));
matrixcs.usePromises = function() {
    matrixcs = require("./lib/matrix-promise");
};

module.exports = matrixcs;
