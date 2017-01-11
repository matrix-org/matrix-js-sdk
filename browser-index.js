var matrixcs = require("./lib/matrix");
matrixcs.request(require("browser-request"));
module.exports = matrixcs; // keep export for browserify package deps
global.matrixcs = matrixcs;
