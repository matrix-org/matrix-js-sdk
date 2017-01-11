/*
Copyright 2015, 2016 OpenMarket Ltd

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

/**
 * @module store/session/webstorage
 */

var utils = require("../../utils");

var DEBUG = false;  // set true to enable console logging.
var E2E_PREFIX = "session.e2e.";

/**
 * Construct a web storage session store, capable of storing account keys,
 * session keys and access tokens.
 * @constructor
 * @param {WebStorage} webStore A web storage implementation, e.g.
 * 'window.localStorage' or 'window.sessionStorage' or a custom implementation.
 * @throws if the supplied 'store' does not meet the Storage interface of the
 * WebStorage API.
 */
function WebStorageSessionStore(webStore) {
    this.store = webStore;
    if (!utils.isFunction(webStore.getItem) ||
        !utils.isFunction(webStore.setItem) ||
        !utils.isFunction(webStore.removeItem)) {
        throw new Error(
            "Supplied webStore does not meet the WebStorage API interface"
        );
    }
}

WebStorageSessionStore.prototype = {

    /**
     * Store the end to end account for the logged-in user.
     * @param {string} account Base64 encoded account.
     */
    storeEndToEndAccount: function(account) {
        this.store.setItem(KEY_END_TO_END_ACCOUNT, account);
    },

    /**
     * Load the end to end account for the logged-in user.
     * @return {?string} Base64 encoded account.
     */
    getEndToEndAccount: function() {
        return this.store.getItem(KEY_END_TO_END_ACCOUNT);
    },

    /**
     * Store a flag indicating that we have announced the new device.
     */
    setDeviceAnnounced: function() {
        this.store.setItem(KEY_END_TO_END_ANNOUNCED, "true");
    },

    /**
     * Check if the "device announced" flag is set
     *
     * @return {boolean} true if the "device announced" flag has been set.
     */
    getDeviceAnnounced: function() {
        return this.store.getItem(KEY_END_TO_END_ANNOUNCED) == "true";
    },

    /**
     * Stores the known devices for a user.
     * @param {string} userId The user's ID.
     * @param {object} devices A map from device ID to keys for the device.
     */
    storeEndToEndDevicesForUser: function(userId, devices) {
        setJsonItem(this.store, keyEndToEndDevicesForUser(userId), devices);
    },

    /**
     * Retrieves the known devices for a user.
     * @param {string} userId The user's ID.
     * @return {object} A map from device ID to keys for the device.
     */
    getEndToEndDevicesForUser: function(userId)  {
        return getJsonItem(this.store, keyEndToEndDevicesForUser(userId));
    },

    /**
     * Store a session between the logged-in user and another device
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID for this end-to-end session.
     * @param {string} session Base64 encoded end-to-end session.
     */
    storeEndToEndSession: function(deviceKey, sessionId, session) {
        var sessions = this.getEndToEndSessions(deviceKey) || {};
        sessions[sessionId] = session;
        setJsonItem(
            this.store, keyEndToEndSessions(deviceKey), sessions
        );
    },

    /**
     * Retrieve the end-to-end sessions between the logged-in user and another
     * device.
     * @param {string} deviceKey The public key of the other device.
     * @return {object} A map from sessionId to Base64 end-to-end session.
     */
    getEndToEndSessions: function(deviceKey) {
        return getJsonItem(this.store, keyEndToEndSessions(deviceKey));
    },

    getEndToEndInboundGroupSession: function(senderKey, sessionId) {
        var key = keyEndToEndInboundGroupSession(senderKey, sessionId);
        return this.store.getItem(key);
    },

    storeEndToEndInboundGroupSession: function(senderKey, sessionId, pickledSession) {
        var key = keyEndToEndInboundGroupSession(senderKey, sessionId);
        return this.store.setItem(key, pickledSession);
    },

    /**
     * Store the end-to-end state for a room.
     * @param {string} roomId The room's ID.
     * @param {object} roomInfo The end-to-end info for the room.
     */
    storeEndToEndRoom: function(roomId, roomInfo) {
        setJsonItem(this.store, keyEndToEndRoom(roomId), roomInfo);
    },

    /**
     * Get the end-to-end state for a room
     * @param {string} roomId The room's ID.
     * @return {object} The end-to-end info for the room.
     */
    getEndToEndRoom: function(roomId) {
        return getJsonItem(this.store, keyEndToEndRoom(roomId));
    }
};

var KEY_END_TO_END_ACCOUNT = E2E_PREFIX + "account";
var KEY_END_TO_END_ANNOUNCED = E2E_PREFIX + "announced";

function keyEndToEndDevicesForUser(userId) {
    return E2E_PREFIX + "devices/" + userId;
}

function keyEndToEndSessions(deviceKey) {
    return E2E_PREFIX + "sessions/" + deviceKey;
}

function keyEndToEndInboundGroupSession(senderKey, sessionId) {
    return E2E_PREFIX + "inboundgroupsessions/" + senderKey + "/" + sessionId;
}

function keyEndToEndRoom(roomId) {
    return E2E_PREFIX + "rooms/" + roomId;
}

function getJsonItem(store, key) {
    try {
        return JSON.parse(store.getItem(key));
    }
    catch (e) {
        debuglog("Failed to get key %s: %s", key, e);
        debuglog(e.stack);
    }
    return null;
}

function setJsonItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}

function debuglog() {
    if (DEBUG) {
        console.log.apply(console, arguments);
    }
}

/** */
module.exports = WebStorageSessionStore;
