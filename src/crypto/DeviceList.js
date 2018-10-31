/*
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

/**
 * @module crypto/DeviceList
 *
 * Manages the list of other users' devices
 */

import Promise from 'bluebird';

import logger from '../logger';
import DeviceInfo from './deviceinfo';
import olmlib from './olmlib';
import IndexedDBCryptoStore from './store/indexeddb-crypto-store';


/* State transition diagram for DeviceList._deviceTrackingStatus
 *
 *                                |
 *     stopTrackingDeviceList     V
 *   +---------------------> NOT_TRACKED
 *   |                            |
 *   +<--------------------+      | startTrackingDeviceList
 *   |                     |      V
 *   |   +-------------> PENDING_DOWNLOAD <--------------------+-+
 *   |   |                      ^ |                            | |
 *   |   | restart     download | |  start download            | | invalidateUserDeviceList
 *   |   | client        failed | |                            | |
 *   |   |                      | V                            | |
 *   |   +------------ DOWNLOAD_IN_PROGRESS -------------------+ |
 *   |                    |       |                              |
 *   +<-------------------+       |  download successful         |
 *   ^                            V                              |
 *   +----------------------- UP_TO_DATE ------------------------+
 */


// constants for DeviceList._deviceTrackingStatus
const TRACKING_STATUS_NOT_TRACKED = 0;
const TRACKING_STATUS_PENDING_DOWNLOAD = 1;
const TRACKING_STATUS_DOWNLOAD_IN_PROGRESS = 2;
const TRACKING_STATUS_UP_TO_DATE = 3;

/**
 * @alias module:crypto/DeviceList
 */
export default class DeviceList {
    constructor(baseApis, cryptoStore, sessionStore, olmDevice) {
        this._cryptoStore = cryptoStore;
        this._sessionStore = sessionStore;

        // userId -> {
        //     deviceId -> {
        //         [device info]
        //     }
        // }
        this._devices = {};

        // map of identity keys to the user who owns it
        this._userByIdentityKey = {};

        // which users we are tracking device status for.
        // userId -> TRACKING_STATUS_*
        this._deviceTrackingStatus = {}; // loaded from storage in load()

        // The 'next_batch' sync token at the point the data was writen,
        // ie. a token representing the point immediately after the
        // moment represented by the snapshot in the db.
        this._syncToken = null;

        this._serialiser = new DeviceListUpdateSerialiser(
            baseApis, olmDevice, this,
        );

        // userId -> promise
        this._keyDownloadsInProgressByUser = {};

        // Set whenever changes are made other than setting the sync token
        this._dirty = false;

        // Promise resolved when device data is saved
        this._savePromise = null;
        // Function that resolves the save promise
        this._resolveSavePromise = null;
        // The time the save is scheduled for
        this._savePromiseTime = null;
        // The timer used to delay the save
        this._saveTimer = null;
    }

    /**
     * Load the device tracking state from storage
     */
    async load() {
        let shouldDeleteSessionStore = false;
        await this._cryptoStore.doTxn(
            // migrate from session store if there's data there and not here
            'readwrite', [IndexedDBCryptoStore.STORE_DEVICE_DATA], (txn) => {
                this._cryptoStore.getEndToEndDeviceData(txn, (deviceData) => {
                    if (deviceData === null) {
                        logger.log("Migrating e2e device data...");
                        this._devices = this._sessionStore.getAllEndToEndDevices() || {};
                        this._deviceTrackingStatus = (
                            this._sessionStore.getEndToEndDeviceTrackingStatus() || {}
                        );
                        this._syncToken = this._sessionStore.getEndToEndDeviceSyncToken();
                        this._cryptoStore.storeEndToEndDeviceData({
                            devices: this._devices,
                            trackingStatus: this._deviceTrackingStatus,
                            syncToken: this._syncToken,
                        }, txn);
                        shouldDeleteSessionStore = true;
                    } else {
                        this._devices = deviceData ? deviceData.devices : {},
                        this._deviceTrackingStatus = deviceData ?
                            deviceData.trackingStatus : {};
                        this._syncToken = deviceData ? deviceData.syncToken : null;
                    }
                    this._userByIdentityKey = {};
                    for (const user of Object.keys(this._devices)) {
                        const userDevices = this._devices[user];
                        for (const device of Object.keys(userDevices)) {
                            const idKey = userDevices[device].keys['curve25519:'+device];
                            if (idKey !== undefined) {
                                this._userByIdentityKey[idKey] = user;
                            }
                        }
                    }
                });
            },
        );

        if (shouldDeleteSessionStore) {
            // migrated data is now safely persisted: remove from old store
            this._sessionStore.removeEndToEndDeviceData();
        }

        for (const u of Object.keys(this._deviceTrackingStatus)) {
            // if a download was in progress when we got shut down, it isn't any more.
            if (this._deviceTrackingStatus[u] == TRACKING_STATUS_DOWNLOAD_IN_PROGRESS) {
                this._deviceTrackingStatus[u] = TRACKING_STATUS_PENDING_DOWNLOAD;
            }
        }
    }

    stop() {
        if (this._saveTimer !== null) {
            clearTimeout(this._saveTimer);
        }
    }

    /**
     * Save the device tracking state to storage, if any changes are
     * pending other than updating the sync token
     *
     * The actual save will be delayed by a short amount of time to
     * aggregate multiple writes to the database.
     *
     * @param {integer} delay Time in ms before which the save actually happens.
     *     By default, the save is delayed for a short period in order to batch
     *     multiple writes, but this behaviour can be disabled by passing 0.
     *
     * @return {Promise<bool>} true if the data was saved, false if
     *     it was not (eg. because no changes were pending). The promise
     *     will only resolve once the data is saved, so may take some time
     *     to resolve.
     */
    async saveIfDirty(delay) {
        if (!this._dirty) return Promise.resolve(false);
        // Delay saves for a bit so we can aggregate multiple saves that happen
        // in quick succession (eg. when a whole room's devices are marked as known)
        if (delay === undefined) delay = 500;

        const targetTime = Date.now + delay;
        if (this._savePromiseTime && targetTime < this._savePromiseTime) {
            // There's a save scheduled but for after we would like: cancel
            // it & schedule one for the time we want
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
            this._savePromiseTime = null;
            // (but keep the save promise since whatever called save before
            // will still want to know when the save is done)
        }

        let savePromise = this._savePromise;
        if (savePromise === null) {
            savePromise = new Promise((resolve, reject) => {
                this._resolveSavePromise = resolve;
            });
            this._savePromise = savePromise;
        }

        if (this._saveTimer === null) {
            const resolveSavePromise = this._resolveSavePromise;
            this._savePromiseTime = targetTime;
            this._saveTimer = setTimeout(() => {
                logger.log('Saving device tracking data at token ' + this._syncToken);
                // null out savePromise now (after the delay but before the write),
                // otherwise we could return the existing promise when the save has
                // actually already happened. Likewise for the dirty flag.
                this._savePromiseTime = null;
                this._saveTimer = null;
                this._savePromise = null;
                this._resolveSavePromise = null;

                this._dirty = false;
                this._cryptoStore.doTxn(
                    'readwrite', [IndexedDBCryptoStore.STORE_DEVICE_DATA], (txn) => {
                        this._cryptoStore.storeEndToEndDeviceData({
                            devices: this._devices,
                            trackingStatus: this._deviceTrackingStatus,
                            syncToken: this._syncToken,
                        }, txn);
                    },
                ).then(() => {
                    resolveSavePromise();
                });
            }, delay);
        }
        return savePromise;
    }

    /**
     * Gets the sync token last set with setSyncToken
     *
     * @return {string} The sync token
     */
    getSyncToken() {
        return this._syncToken;
    }

    /**
     * Sets the sync token that the app will pass as the 'since' to the /sync
     * endpoint next time it syncs.
     * The sync token must always be set after any changes made as a result of
     * data in that sync since setting the sync token to a newer one will mean
     * those changed will not be synced from the server if a new client starts
     * up with that data.
     *
     * @param {string} st The sync token
     */
    setSyncToken(st) {
        this._syncToken = st;
    }

    /**
     * Ensures up to date keys for a list of users are stored in the session store,
     * downloading and storing them if they're not (or if forceDownload is
     * true).
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
                logger.log(
                    `downloadKeys: already have a download in progress for ` +
                    `${u}: awaiting its result`,
                );
                promises.push(this._keyDownloadsInProgressByUser[u]);
            } else if (forceDownload || trackingStatus != TRACKING_STATUS_UP_TO_DATE) {
                usersToDownload.push(u);
            }
        });

        if (usersToDownload.length != 0) {
            logger.log("downloadKeys: downloading for", usersToDownload);
            const downloadPromise = this._doKeyDownload(usersToDownload);
            promises.push(downloadPromise);
        }

        if (promises.length === 0) {
            logger.log("downloadKeys: already have all necessary keys");
        }

        return Promise.all(promises).then(() => {
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
        const devs = this._devices[userId];
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
     * Get the stored device data for a user, in raw object form
     *
     * @param {string} userId the user to get data for
     *
     * @return {Object} deviceId->{object} devices, or undefined if
     * there is no data for this user.
     */
    getRawStoredDevicesForUser(userId) {
        return this._devices[userId];
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
        const devs = this._devices[userId];
        if (!devs || !devs[deviceId]) {
            return undefined;
        }
        return DeviceInfo.fromStorage(devs[deviceId], deviceId);
    }

    /**
     * Find a device by curve25519 identity key
     *
     * @param {string} algorithm  encryption algorithm
     * @param {string} senderKey  curve25519 key to match
     *
     * @return {module:crypto/deviceinfo?}
     */
    getDeviceByIdentityKey(algorithm, senderKey) {
        const userId = this._userByIdentityKey[senderKey];
        if (!userId) {
            return null;
        }

        if (
            algorithm !== olmlib.OLM_ALGORITHM &&
            algorithm !== olmlib.MEGOLM_ALGORITHM
        ) {
            // we only deal in olm keys
            return null;
        }

        const devices = this._devices[userId];
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
     * Replaces the list of devices for a user with the given device list
     *
     * @param {string} u The user ID
     * @param {Object} devs New device info for user
     */
    storeDevicesForUser(u, devs) {
        // remove previous devices from _userByIdentityKey
        if (this._devices[u] !== undefined) {
            for (const [deviceId, dev] of Object.entries(this._devices[u])) {
                const identityKey = dev.keys['curve25519:'+deviceId];

                delete this._userByIdentityKey[identityKey];
            }
        }

        this._devices[u] = devs;

        // add new ones
        for (const [deviceId, dev] of Object.entries(devs)) {
            const identityKey = dev.keys['curve25519:'+deviceId];

            this._userByIdentityKey[identityKey] = u;
        }
        this._dirty = true;
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
            logger.log('Now tracking device list for ' + userId);
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_PENDING_DOWNLOAD;
        }
        // we don't yet persist the tracking status, since there may be a lot
        // of calls; we save all data together once the sync is done
        this._dirty = true;
    }

    /**
     * Mark the given user as no longer being tracked for device-list updates.
     *
     * This won't affect any in-progress downloads, which will still go on to
     * complete; it will just mean that we don't think that we have an up-to-date
     * list for future calls to downloadKeys.
     *
     * @param {String} userId
     */
    stopTrackingDeviceList(userId) {
        if (this._deviceTrackingStatus[userId]) {
            logger.log('No longer tracking device list for ' + userId);
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_NOT_TRACKED;

            // we don't yet persist the tracking status, since there may be a lot
            // of calls; we save all data together once the sync is done
            this._dirty = true;
        }
    }

    /**
     * Set all users we're currently tracking to untracked
     *
     * This will flag each user whose devices we are tracking as in need of an
     * update.
     */
    stopTrackingAllDeviceLists() {
        for (const userId of Object.keys(this._deviceTrackingStatus)) {
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_NOT_TRACKED;
        }
        this._dirty = true;
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
            logger.log("Marking device list outdated for", userId);
            this._deviceTrackingStatus[userId] = TRACKING_STATUS_PENDING_DOWNLOAD;

            // we don't yet persist the tracking status, since there may be a lot
            // of calls; we save all data together once the sync is done
            this._dirty = true;
        }
    }

    /**
     * If we have users who have outdated device lists, start key downloads for them
     *
     * @returns {Promise} which completes when the download completes; normally there
     *    is no need to wait for this (it's mostly for the unit tests).
     */
    refreshOutdatedDeviceLists() {
        this.saveIfDirty();

        const usersToDownload = [];
        for (const userId of Object.keys(this._deviceTrackingStatus)) {
            const stat = this._deviceTrackingStatus[userId];
            if (stat == TRACKING_STATUS_PENDING_DOWNLOAD) {
                usersToDownload.push(userId);
            }
        }

        return this._doKeyDownload(usersToDownload);
    }

    /**
     * Set the stored device data for a user, in raw object form
     * Used only by internal class DeviceListUpdateSerialiser
     *
     * @param {string} userId the user to get data for
     *
     * @param {Object} devices deviceId->{object} the new devices
     */
    _setRawStoredDevicesForUser(userId, devices) {
        // remove old devices from _userByIdentityKey
        if (this._devices[userId] !== undefined) {
            for (const [deviceId, dev] of Object.entries(this._devices[userId])) {
                const identityKey = dev.keys['curve25519:'+deviceId];

                delete this._userByIdentityKey[identityKey];
            }
        }

        this._devices[userId] = devices;

        // add new devices into _userByIdentityKey
        for (const [deviceId, dev] of Object.entries(devices)) {
            const identityKey = dev.keys['curve25519:'+deviceId];

            this._userByIdentityKey[identityKey] = userId;
        }
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
            return Promise.resolve();
        }

        const prom = this._serialiser.updateDevicesForUsers(
            users, this._syncToken,
        ).then(() => {
            finished(true);
        }, (e) => {
            logger.error(
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
                this._dirty = true;

                // we may have queued up another download request for this user
                // since we started this request. If that happens, we should
                // ignore the completion of the first one.
                if (this._keyDownloadsInProgressByUser[u] !== prom) {
                    logger.log('Another update in the queue for', u,
                                '- not marking up-to-date');
                    return;
                }
                delete this._keyDownloadsInProgressByUser[u];
                const stat = this._deviceTrackingStatus[u];
                if (stat == TRACKING_STATUS_DOWNLOAD_IN_PROGRESS) {
                    if (success) {
                        // we didn't get any new invalidations since this download started:
                        // this user's device list is now up to date.
                        this._deviceTrackingStatus[u] = TRACKING_STATUS_UP_TO_DATE;
                        logger.log("Device list for", u, "now up to date");
                    } else {
                        this._deviceTrackingStatus[u] = TRACKING_STATUS_PENDING_DOWNLOAD;
                    }
                }
            });
            this.saveIfDirty();
        };

        return prom;
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
    /*
     * @param {object} baseApis Base API object
     * @param {object} olmDevice The Olm Device
     * @param {object} deviceList The device list object
     */
    constructor(baseApis, olmDevice, deviceList) {
        this._baseApis = baseApis;
        this._olmDevice = olmDevice;
        this._deviceList = deviceList; // the device list to be updated

        this._downloadInProgress = false;

        // users which are queued for download
        // userId -> true
        this._keyDownloadsQueuedByUser = {};

        // deferred which is resolved when the queued users are downloaded.
        //
        // non-null indicates that we have users queued for download.
        this._queuedQueryDeferred = null;

        this._syncToken = null; // The sync token we send with the requests
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

        if (!this._queuedQueryDeferred) {
            this._queuedQueryDeferred = Promise.defer();
        }

        // We always take the new sync token and just use the latest one we've
        // been given, since it just needs to be at least as recent as the
        // sync response the device invalidation message arrived in
        this._syncToken = syncToken;

        if (this._downloadInProgress) {
            // just queue up these users
            logger.log('Queued key download for', users);
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

        logger.log('Starting key download for', downloadUsers);
        this._downloadInProgress = true;

        const opts = {};
        if (this._syncToken) {
            opts.token = this._syncToken;
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
            let prom = Promise.resolve();
            for (const userId of downloadUsers) {
                prom = prom.delay(5).then(() => {
                    return this._processQueryResponseForUser(userId, dk[userId]);
                });
            }

            return prom;
        }).done(() => {
            logger.log('Completed key download for ' + downloadUsers);

            this._downloadInProgress = false;
            deferred.resolve();

            // if we have queued users, fire off another request.
            if (this._queuedQueryDeferred) {
                this._doQueuedQueries();
            }
        }, (e) => {
            logger.warn('Error downloading keys for ' + downloadUsers + ':', e);
            this._downloadInProgress = false;
            deferred.reject(e);
        });

        return deferred.promise;
    }

    async _processQueryResponseForUser(userId, response) {
        logger.log('got keys for ' + userId + ':', response);

        // map from deviceid -> deviceinfo for this user
        const userStore = {};
        const devs = this._deviceList.getRawStoredDevicesForUser(userId);
        if (devs) {
            Object.keys(devs).forEach((deviceId) => {
                const d = DeviceInfo.fromStorage(devs[deviceId], deviceId);
                userStore[deviceId] = d;
            });
        }

        await _updateStoredDeviceKeysForUser(
            this._olmDevice, userId, userStore, response || {},
        );

        // put the updates into thr object that will be returned as our results
        const storage = {};
        Object.keys(userStore).forEach((deviceId) => {
            storage[deviceId] = userStore[deviceId].toStorage();
        });

        this._deviceList._setRawStoredDevicesForUser(userId, storage);
    }
}


async function _updateStoredDeviceKeysForUser(_olmDevice, userId, userStore,
        userResult) {
    let updated = false;

    // remove any devices in the store which aren't in the response
    for (const deviceId in userStore) {
        if (!userStore.hasOwnProperty(deviceId)) {
            continue;
        }

        if (!(deviceId in userResult)) {
            logger.log("Device " + userId + ":" + deviceId +
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
            logger.warn("Mismatched user_id " + deviceResult.user_id +
               " in keys from " + userId + ":" + deviceId);
            continue;
        }
        if (deviceResult.device_id !== deviceId) {
            logger.warn("Mismatched device_id " + deviceResult.device_id +
               " in keys from " + userId + ":" + deviceId);
            continue;
        }

        if (await _storeDeviceKeys(_olmDevice, userStore, deviceResult)) {
            updated = true;
        }
    }

    return updated;
}

/*
 * Process a device in a /query response, and add it to the userStore
 *
 * returns (a promise for) true if a change was made, else false
 */
async function _storeDeviceKeys(_olmDevice, userStore, deviceResult) {
    if (!deviceResult.keys) {
        // no keys?
        return false;
    }

    const deviceId = deviceResult.device_id;
    const userId = deviceResult.user_id;

    const signKeyId = "ed25519:" + deviceId;
    const signKey = deviceResult.keys[signKeyId];
    if (!signKey) {
        logger.warn("Device " + userId + ":" + deviceId +
            " has no ed25519 key");
        return false;
    }

    const unsigned = deviceResult.unsigned || {};

    try {
        await olmlib.verifySignature(_olmDevice, deviceResult, userId, deviceId, signKey);
    } catch (e) {
        logger.warn("Unable to verify signature on device " +
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
            logger.warn("Ed25519 key for device " + userId + ":" +
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
