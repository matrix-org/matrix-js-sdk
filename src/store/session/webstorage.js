/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd

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

const utils = require("../../utils");

const DEBUG = false;  // set true to enable console logging.
const E2E_PREFIX = "session.e2e.";

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
        !utils.isFunction(webStore.removeItem) ||
        !utils.isFunction(webStore.key) ||
        typeof(webStore.length) !== 'number'
       ) {
        throw new Error(
            "Supplied webStore does not meet the WebStorage API interface",
        );
    }
}

WebStorageSessionStore.prototype = {
    /**
     * Remove the stored end to end account for the logged-in user.
     */
    removeEndToEndAccount: function() {
        this.store.removeItem(KEY_END_TO_END_ACCOUNT);
    },

    /**
     * Load the end to end account for the logged-in user.
     * Note that the end-to-end account is now stored in the
     * crypto store rather than here: this remains here so
     * old sessions can be migrated out of the session store.
     * @return {?string} Base64 encoded account.
     */
    getEndToEndAccount: function() {
        return this.store.getItem(KEY_END_TO_END_ACCOUNT);
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
    getEndToEndDevicesForUser: function(userId) {
        return getJsonItem(this.store, keyEndToEndDevicesForUser(userId));
    },

    storeEndToEndDeviceTrackingStatus: function(statusMap) {
        setJsonItem(this.store, KEY_END_TO_END_DEVICE_LIST_TRACKING_STATUS, statusMap);
    },

    getEndToEndDeviceTrackingStatus: function() {
        return getJsonItem(this.store, KEY_END_TO_END_DEVICE_LIST_TRACKING_STATUS);
    },

    /**
     * Store the sync token corresponding to the device list.
     *
     * This is used when starting the client, to get a list of the users who
     * have changed their device list since the list time we were running.
     *
     * @param {String?} token
     */
    storeEndToEndDeviceSyncToken: function(token) {
        setJsonItem(this.store, KEY_END_TO_END_DEVICE_SYNC_TOKEN, token);
    },

    /**
     * Get the sync token corresponding to the device list.
     *
     * @return {String?} token
     */
    getEndToEndDeviceSyncToken: function() {
        return getJsonItem(this.store, KEY_END_TO_END_DEVICE_SYNC_TOKEN);
    },

    /**
     * Store a session between the logged-in user and another device
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID for this end-to-end session.
     * @param {string} session Base64 encoded end-to-end session.
     */
    storeEndToEndSession: function(deviceKey, sessionId, session) {
        const sessions = this.getEndToEndSessions(deviceKey) || {};
        sessions[sessionId] = session;
        setJsonItem(
            this.store, keyEndToEndSessions(deviceKey), sessions,
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

    /**
     * Retrieve all end-to-end sessions between the logged-in user and other
     * devices.
     * @return {object} A map of {deviceKey -> {sessionId -> session pickle}}
     */
    getAllEndToEndSessions: function() {
        const deviceKeys = getKeysWithPrefix(this.store, keyEndToEndSessions(''));
        const results = {};
        for (const k of deviceKeys) {
            const unprefixedKey = k.substr(keyEndToEndSessions('').length);
            results[unprefixedKey] = getJsonItem(this.store, k);
        }
        return results;
    },

    removeAllEndToEndSessions: function() {
        removeByPrefix(this.store, keyEndToEndSessions(''));
    },

    /**
     * Retrieve a list of all known inbound group sessions
     *
     * @return {{senderKey: string, sessionId: string}}
     */
    getAllEndToEndInboundGroupSessionKeys: function() {
        const prefix = E2E_PREFIX + 'inboundgroupsessions/';
        const result = [];
        for (let i = 0; i < this.store.length; i++) {
            const key = this.store.key(i);
            if (!key.startsWith(prefix)) {
                continue;
            }
            // we can't use split, as the components we are trying to split out
            // might themselves contain '/' characters. We rely on the
            // senderKey being a (32-byte) curve25519 key, base64-encoded
            // (hence 43 characters long).

            result.push({
                senderKey: key.substr(prefix.length, 43),
                sessionId: key.substr(prefix.length + 44),
            });
        }
        return result;
    },

    getEndToEndInboundGroupSession: function(senderKey, sessionId) {
        const key = keyEndToEndInboundGroupSession(senderKey, sessionId);
        return this.store.getItem(key);
    },

    storeEndToEndInboundGroupSession: function(senderKey, sessionId, pickledSession) {
        const key = keyEndToEndInboundGroupSession(senderKey, sessionId);
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
    },
};

const KEY_END_TO_END_ACCOUNT = E2E_PREFIX + "account";
const KEY_END_TO_END_DEVICE_SYNC_TOKEN = E2E_PREFIX + "device_sync_token";
const KEY_END_TO_END_DEVICE_LIST_TRACKING_STATUS = E2E_PREFIX + "device_tracking";

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
        // if the key is absent, store.getItem() returns null, and
        // JSON.parse(null) === null, so this returns null.
        return JSON.parse(store.getItem(key));
    } catch (e) {
        debuglog("Failed to get key %s: %s", key, e);
        debuglog(e.stack);
    }
    return null;
}

function setJsonItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}

function getKeysWithPrefix(store, prefix) {
    const results = [];
    for (let i = 0; i < store.length; ++i) {
        const key = store.key(i);
        if (key.startsWith(prefix)) results.push(key);
    }
    return results;
}

function removeByPrefix(store, prefix) {
    const toRemove = [];
    for (let i = 0; i < store.length; ++i) {
        const key = store.key(i);
        if (key.startsWith(prefix)) toRemove.push(key);
    }
    for (const key of toRemove) {
        store.removeItem(key);
    }
}

function debuglog() {
    if (DEBUG) {
        console.log(...arguments);
    }
}

/** */
module.exports = WebStorageSessionStore;
