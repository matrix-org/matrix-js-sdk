/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

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

// load olm before the sdk if possible
import './olm-loader';

import sdk from '..';
import testUtils from './test-utils';
import MockHttpBackend from 'matrix-mock-request';
import expect from 'expect';
import Promise from 'bluebird';
import LocalStorageCryptoStore from '../lib/crypto/store/localStorage-crypto-store';

/**
 * Wrapper for a MockStorageApi, MockHttpBackend and MatrixClient
 *
 * @constructor
 * @param {string} userId
 * @param {string} deviceId
 * @param {string} accessToken
 *
 * @param {WebStorage=} sessionStoreBackend a web storage object to use for the
 *     session store. If undefined, we will create a MockStorageApi.
 */
export default function TestClient(
    userId, deviceId, accessToken, sessionStoreBackend,
) {
    this.userId = userId;
    this.deviceId = deviceId;

    if (sessionStoreBackend === undefined) {
        sessionStoreBackend = new testUtils.MockStorageApi();
    }
    const sessionStore = new sdk.WebStorageSessionStore(sessionStoreBackend);

    // expose this so the tests can get to it
    this.cryptoStore = new LocalStorageCryptoStore(sessionStoreBackend);

    this.httpBackend = new MockHttpBackend();
    this.client = sdk.createClient({
        baseUrl: "http://" + userId + ".test.server",
        userId: userId,
        accessToken: accessToken,
        deviceId: deviceId,
        sessionStore: sessionStore,
        cryptoStore: this.cryptoStore,
        request: this.httpBackend.requestFn,
    });

    this.deviceKeys = null;
    this.oneTimeKeys = {};
}

TestClient.prototype.toString = function() {
    return 'TestClient[' + this.userId + ']';
};

/**
 * start the client, and wait for it to initialise.
 *
 * @return {Promise}
 */
TestClient.prototype.start = function() {
    console.log(this + ': starting');
    this.httpBackend.when("GET", "/pushrules").respond(200, {});
    this.httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
    this.expectDeviceKeyUpload();

    // we let the client do a very basic initial sync, which it needs before
    // it will upload one-time keys.
    this.httpBackend.when("GET", "/sync").respond(200, { next_batch: 1 });

    this.client.startClient({
        // set this so that we can get hold of failed events
        pendingEventOrdering: 'detached',
    });

    return Promise.all([
        this.httpBackend.flushAllExpected(),
        testUtils.syncPromise(this.client),
    ]).then(() => {
        console.log(this + ': started');
    });
};

/**
 * stop the client
 * @return {Promise} Resolves once the mock http backend has finished all pending flushes
 */
TestClient.prototype.stop = function() {
    this.client.stopClient();
    return this.httpBackend.stop();
};

/**
 * Set up expectations that the client will upload device keys.
 */
TestClient.prototype.expectDeviceKeyUpload = function() {
    const self = this;
    this.httpBackend.when("POST", "/keys/upload").respond(200, function(path, content) {
        expect(content.one_time_keys).toBe(undefined);
        expect(content.device_keys).toBeTruthy();

        console.log(self + ': received device keys');
        // we expect this to happen before any one-time keys are uploaded.
        expect(Object.keys(self.oneTimeKeys).length).toEqual(0);

        self.deviceKeys = content.device_keys;
        return {one_time_key_counts: {signed_curve25519: 0}};
    });
};


/**
 * If one-time keys have already been uploaded, return them. Otherwise,
 * set up an expectation that the keys will be uploaded, and wait for
 * that to happen.
 *
 * @returns {Promise} for the one-time keys
 */
TestClient.prototype.awaitOneTimeKeyUpload = function() {
    if (Object.keys(this.oneTimeKeys).length != 0) {
        // already got one-time keys
        return Promise.resolve(this.oneTimeKeys);
    }

    this.httpBackend.when("POST", "/keys/upload")
        .respond(200, (path, content) => {
            expect(content.device_keys).toBe(undefined);
            expect(content.one_time_keys).toBe(undefined);
            return {one_time_key_counts: {
                signed_curve25519: Object.keys(this.oneTimeKeys).length,
            }};
        });

    this.httpBackend.when("POST", "/keys/upload")
          .respond(200, (path, content) => {
              expect(content.device_keys).toBe(undefined);
              expect(content.one_time_keys).toBeTruthy();
              expect(content.one_time_keys).toNotEqual({});
              console.log('%s: received %i one-time keys', this,
                          Object.keys(content.one_time_keys).length);
              this.oneTimeKeys = content.one_time_keys;
              return {one_time_key_counts: {
                  signed_curve25519: Object.keys(this.oneTimeKeys).length,
              }};
          });

    // this can take ages
    return this.httpBackend.flush('/keys/upload', 2, 1000).then((flushed) => {
        expect(flushed).toEqual(2);
        return this.oneTimeKeys;
    });
};

/**
 * Set up expectations that the client will query device keys.
 *
 * We check that the query contains each of the users in `response`.
 *
 * @param {Object} response   response to the query.
 */
TestClient.prototype.expectKeyQuery = function(response) {
    this.httpBackend.when('POST', '/keys/query').respond(
        200, (path, content) => {
            Object.keys(response.device_keys).forEach((userId) => {
                expect(content.device_keys[userId]).toEqual({});
            });
            return response;
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

/**
 * flush a single /sync request, and wait for the syncing event
 *
 * @returns {Promise} promise which completes once the sync has been flushed
 */
TestClient.prototype.flushSync = function() {
    console.log(`${this}: flushSync`);
    return Promise.all([
        this.httpBackend.flush('/sync', 1),
        testUtils.syncPromise(this.client),
    ]).then(() => {
        console.log(`${this}: flushSync completed`);
    });
};
