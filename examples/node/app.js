"use strict";
console.log("Loading node sdk");

var matrix = require("./lib/matrix");
matrix.request(require("request"));

var client = matrix.createClient("http://matrix.org");
client.publicRooms(function (err, data) {
	console.log("data %s", JSON.stringify(data));
	console.error("err %s", JSON.stringify(err));
});
