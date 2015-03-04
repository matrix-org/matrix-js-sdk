"use strict";
console.log("Loading browser sdk");

matrixcs.request(request);

var client = matrixcs.createClient("http://matrix.org");
client.publicRooms(function (err, data) {
	console.log("data %s", JSON.stringify(data));
	console.error("err %s", JSON.stringify(err));
});
