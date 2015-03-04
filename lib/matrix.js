"use strict";

// wrap in a closure for browsers
var init = function(exports){
	// expose the underlying request object so different environments can use
	// different request libs (e.g. request or browser-request)
	var request;
	exports.request = function(r) {
		request = r;
	};

	// entry point
	function MatrixClient(credentials) {
		if (typeof credentials === "string") {
			credentials = {
				"baseUrl": credentials
			};
		}
		var requiredKeys = [
			"baseUrl"
		];
		for (var i=0; i<requiredKeys.length; i++) {
			if (!credentials.hasOwnProperty(requiredKeys[i])) {
				throw new Error("Missing required key: " + requiredKeys[i]);
			}
		}
	    this.credentials = credentials;
	};
	exports.MatrixClient = MatrixClient;
	exports.createClient = function(credentials) {
		return new MatrixClient(credentials);
	};

	var PREFIX = "/_matrix/client/api/v1";

	MatrixClient.prototype = {
		isLoggedIn: function() {
			return this.credentials.accessToken != undefined;
		},

		publicRooms: function(callback) {
			return this._doRequest(callback, "GET", "/publicRooms");
		},

		initialSync: function(limit, callback) {
			var params = {
				limit: limit
			};
			return this._doAuthedRequest(
				callback, "GET", "/initialSync", params
			);
		},

		_doAuthedRequest: function(callback, method, path, params, data) {
			if (!params) { params = {}; }
			params.access_token = this.credentials.accessToken;
			return this._doRequest(callback, method, path, params, data);
		},

		_doRequest: function(callback, method, path, params, data) {
			var fullUri = this.credentials.baseUrl + PREFIX + path;
			if (!params) { params = {}; }

			request(
			{
	   			uri: fullUri,
	   			method: method,
	   			withCredentials: false,
	   			qs: params,
	   			body: data,
	   			json: true,
	   			headers: {
	   				"User-Agent": "matrix-js"
	   			}
	   		},
	   		requestCallback(callback)
	   		);
		}
	};

	var encodeUri = function(pathTemplate, variables) {
		for (var key in variables) {
			if (!variables.hasOwnProperty(key)) { continue; }
			pathTemplate = pathTemplate.replace(key, variables[key]);
		}
		return encodeURIComponent(variables);
	};

	var requestCallback = function(userDefinedCallback) {
		if (!userDefinedCallback) {
			return undefined;
		}
		return function(err, response, body) {
			if (err) {
				return userDefinedCallback(err);
			}
			if (response.statusCode >= 400) {
				return userDefinedCallback(body);
			}
			else {
				userDefinedCallback(null, body);
			}
		};
	};
	

   exports.test = function(){
   		request({
   			uri: "http://localhost:8008/_matrix/client/api/v1/publicRooms",
   			method: "GET",
   			withCredentials: false,
   			}, 
   			function(err, response, body) {
   			console.log(body);
   		});
    };

};

if (typeof exports === 'undefined') {
	init(this['matrixcs']={});
}
else {
	init(exports);
}