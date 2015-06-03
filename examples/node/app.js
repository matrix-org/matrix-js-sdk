"use strict";
console.log("Loading node sdk");

var matrix = require("matrix-js-sdk");

var client = matrix.createClient("http://matrix.org");
client.publicRooms(function (err, data) {
    if (err) {
        console.error("Error: %s", JSON.stringify(err));
        return;
    }
	console.log("data %s", JSON.stringify(data).substring(0, 200));
    console.log("Congratulations! The SDK is working in Node.js!");
});
