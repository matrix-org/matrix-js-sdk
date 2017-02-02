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
import utils from '../utils';

/**
 * @alias module:crypto/DeviceList
 */
export default class DeviceList {
    constructor(baseApis, sessionStore, olmDevice) {
        this._baseApis = baseApis;
        this._sessionStore = sessionStore;
        this._olmDevice = olmDevice;

        // userId -> true
        this._pendingUsersWithNewDevices = {};

        // userId -> [promise, ...]
        this._keyDownloadsInProgressByUser = {};
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
        const self = this;

        // promises we need to wait for while the download happens
        const promises = [];

        // list of userids we need to download keys for
        let downloadUsers = [];

        function perUserCatch(u) {
            return function(e) {
                console.warn('Error downloading keys for user ' + u + ':', e);
            };
        }

        if (forceDownload) {
            downloadUsers = userIds;
        } else {
            for (let i = 0; i < userIds.length; ++i) {
                const u = userIds[i];

                const inprogress = this._keyDownloadsInProgressByUser[u];
                if (inprogress) {
                    // wait for the download to complete
                    promises.push(q.any(inprogress).catch(perUserCatch(u)));
                } else if (!this.getStoredDevicesForUser(u)) {
                    downloadUsers.push(u);
                }
            }
        }

        if (downloadUsers.length > 0) {
            const r = this._doKeyDownloadForUsers(downloadUsers);
            downloadUsers.map(function(u) {
                promises.push(r[u].catch(perUserCatch(u)));
            });
        }

        return q.all(promises).then(function() {
            return self._getDevicesFromStore(userIds);
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
     * @param {string} sender_key curve25519 key to match
     *
     * @return {module:crypto/deviceinfo?}
     */
    getDeviceByIdentityKey(userId, algorithm, sender_key) {
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
                if (deviceKey == sender_key) {
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
     * together. Call flushDeviceListRequests() for that.
     *
     * @param {String} userId
     */
    invalidateUserDeviceList(userId) {
        this._pendingUsersWithNewDevices[userId] = true;
    }

    /**
     * Start device queries for any users who sent us an m.new_device recently
     */
    flushNewDeviceRequests() {
        const users = Object.keys(this._pendingUsersWithNewDevices);

        if (users.length === 0) {
            return;
        }

        const r = this._doKeyDownloadForUsers(users);

        // we've kicked off requests to these users: remove their
        // pending flag for now.
        this._pendingUsersWithNewDevices = {};

        users.map((u) => {
            r[u] = r[u].catch((e) => {
                console.error(
                    'Error updating device keys for user ' + u + ':', e,
                );

                // reinstate the pending flags on any users which failed; this will
                // mean that we will do another download in the future, but won't
                // tight-loop.
                //
                this._pendingUsersWithNewDevices[u] = true;
            });
        });

        q.all(Object.values(r)).done();
    }

    /**
     * @param {string[]} downloadUsers list of userIds
     *
     * @return {Object} a map from userId to a promise for a result for that user
     */
    _doKeyDownloadForUsers(downloadUsers) {
        const self = this;

        console.log('Starting key download for ' + downloadUsers);

        const deferMap = {};
        const promiseMap = {};

        downloadUsers.map(function(u) {
            const deferred = q.defer();
            const promise = deferred.promise.finally(function() {
                const inProgress = self._keyDownloadsInProgressByUser[u];
                utils.removeElement(inProgress, function(e) {
                    return e === promise;
                });
                if (inProgress.length === 0) {
                    // no more downloads for this user; remove the element
                    delete self._keyDownloadsInProgressByUser[u];
                }
            });

            if (!self._keyDownloadsInProgressByUser[u]) {
                self._keyDownloadsInProgressByUser[u] = [];
            }
            self._keyDownloadsInProgressByUser[u].push(promise);

            deferMap[u] = deferred;
            promiseMap[u] = promise;
        });

        this._baseApis.downloadKeysForUsers(
            downloadUsers,
        ).done(function(res) {
            const dk = res.device_keys || {};

            for (let i = 0; i < downloadUsers.length; ++i) {
                const userId = downloadUsers[i];
                var deviceId;

                console.log('got keys for ' + userId + ':', dk[userId]);

                if (!dk[userId]) {
                    // no result for this user
                    const err = 'Unknown';
                    // TODO: do something with res.failures
                    deferMap[userId].reject(err);
                    continue;
                }

                // map from deviceid -> deviceinfo for this user
                const userStore = {};
                const devs = self._sessionStore.getEndToEndDevicesForUser(userId);
                if (devs) {
                    for (deviceId in devs) {
                        if (devs.hasOwnProperty(deviceId)) {
                            const d = DeviceInfo.fromStorage(devs[deviceId], deviceId);
                            userStore[deviceId] = d;
                        }
                    }
                }

                _updateStoredDeviceKeysForUser(
                    self._olmDevice, userId, userStore, dk[userId],
                    );

                // update the session store
                const storage = {};
                for (deviceId in userStore) {
                    if (!userStore.hasOwnProperty(deviceId)) {
                        continue;
                    }

                    storage[deviceId] = userStore[deviceId].toStorage();
                }
                self._sessionStore.storeEndToEndDevicesForUser(
                    userId, storage,
                    );

                deferMap[userId].resolve();
            }
        }, function(err) {
            downloadUsers.map(function(u) {
                deferMap[u].reject(err);
            });
        });

        return promiseMap;
    }
}

function _updateStoredDeviceKeysForUser(_olmDevice, userId, userStore,
        userResult) {
    let updated = false;

    // remove any devices in the store which aren't in the response
    for (var deviceId in userStore) {
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

    for (deviceId in userResult) {
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
        console.log("Device " + userId + ":" + deviceId +
            " has no ed25519 key");
        return false;
    }

    const unsigned = deviceResult.unsigned || {};

    try {
        olmlib.verifySignature(_olmDevice, deviceResult, userId, deviceId, signKey);
    } catch (e) {
        console.log("Unable to verify signature on device " +
            userId + ":" + deviceId + ":", e);
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
            console.warn("Ed25519 key for device" + userId + ": " +
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
