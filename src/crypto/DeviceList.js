/*
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

/**
 * @module crypto/DeviceList
 *
 * Manages the list of other users' devices
 */

import q from 'q';

import DeviceInfo from './deviceinfo';
import olmlib from './olmlib';

/**
 * @alias module:crypto/DeviceList
 */
export default class DeviceList {
    constructor(baseApis, sessionStore, olmDevice) {
        this._baseApis = baseApis;
        this._sessionStore = sessionStore;
        this._olmDevice = olmDevice;

        // users with outdated device lists
        // userId -> true
        this._pendingUsersWithNewDevices = {};

        // userId -> true
        this._keyDownloadsInProgressByUser = {};

        // deferred which is resolved when the current device query resolves.
        // (null if there is no current request).
        this._currentQueryDeferred = null;

        // deferred which is resolved when the *next* device query resolves.
        //
        // Normally it is meaningless for this to be non-null when
        // _currentQueryDeferred is null, but it can happen if the previous
        // query has finished but the next one has not yet started (because the
        // previous query failed, in which case we deliberately delay starting
        // the next query to avoid tight-looping).
        this._queuedQueryDeferred = null;

        this.lastKnownSyncToken = null;
    }

    /**
     * Download the keys for a list of users and stores the keys in the session
     * store.
     * @param {Array} userIds The users to fetch.
     * @param {bool} forceDownload Always download the keys even if cached.
     *
     * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
     * module:crypto/deviceinfo|DeviceInfo}.
     */
    downloadKeys(userIds, forceDownload) {
        let needsRefresh = false;
        let waitForCurrentQuery = false;

        userIds.forEach((u) => {
            if (this._pendingUsersWithNewDevices[u]) {
                // we already know this user's devices are outdated
                needsRefresh = true;
            } else if (this._keyDownloadsInProgressByUser[u]) {
                // already a download in progress - just wait for it.
                // (even if forceDownload is true)
                waitForCurrentQuery = true;
            } else if (forceDownload) {
                console.log("Invalidating device list for " + u +
                            " for forceDownload");
                this.invalidateUserDeviceList(u);
                needsRefresh = true;
            } else if (!this.getStoredDevicesForUser(u)) {
                console.log("Invalidating device list for " + u +
                            " due to empty cache");
                this.invalidateUserDeviceList(u);
                needsRefresh = true;
            }
        });

        let promise;
        if (needsRefresh) {
            console.log("downloadKeys: waiting for next key query");
            promise = this._startOrQueueDeviceQuery();
        } else if(waitForCurrentQuery) {
            console.log("downloadKeys: waiting for in-flight query to complete");
            promise = this._currentQueryDeferred.promise;
        } else {
            // we're all up-to-date.
            promise = q();
        }

        return promise.then(() => {
            return this._getDevicesFromStore(userIds);
        });
    }

    /**
     * Get the stored device keys for a list of user ids
     *
     * @param {string[]} userIds the list of users to list keys for.
     *
     * @return {Object} userId->deviceId->{@link module:crypto/deviceinfo|DeviceInfo}.
     */
    _getDevicesFromStore(userIds) {
        const stored = {};
        const self = this;
        userIds.map(function(u) {
            stored[u] = {};
            const devices = self.getStoredDevicesForUser(u) || [];
            devices.map(function(dev) {
                stored[u][dev.deviceId] = dev;
            });
        });
        return stored;
    }

    /**
     * Get the stored device keys for a user id
     *
     * @param {string} userId the user to list keys for.
     *
     * @return {module:crypto/deviceinfo[]|null} list of devices, or null if we haven't
     * managed to get a list of devices for this user yet.
     */
    getStoredDevicesForUser(userId) {
        const devs = this._sessionStore.getEndToEndDevicesForUser(userId);
        if (!devs) {
            return null;
        }
        const res = [];
        for (const deviceId in devs) {
            if (devs.hasOwnProperty(deviceId)) {
                res.push(DeviceInfo.fromStorage(devs[deviceId], deviceId));
            }
        }
        return res;
    }

    /**
     * Get the stored keys for a single device
     *
     * @param {string} userId
     * @param {string} deviceId
     *
     * @return {module:crypto/deviceinfo?} device, or undefined
     * if we don't know about this device
     */
    getStoredDevice(userId, deviceId) {
        const devs = this._sessionStore.getEndToEndDevicesForUser(userId);
        if (!devs || !devs[deviceId]) {
            return undefined;
        }
        return DeviceInfo.fromStorage(devs[deviceId], deviceId);
    }

    /**
     * Find a device by curve25519 identity key
     *
     * @param {string} userId     owner of the device
     * @param {string} algorithm  encryption algorithm
     * @param {string} senderKey  curve25519 key to match
     *
     * @return {module:crypto/deviceinfo?}
     */
    getDeviceByIdentityKey(userId, algorithm, senderKey) {
        if (
            algorithm !== olmlib.OLM_ALGORITHM &&
            algorithm !== olmlib.MEGOLM_ALGORITHM
        ) {
            // we only deal in olm keys
            return null;
        }

        const devices = this._sessionStore.getEndToEndDevicesForUser(userId);
        if (!devices) {
            return null;
        }

        for (const deviceId in devices) {
            if (!devices.hasOwnProperty(deviceId)) {
                continue;
            }

            const device = devices[deviceId];
            for (const keyId in device.keys) {
                if (!device.keys.hasOwnProperty(keyId)) {
                    continue;
                }
                if (keyId.indexOf("curve25519:") !== 0) {
                    continue;
                }
                const deviceKey = device.keys[keyId];
                if (deviceKey == senderKey) {
                    return DeviceInfo.fromStorage(device, deviceId);
                }
            }
        }

        // doesn't match a known device
        return null;
    }

    /**
     * Mark the cached device list for the given user outdated.
     *
     * This doesn't set off an update, so that several users can be batched
     * together. Call refreshOutdatedDeviceLists() for that.
     *
     * @param {String} userId
     */
    invalidateUserDeviceList(userId) {
        // sanity-check the userId. This is mostly paranoia, but if synapse
        // can't parse the userId we give it as an mxid, it 500s the whole
        // request and we can never update the device lists again (because
        // the broken userId is always 'invalid' and always included in any
        // refresh request).
        // By checking it is at least a string, we can eliminate a class of
        // silly errors.
        if (typeof userId !== 'string' && typeof userId !== 'object') {
            throw new Error('userId must be a string; was '+userId);
        }
        this._pendingUsersWithNewDevices[userId] = true;
    }

    /**
     * If there is not already a device list query in progress, and we have
     * users who have outdated device lists, start a query now.
     */
    refreshOutdatedDeviceLists() {
        if (this._currentQueryDeferred) {
            // request already in progress - do nothing. (We will automatically
            // make another request if there are more users with outdated
            // device lists when the current request completes).
            return;
        }

        this._startDeviceQuery();
    }

    /**
     * If there is currently a device list query in progress, returns a promise
     * which will resolve when the *next* query completes. Otherwise, starts
     * a new query, and returns a promise which resolves when it completes.
     *
     * @return {Promise}
     */
    _startOrQueueDeviceQuery() {
        if (!this._currentQueryDeferred) {
            this._startDeviceQuery();
            if (!this._currentQueryDeferred) {
                return q();
            }

            return this._currentQueryDeferred.promise;
        }

        if (!this._queuedQueryDeferred) {
            this._queuedQueryDeferred = q.defer();
        }

        return this._queuedQueryDeferred.promise;
    }

    /**
     * kick off a new device query
     *
     * Throws if there is already a query in progress.
     */
    _startDeviceQuery() {
        if (this._currentQueryDeferred) {
            throw new Error("DeviceList._startDeviceQuery called with request active");
        }

        this._currentQueryDeferred = this._queuedQueryDeferred || q.defer();
        this._queuedQueryDeferred = null;

        const users = Object.keys(this._pendingUsersWithNewDevices);
        if (users.length === 0) {
            // nothing to do
            this._currentQueryDeferred.resolve();
            this._currentQueryDeferred = null;

            // that means we're up-to-date with the lastKnownSyncToken.
            const token = this.lastKnownSyncToken;
            if (token !== null) {
                this._sessionStore.storeEndToEndDeviceSyncToken(token);
            }

            return;
        }

        this._doKeyDownloadForUsers(users).done(() => {
            users.forEach((u) => {
                delete this._keyDownloadsInProgressByUser[u];
            });

            this._currentQueryDeferred.resolve();
            this._currentQueryDeferred = null;

            // flush out any more requests that were blocked up while that
            // was going on.
            this._startDeviceQuery();
        }, (e) => {
            console.error(
                'Error updating device key cache for ' + users + ":", e,
            );

            // reinstate the pending flags on any users which failed; this will
            // mean that we will do another download in the future (actually on
            // the next /sync).
            users.forEach((u) => {
                delete this._keyDownloadsInProgressByUser[u];
                this._pendingUsersWithNewDevices[u] = true;
            });

            this._currentQueryDeferred.reject(e);
            this._currentQueryDeferred = null;
        });

        users.forEach((u) => {
            delete this._pendingUsersWithNewDevices[u];
            this._keyDownloadsInProgressByUser[u] = true;
        });
    }

    /**
     * @param {string[]} downloadUsers list of userIds
     *
     * @return {Promise}
     */
    _doKeyDownloadForUsers(downloadUsers) {
        console.log('Starting key download for ' + downloadUsers);

        const token = this.lastKnownSyncToken;
        const opts = {};
        if (token) {
            opts.token = token;
        }
        return this._baseApis.downloadKeysForUsers(
            downloadUsers, opts,
        ).then((res) => {
            const dk = res.device_keys || {};

            // do each user in a separate promise, to avoid wedging the CPU
            // (https://github.com/vector-im/riot-web/issues/3158)
            //
            // of course we ought to do this in a web worker or similar, but
            // this serves as an easy solution for now.
            let prom = q();
            for (const userId of downloadUsers) {
                prom = prom.delay(5).then(() => {
                    this._processQueryResponseForUser(userId, dk[userId]);
                });
            }

            return prom;
        }).then(() => {
            if (token !== null) {
                this._sessionStore.storeEndToEndDeviceSyncToken(token);
            }
            console.log('Completed key download for ' + downloadUsers);
        });
    }

    _processQueryResponseForUser(userId, response) {
        console.log('got keys for ' + userId + ':', response);

        // map from deviceid -> deviceinfo for this user
        const userStore = {};
        const devs = this._sessionStore.getEndToEndDevicesForUser(userId);
        if (devs) {
            Object.keys(devs).forEach((deviceId) => {
                const d = DeviceInfo.fromStorage(devs[deviceId], deviceId);
                userStore[deviceId] = d;
            });
        }

        _updateStoredDeviceKeysForUser(
            this._olmDevice, userId, userStore, response || {},
        );

        // update the session store
        const storage = {};
        Object.keys(userStore).forEach((deviceId) => {
            storage[deviceId] = userStore[deviceId].toStorage();
        });

        this._sessionStore.storeEndToEndDevicesForUser(
            userId, storage,
        );
    }
}


function _updateStoredDeviceKeysForUser(_olmDevice, userId, userStore,
        userResult) {
    let updated = false;

    // remove any devices in the store which aren't in the response
    for (const deviceId in userStore) {
        if (!userStore.hasOwnProperty(deviceId)) {
            continue;
        }

        if (!(deviceId in userResult)) {
            console.log("Device " + userId + ":" + deviceId +
                " has been removed");
            delete userStore[deviceId];
            updated = true;
        }
    }

    for (const deviceId in userResult) {
        if (!userResult.hasOwnProperty(deviceId)) {
            continue;
        }

        const deviceResult = userResult[deviceId];

        // check that the user_id and device_id in the response object are
        // correct
        if (deviceResult.user_id !== userId) {
            console.warn("Mismatched user_id " + deviceResult.user_id +
               " in keys from " + userId + ":" + deviceId);
            continue;
        }
        if (deviceResult.device_id !== deviceId) {
            console.warn("Mismatched device_id " + deviceResult.device_id +
               " in keys from " + userId + ":" + deviceId);
            continue;
        }

        if (_storeDeviceKeys(_olmDevice, userStore, deviceResult)) {
            updated = true;
        }
    }

    return updated;
}

/*
 * Process a device in a /query response, and add it to the userStore
 *
 * returns true if a change was made, else false
 */
 function _storeDeviceKeys(_olmDevice, userStore, deviceResult) {
    if (!deviceResult.keys) {
        // no keys?
        return false;
    }

    const deviceId = deviceResult.device_id;
    const userId = deviceResult.user_id;

    const signKeyId = "ed25519:" + deviceId;
    const signKey = deviceResult.keys[signKeyId];
    if (!signKey) {
        console.warn("Device " + userId + ":" + deviceId +
            " has no ed25519 key");
        return false;
    }

    const unsigned = deviceResult.unsigned || {};

    try {
        olmlib.verifySignature(_olmDevice, deviceResult, userId, deviceId, signKey);
    } catch (e) {
        console.warn("Unable to verify signature on device " +
            userId + ":" + deviceId + ":" + e);
        return false;
    }

    // DeviceInfo
    let deviceStore;

    if (deviceId in userStore) {
        // already have this device.
        deviceStore = userStore[deviceId];

        if (deviceStore.getFingerprint() != signKey) {
            // this should only happen if the list has been MITMed; we are
            // best off sticking with the original keys.
            //
            // Should we warn the user about it somehow?
            console.warn("Ed25519 key for device " + userId + ":" +
               deviceId + " has changed");
            return false;
        }
    } else {
        userStore[deviceId] = deviceStore = new DeviceInfo(deviceId);
    }

    deviceStore.keys = deviceResult.keys || {};
    deviceStore.algorithms = deviceResult.algorithms || [];
    deviceStore.unsigned = unsigned;
    return true;
}
