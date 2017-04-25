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

// constants for DeviceList._deviceTrackingStatus
// const TRACKING_STATUS_NOT_TRACKED = 0;
const TRACKING_STATUS_PENDING_DOWNLOAD = 1;
const TRACKING_STATUS_DOWNLOAD_IN_PROGRESS = 2;
const TRACKING_STATUS_UP_TO_DATE = 3;

/**
 * @alias module:crypto/DeviceList
 */
export default class DeviceList {
    constructor(baseApis, sessionStore, olmDevice) {
        this._sessionStore = sessionStore;
        this._serialiser = new DeviceListUpdateSerialiser(
            baseApis, sessionStore, olmDevice,
        );

        // which users we are tracking device status for.
        // userId -> TRACKING_STATUS_*
        this._deviceTrackingStatus = sessionStore.getEndToEndDeviceTrackingStatus() || {};
        for (const u of Object.keys(this._deviceTrackingStatus)) {
            // if a download was in progress when we got shut down, it isn't any more.
            if (this._deviceTrackingStatus[u] == TRACKING_STATUS_DOWNLOAD_IN_PROGRESS) {
                this._deviceTrackingStatus[u] = TRACKING_STATUS_PENDING_DOWNLOAD;
            }
        }

        // userId -> promise
        this._keyDownloadsInProgressByUser = {};

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
        const usersToDownload = [];
        const promises = [];

        userIds.forEach((u) => {
            const trackingStatus = this._deviceTrackingStatus[u];
            if (this._keyDownloadsInProgressByUser[u]) {
                // already a key download in progress/queued for this user; its results
                // will be good enough for us.
                promises.push(this._keyDownloadsInProgressByUser[u]);
            } else if (forceDownload || trackingStatus != TRACKING_STATUS_UP_TO_DATE) {
                usersToDownload.push(u);
            }
        });

        if (usersToDownload.length != 0) {
            console.log("downloadKeys: downloading for", usersToDownload);
            const downloadPromise = this._doKeyDownload(usersToDownload);
            promises.push(downloadPromise);
        }

        return q.all(promises).then(() => {
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
     * flag the given user for device-list tracking, if they are not already.
     *
     * This will mean that a subsequent call to refreshOutdatedDeviceLists()
     * will download the device list for the user, and that subsequent calls to
     * invalidateUserDeviceList will trigger more updates.
     *
     * @param {String} userId
     */
    startTrackingDeviceList(userId) {
        // sanity-check the userId. This is mostly paranoia, but if synapse
        // can't parse the userId we give it as an mxid, it 500s the whole
        // request and we can never update the device lists again (because
        // the broken userId is always 'invalid' and always included in any
        // refresh request).
        // By checking it is at least a string, we can eliminate a class of
        // silly errors.
        if (typeof userId !== 'string') {
            throw new Error('userId must be a string; was '+userId);
        }
        if (!this._deviceTrackingStatus[userId]) {
            console.log('Now tracking device list for ' + userId);
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_PENDING_DOWNLOAD;
        }
        // we don't yet persist the tracking status, since there may be a lot
        // of calls; instead we wait for the forthcoming
        // refreshOutdatedDeviceLists.
    }

    /**
     * Mark the cached device list for the given user outdated.
     *
     * If we are not tracking this user's devices, we'll do nothing. Otherwise
     * we flag the user as needing an update.
     *
     * This doesn't actually set off an update, so that several users can be
     * batched together. Call refreshOutdatedDeviceLists() for that.
     *
     * @param {String} userId
     */
    invalidateUserDeviceList(userId) {
        if (this._deviceTrackingStatus[userId]) {
            console.log("Marking device list outdated for", userId);
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_PENDING_DOWNLOAD;
        }
        // we don't yet persist the tracking status, since there may be a lot
        // of calls; instead we wait for the forthcoming
        // refreshOutdatedDeviceLists.
    }

    /**
     * Mark all tracked device lists as outdated.
     *
     * This will flag each user whose devices we are tracking as in need of an
     * update.
     */
    invalidateAllDeviceLists() {
        for (const userId of Object.keys(this._deviceTrackingStatus)) {
            this.invalidateUserDeviceList(userId);
        }
    }

    /**
     * If we have users who have outdated device lists, start key downloads for them
     */
    refreshOutdatedDeviceLists() {
        const usersToDownload = [];
        for (const userId of Object.keys(this._deviceTrackingStatus)) {
            const stat = this._deviceTrackingStatus[userId];
            if (stat == TRACKING_STATUS_PENDING_DOWNLOAD) {
                usersToDownload.push(userId);
            }
        }
        if (usersToDownload.length == 0) {
            return;
        }

        // we didn't persist the tracking status during
        // invalidateUserDeviceList, so do it now.
        this._persistDeviceTrackingStatus();

        this._doKeyDownload(usersToDownload);
    }


    /**
     * Fire off download update requests for the given users, and update the
     * device list tracking status for them, and the
     * _keyDownloadsInProgressByUser map for them.
     *
     * @param {String[]} users  list of userIds
     *
     * @return {module:client.Promise} resolves when all the users listed have
     *     been updated. rejects if there was a problem updating any of the
     *     users.
     */
    _doKeyDownload(users) {
        if (users.length === 0) {
            // nothing to do
            return q();
        }

        const prom = this._serialiser.updateDevicesForUsers(
            users, this.lastKnownSyncToken,
        ).then(() => {
            finished(true);
        }, (e) => {
            console.error(
                'Error downloading keys for ' + users + ":", e,
            );
            finished(false);
            throw e;
        });

        users.forEach((u) => {
            this._keyDownloadsInProgressByUser[u] = prom;
            const stat = this._deviceTrackingStatus[u];
            if (stat == TRACKING_STATUS_PENDING_DOWNLOAD) {
                this._deviceTrackingStatus[u] = TRACKING_STATUS_DOWNLOAD_IN_PROGRESS;
            }
        });

        const finished = (success) => {
            users.forEach((u) => {
                delete this._keyDownloadsInProgressByUser[u];
                const stat = this._deviceTrackingStatus[u];
                if (stat == TRACKING_STATUS_DOWNLOAD_IN_PROGRESS) {
                    if (success) {
                        // we didn't get any new invalidations since this download started:
                        // this user's device list is now up to date.
                        this._deviceTrackingStatus[u] = TRACKING_STATUS_UP_TO_DATE;
                        console.log("Device list for", u, "now up to date");
                    } else {
                        this._deviceTrackingStatus[u] = TRACKING_STATUS_PENDING_DOWNLOAD;
                    }
                }
            });
            this._persistDeviceTrackingStatus();
        };

        return prom;
    }

    _persistDeviceTrackingStatus() {
        this._sessionStore.storeEndToEndDeviceTrackingStatus(this._deviceTrackingStatus);
    }
}

/**
 * Serialises updates to device lists
 *
 * Ensures that results from /keys/query are not overwritten if a second call
 * completes *before* an earlier one.
 *
 * It currently does this by ensuring only one call to /keys/query happens at a
 * time (and queuing other requests up).
 */
class DeviceListUpdateSerialiser {
    constructor(baseApis, sessionStore, olmDevice) {
        this._baseApis = baseApis;
        this._sessionStore = sessionStore;
        this._olmDevice = olmDevice;

        this._downloadInProgress = false;

        // users which are queued for download
        // userId -> true
        this._keyDownloadsQueuedByUser = {};

        // deferred which is resolved when the queued users are downloaded.
        //
        // non-null indicates that we have users queued for download.
        this._queuedQueryDeferred = null;

        // sync token to be used for the next query: essentially the
        // most recent one we know about
        this._nextSyncToken = null;
    }

    /**
     * Make a key query request for the given users
     *
     * @param {String[]} users list of user ids
     *
     * @param {String} syncToken sync token to pass in the query request, to
     *     help the HS give the most recent results
     *
     * @return {module:client.Promise} resolves when all the users listed have
     *     been updated. rejects if there was a problem updating any of the
     *     users.
     */
    updateDevicesForUsers(users, syncToken) {
        users.forEach((u) => {
            this._keyDownloadsQueuedByUser[u] = true;
        });
        this._nextSyncToken = syncToken;

        if (!this._queuedQueryDeferred) {
            this._queuedQueryDeferred = q.defer();
        }

        if (this._downloadInProgress) {
            // just queue up these users
            console.log('Queued key download for', users);
            return this._queuedQueryDeferred.promise;
        }

        // start a new download.
        return this._doQueuedQueries();
    }

    _doQueuedQueries() {
        if (this._downloadInProgress) {
            throw new Error(
                "DeviceListUpdateSerialiser._doQueuedQueries called with request active",
            );
        }

        const downloadUsers = Object.keys(this._keyDownloadsQueuedByUser);
        this._keyDownloadsQueuedByUser = {};
        const deferred = this._queuedQueryDeferred;
        this._queuedQueryDeferred = null;

        console.log('Starting key download for', downloadUsers);
        this._downloadInProgress = true;

        const opts = {};
        if (this._nextSyncToken) {
            opts.token = this._nextSyncToken;
        }

        this._baseApis.downloadKeysForUsers(
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
        }).done(() => {
            console.log('Completed key download for ' + downloadUsers);

            this._downloadInProgress = false;
            deferred.resolve();

            // if we have queued users, fire off another request.
            if (this._queuedQueryDeferred) {
                this._doQueuedQueries();
            }
        }, (e) => {
            console.warn('Error downloading keys for ' + downloadUsers + ':', e);
            this._downloadInProgressInProgress = false;
            deferred.reject(e);
        });

        return deferred.promise;
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
