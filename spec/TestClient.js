/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

"use strict";

import sdk from '..';
import testUtils from './test-utils';
import MockHttpBackend from './mock-request';
import expect from 'expect';

/**
 * Wrapper for a MockStorageApi, MockHttpBackend and MatrixClient
 *
 * @constructor
 * @param {string} userId
 * @param {string} deviceId
 * @param {string} accessToken
 */
export default function TestClient(userId, deviceId, accessToken) {
    this.userId = userId;
    this.deviceId = deviceId;

    this.storage = new sdk.WebStorageSessionStore(new testUtils.MockStorageApi());
    this.httpBackend = new MockHttpBackend();
    this.client = sdk.createClient({
        baseUrl: "http://" + userId + ".test.server",
        userId: userId,
        accessToken: accessToken,
        deviceId: deviceId,
        sessionStore: this.storage,
        request: this.httpBackend.requestFn,
    });

    this.deviceKeys = null;
    this.oneTimeKeys = {};
}

/**
 * start the client, and wait for it to initialise.
 *
 * @param {object?} existingDevices  the list of our existing devices to return from
 *    the /query request. Defaults to empty device list
 * @return {Promise}
 */
TestClient.prototype.start = function(existingDevices) {
    this.httpBackend.when("GET", "/pushrules").respond(200, {});
    this.httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
    this.expectKeyUpload(existingDevices);

    this.client.startClient({
        // set this so that we can get hold of failed events
        pendingEventOrdering: 'detached',
    });

    return this.httpBackend.flush();
};

/**
 * stop the client
 */
TestClient.prototype.stop = function() {
    this.client.stopClient();
};

/**
 * Set up expectations that the client will upload device and one-time keys.
 *
 * @param {object?} existingDevices  the list of our existing devices to return from
 *    the /query request. Defaults to empty device list
 */
TestClient.prototype.expectKeyUpload = function(existingDevices) {
    const self = this;
    this.httpBackend.when('POST', '/keys/query').respond(200, function(path, content) {
        expect(Object.keys(content.device_keys)).toEqual([self.userId]);
        expect(content.device_keys[self.userId]).toEqual({});
        let res = existingDevices;
        if (!res) {
            res = { device_keys: {} };
            res.device_keys[self.userId] = {};
        }
        return res;
    });
    this.httpBackend.when("POST", "/keys/upload").respond(200, function(path, content) {
        expect(content.one_time_keys).toBe(undefined);
        expect(content.device_keys).toBeTruthy();
        self.deviceKeys = content.device_keys;
        return {one_time_key_counts: {signed_curve25519: 0}};
    });
    this.httpBackend.when("POST", "/keys/upload").respond(200, function(path, content) {
        expect(content.device_keys).toBe(undefined);
        expect(content.one_time_keys).toBeTruthy();
        expect(content.one_time_keys).toNotEqual({});
        self.oneTimeKeys = content.one_time_keys;
        return {one_time_key_counts: {
            signed_curve25519: Object.keys(self.oneTimeKeys).length,
        }};
    });
};

/**
 * get the uploaded curve25519 device key
 *
 * @return {string} base64 device key
 */
TestClient.prototype.getDeviceKey = function() {
    const keyId = 'curve25519:' + this.deviceId;
    return this.deviceKeys.keys[keyId];
};


/**
 * get the uploaded ed25519 device key
 *
 * @return {string} base64 device key
 */
TestClient.prototype.getSigningKey = function() {
    const keyId = 'ed25519:' + this.deviceId;
    return this.deviceKeys.keys[keyId];
};
