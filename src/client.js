/*
Copyright 2015, 2016 OpenMarket Ltd
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

const PushProcessor = require('./pushprocessor');

/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */
const EventEmitter = require("events").EventEmitter;
import Promise from 'bluebird';
const url = require('url');

const httpApi = require("./http-api");
const MatrixEvent = require("./models/event").MatrixEvent;
const EventStatus = require("./models/event").EventStatus;
const EventTimeline = require("./models/event-timeline");
const SearchResult = require("./models/search-result");
const StubStore = require("./store/stub");
const webRtcCall = require("./webrtc/call");
const utils = require("./utils");
const contentRepo = require("./content-repo");
const Filter = require("./filter");
const SyncApi = require("./sync");
const MatrixBaseApis = require("./base-apis");
const MatrixError = httpApi.MatrixError;
const ContentHelpers = require("./content-helpers");
const olmlib = require("./crypto/olmlib");

import ReEmitter from './ReEmitter';
import RoomList from './crypto/RoomList';

import Crypto from './crypto';
import { isCryptoAvailable } from './crypto';
import { encodeRecoveryKey, decodeRecoveryKey } from './crypto/recoverykey';
import { keyForNewBackup, keyForExistingBackup } from './crypto/backup_password';
import { randomString } from './randomstring';

// Disable warnings for now: we use deprecated bluebird functions
// and need to migrate, but they spam the console with warnings.
Promise.config({warnings: false});


const SCROLLBACK_DELAY_MS = 3000;
const CRYPTO_ENABLED = isCryptoAvailable();

function keysFromRecoverySession(sessions, decryptionKey, roomId) {
    const keys = [];
    for (const [sessionId, sessionData] of Object.entries(sessions)) {
        try {
            const decrypted = keyFromRecoverySession(sessionData, decryptionKey);
            decrypted.session_id = sessionId;
            decrypted.room_id = roomId;
            keys.push(decrypted);
        } catch (e) {
            console.log("Failed to decrypt session from backup");
        }
    }
    return keys;
}

function keyFromRecoverySession(session, decryptionKey) {
    return JSON.parse(decryptionKey.decrypt(
        session.session_data.ephemeral,
        session.session_data.mac,
        session.session_data.ciphertext,
    ));
}

/**
 * Construct a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 * @constructor
 * @extends {external:EventEmitter}
 * @extends {module:base-apis~MatrixBaseApis}
 *
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server
 * HTTP API.
 * @param {string} opts.idBaseUrl Optional. The base identity server URL for
 * identity server requests.
 * @param {Function} opts.request Required. The function to invoke for HTTP
 * requests. The value of this property is typically <code>require("request")
 * </code> as it returns a function which meets the required interface. See
 * {@link requestFunction} for more information.
 *
 * @param {string} opts.accessToken The access_token for this user.
 *
 * @param {string} opts.userId The user ID for this user.
 *
 * @param {Object=} opts.store The data store to use. If not specified,
 * this client will not store any HTTP responses.
 *
 * @param {string=} opts.deviceId A unique identifier for this device; used for
 *    tracking things like crypto keys and access tokens.  If not specified,
 *    end-to-end crypto will be disabled.
 *
 * @param {Object=} opts.sessionStore A store to be used for end-to-end crypto
 *    session data. This should be a {@link
 *    module:store/session/webstorage~WebStorageSessionStore|WebStorageSessionStore},
 *    or an object implementing the same interface. If not specified,
 *    end-to-end crypto will be disabled.
 *
 * @param {Object} opts.scheduler Optional. The scheduler to use. If not
 * specified, this client will not retry requests on failure. This client
 * will supply its own processing function to
 * {@link module:scheduler~MatrixScheduler#setProcessFunction}.
 *
 * @param {Object} opts.queryParams Optional. Extra query parameters to append
 * to all requests with this client. Useful for application services which require
 * <code>?user_id=</code>.
 *
 * @param {Number=} opts.localTimeoutMs Optional. The default maximum amount of
 * time to wait before timing out HTTP requests. If not specified, there is no timeout.
 *
 * @param {boolean} [opts.useAuthorizationHeader = false] Set to true to use
 * Authorization header instead of query param to send the access token to the server.
 *
 * @param {boolean} [opts.timelineSupport = false] Set to true to enable
 * improved timeline support ({@link
 * module:client~MatrixClient#getEventTimeline getEventTimeline}). It is
 * disabled by default for compatibility with older clients - in particular to
 * maintain support for back-paginating the live timeline after a '/sync'
 * result with a gap.
 *
 * @param {module:crypto.store.base~CryptoStore} opts.cryptoStore
 *    crypto store implementation.
 */
function MatrixClient(opts) {
    // Allow trailing slash in HS url
    if (opts.baseUrl && opts.baseUrl.endsWith("/")) {
        opts.baseUrl = opts.baseUrl.substr(0, opts.baseUrl.length - 1);
    }

    // Allow trailing slash in IS url
    if (opts.idBaseUrl && opts.idBaseUrl.endsWith("/")) {
        opts.idBaseUrl = opts.idBaseUrl.substr(0, opts.idBaseUrl.length - 1);
    }

    MatrixBaseApis.call(this, opts);

    this.olmVersion = null; // Populated after initCrypto is done

    this.reEmitter = new ReEmitter(this);

    this.store = opts.store || new StubStore();

    this.deviceId = opts.deviceId || null;

    const userId = (opts.userId || null);
    this.credentials = {
        userId: userId,
    };

    this.scheduler = opts.scheduler;
    if (this.scheduler) {
        const self = this;
        this.scheduler.setProcessFunction(function(eventToSend) {
            const room = self.getRoom(eventToSend.getRoomId());
            if (eventToSend.status !== EventStatus.SENDING) {
                _updatePendingEventStatus(room, eventToSend,
                                          EventStatus.SENDING);
            }
            return _sendEventHttpRequest(self, eventToSend);
        });
    }
    this.clientRunning = false;

    this.callList = {
        // callId: MatrixCall
    };

    // try constructing a MatrixCall to see if we are running in an environment
    // which has WebRTC. If we are, listen for and handle m.call.* events.
    const call = webRtcCall.createNewMatrixCall(this);
    this._supportsVoip = false;
    if (call) {
        setupCallEventHandler(this);
        this._supportsVoip = true;
    }
    this._syncingRetry = null;
    this._syncApi = null;
    this._peekSync = null;
    this._isGuest = false;
    this._ongoingScrollbacks = {};
    this.timelineSupport = Boolean(opts.timelineSupport);
    this.urlPreviewCache = {};
    this._notifTimelineSet = null;

    this._crypto = null;
    this._cryptoStore = opts.cryptoStore;
    this._sessionStore = opts.sessionStore;

    this._forceTURN = opts.forceTURN || false;

    // List of which rooms have encryption enabled: separate from crypto because
    // we still want to know which rooms are encrypted even if crypto is disabled:
    // we don't want to start sending unencrypted events to them.
    this._roomList = new RoomList(this._cryptoStore, this._sessionStore);

    // The pushprocessor caches useful things, so keep one and re-use it
    this._pushProcessor = new PushProcessor(this);

    this._serverSupportsLazyLoading = null;
}
utils.inherits(MatrixClient, EventEmitter);
utils.extend(MatrixClient.prototype, MatrixBaseApis.prototype);

/**
 * Clear any data out of the persistent stores used by the client.
 *
 * @returns {Promise} Promise which resolves when the stores have been cleared.
 */
MatrixClient.prototype.clearStores = function() {
    if (this._clientRunning) {
        throw new Error("Cannot clear stores while client is running");
    }

    const promises = [];

    promises.push(this.store.deleteAllData());
    if (this._cryptoStore) {
        promises.push(this._cryptoStore.deleteAllData());
    }
    return Promise.all(promises);
};

/**
 * Get the user-id of the logged-in user
 *
 * @return {?string} MXID for the logged-in user, or null if not logged in
 */
MatrixClient.prototype.getUserId = function() {
    if (this.credentials && this.credentials.userId) {
        return this.credentials.userId;
    }
    return null;
};

/**
 * Get the domain for this client's MXID
 * @return {?string} Domain of this MXID
 */
MatrixClient.prototype.getDomain = function() {
    if (this.credentials && this.credentials.userId) {
        return this.credentials.userId.replace(/^.*?:/, '');
    }
    return null;
};

/**
 * Get the local part of the current user ID e.g. "foo" in "@foo:bar".
 * @return {?string} The user ID localpart or null.
 */
MatrixClient.prototype.getUserIdLocalpart = function() {
    if (this.credentials && this.credentials.userId) {
        return this.credentials.userId.split(":")[0].substring(1);
    }
    return null;
};

/**
 * Get the device ID of this client
 * @return {?string} device ID
 */
MatrixClient.prototype.getDeviceId = function() {
    return this.deviceId;
};


/**
 * Check if the runtime environment supports VoIP calling.
 * @return {boolean} True if VoIP is supported.
 */
MatrixClient.prototype.supportsVoip = function() {
    return this._supportsVoip;
};

/**
 * Set whether VoIP calls are forced to use only TURN
 * candidates. This is the same as the forceTURN option
 * when creating the client.
 * @param {bool} forceTURN True to force use of TURN servers
 */
MatrixClient.prototype.setForceTURN = function(forceTURN) {
    this._forceTURN = forceTURN;
};

/**
 * Get the current sync state.
 * @return {?string} the sync state, which may be null.
 * @see module:client~MatrixClient#event:"sync"
 */
MatrixClient.prototype.getSyncState = function() {
    if (!this._syncApi) {
        return null;
    }
    return this._syncApi.getSyncState();
};

/**
 * Returns the additional data object associated with
 * the current sync state, or null if there is no
 * such data.
 * Sync errors, if available, are put in the 'error' key of
 * this object.
 * @return {?Object}
 */
MatrixClient.prototype.getSyncStateData = function() {
    if (!this._syncApi) {
        return null;
    }
    return this._syncApi.getSyncStateData();
};

/**
 * Return whether the client is configured for a guest account.
 * @return {boolean} True if this is a guest access_token (or no token is supplied).
 */
MatrixClient.prototype.isGuest = function() {
    return this._isGuest;
};

/**
 * Return the provided scheduler, if any.
 * @return {?module:scheduler~MatrixScheduler} The scheduler or null
 */
MatrixClient.prototype.getScheduler = function() {
    return this.scheduler;
};

/**
 * Set whether this client is a guest account. <b>This method is experimental
 * and may change without warning.</b>
 * @param {boolean} isGuest True if this is a guest account.
 */
MatrixClient.prototype.setGuest = function(isGuest) {
    // EXPERIMENTAL:
    // If the token is a macaroon, it should be encoded in it that it is a 'guest'
    // access token, which means that the SDK can determine this entirely without
    // the dev manually flipping this flag.
    this._isGuest = isGuest;
};

/**
 * Retry a backed off syncing request immediately. This should only be used when
 * the user <b>explicitly</b> attempts to retry their lost connection.
 * @return {boolean} True if this resulted in a request being retried.
 */
MatrixClient.prototype.retryImmediately = function() {
    return this._syncApi.retryImmediately();
};

/**
 * Return the global notification EventTimelineSet, if any
 *
 * @return {EventTimelineSet} the globl notification EventTimelineSet
 */
MatrixClient.prototype.getNotifTimelineSet = function() {
    return this._notifTimelineSet;
};

/**
 * Set the global notification EventTimelineSet
 *
 * @param {EventTimelineSet} notifTimelineSet
 */
MatrixClient.prototype.setNotifTimelineSet = function(notifTimelineSet) {
    this._notifTimelineSet = notifTimelineSet;
};

// Crypto bits
// ===========

/**
 * Initialise support for end-to-end encryption in this client
 *
 * You should call this method after creating the matrixclient, but *before*
 * calling `startClient`, if you want to support end-to-end encryption.
 *
 * It will return a Promise which will resolve when the crypto layer has been
 * successfully initialised.
 */
MatrixClient.prototype.initCrypto = async function() {
    if (!isCryptoAvailable()) {
        throw new Error(
            `End-to-end encryption not supported in this js-sdk build: did ` +
                `you remember to load the olm library?`,
        );
    }

    if (this._crypto) {
        console.warn("Attempt to re-initialise e2e encryption on MatrixClient");
        return;
    }

    if (!this._sessionStore) {
        // this is temporary, the sessionstore is supposed to be going away
        throw new Error(`Cannot enable encryption: no sessionStore provided`);
    }
    if (!this._cryptoStore) {
        // the cryptostore is provided by sdk.createClient, so this shouldn't happen
        throw new Error(`Cannot enable encryption: no cryptoStore provided`);
    }

    // initialise the list of encrypted rooms (whether or not crypto is enabled)
    await this._roomList.init();

    const userId = this.getUserId();
    if (userId === null) {
        throw new Error(
            `Cannot enable encryption on MatrixClient with unknown userId: ` +
                `ensure userId is passed in createClient().`,
        );
    }
    if (this.deviceId === null) {
        throw new Error(
            `Cannot enable encryption on MatrixClient with unknown deviceId: ` +
                `ensure deviceId is passed in createClient().`,
        );
    }

    const crypto = new Crypto(
        this,
        this._sessionStore,
        userId, this.deviceId,
        this.store,
        this._cryptoStore,
        this._roomList,
    );

    this.reEmitter.reEmit(crypto, [
        "crypto.keyBackupFailed",
        "crypto.roomKeyRequest",
        "crypto.roomKeyRequestCancellation",
        "crypto.warning",
    ]);

    await crypto.init();

    this.olmVersion = Crypto.getOlmVersion();


    // if crypto initialisation was successful, tell it to attach its event
    // handlers.
    crypto.registerEventHandlers(this);
    this._crypto = crypto;
};


/**
 * Is end-to-end crypto enabled for this client.
 * @return {boolean} True if end-to-end is enabled.
 */
MatrixClient.prototype.isCryptoEnabled = function() {
    return this._crypto !== null;
};


/**
 * Get the Ed25519 key for this device
 *
 * @return {?string} base64-encoded ed25519 key. Null if crypto is
 *    disabled.
 */
MatrixClient.prototype.getDeviceEd25519Key = function() {
    if (!this._crypto) {
        return null;
    }
    return this._crypto.getDeviceEd25519Key();
};

/**
 * Upload the device keys to the homeserver.
 * @return {object} A promise that will resolve when the keys are uploaded.
 */
MatrixClient.prototype.uploadKeys = function() {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    return this._crypto.uploadDeviceKeys();
};

/**
 * Download the keys for a list of users and stores the keys in the session
 * store.
 * @param {Array} userIds The users to fetch.
 * @param {bool} forceDownload Always download the keys even if cached.
 *
 * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
 * module:crypto~DeviceInfo|DeviceInfo}.
 */
MatrixClient.prototype.downloadKeys = function(userIds, forceDownload) {
    if (this._crypto === null) {
        return Promise.reject(new Error("End-to-end encryption disabled"));
    }
    return this._crypto.downloadKeys(userIds, forceDownload);
};

/**
 * Get the stored device keys for a user id
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {Promise<module:crypto-deviceinfo[]>} list of devices
 */
MatrixClient.prototype.getStoredDevicesForUser = async function(userId) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    return this._crypto.getStoredDevicesForUser(userId) || [];
};

/**
 * Get the stored device key for a user id and device id
 *
 * @param {string} userId the user to list keys for.
 * @param {string} deviceId unique identifier for the device
 *
 * @return {Promise<?module:crypto-deviceinfo>} device or null
 */
MatrixClient.prototype.getStoredDevice = async function(userId, deviceId) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    return this._crypto.getStoredDevice(userId, deviceId) || null;
};

/**
 * Mark the given device as verified
 *
 * @param {string} userId owner of the device
 * @param {string} deviceId unique identifier for the device
 *
 * @param {boolean=} verified whether to mark the device as verified. defaults
 *   to 'true'.
 *
 * @returns {Promise}
 *
 * @fires module:client~event:MatrixClient"deviceVerificationChanged"
 */
MatrixClient.prototype.setDeviceVerified = function(userId, deviceId, verified) {
    if (verified === undefined) {
        verified = true;
    }
    const prom = _setDeviceVerification(this, userId, deviceId, verified, null);

    // if one of the user's own devices is being marked as verified / unverified,
    // check the key backup status, since whether or not we use this depends on
    // whether it has a signature from a verified device
    if (userId == this.credentials.userId) {
        this._crypto.checkKeyBackup();
    }
    return prom;
};

/**
 * Mark the given device as blocked/unblocked
 *
 * @param {string} userId owner of the device
 * @param {string} deviceId unique identifier for the device
 *
 * @param {boolean=} blocked whether to mark the device as blocked. defaults
 *   to 'true'.
 *
 * @returns {Promise}
 *
 * @fires module:client~event:MatrixClient"deviceVerificationChanged"
 */
MatrixClient.prototype.setDeviceBlocked = function(userId, deviceId, blocked) {
    if (blocked === undefined) {
        blocked = true;
    }
    return _setDeviceVerification(this, userId, deviceId, null, blocked);
};

/**
 * Mark the given device as known/unknown
 *
 * @param {string} userId owner of the device
 * @param {string} deviceId unique identifier for the device
 *
 * @param {boolean=} known whether to mark the device as known. defaults
 *   to 'true'.
 *
 * @returns {Promise}
 *
 * @fires module:client~event:MatrixClient"deviceVerificationChanged"
 */
MatrixClient.prototype.setDeviceKnown = function(userId, deviceId, known) {
    if (known === undefined) {
        known = true;
    }
    return _setDeviceVerification(this, userId, deviceId, null, null, known);
};

async function _setDeviceVerification(
    client, userId, deviceId, verified, blocked, known,
) {
    if (!client._crypto) {
        throw new Error("End-to-End encryption disabled");
    }
    const dev = await client._crypto.setDeviceVerification(
        userId, deviceId, verified, blocked, known,
    );
    client.emit("deviceVerificationChanged", userId, deviceId, dev);
}

/**
 * Set the global override for whether the client should ever send encrypted
 * messages to unverified devices.  This provides the default for rooms which
 * do not specify a value.
 *
 * @param {boolean} value whether to blacklist all unverified devices by default
 */
MatrixClient.prototype.setGlobalBlacklistUnverifiedDevices = function(value) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    this._crypto.setGlobalBlacklistUnverifiedDevices(value);
};

/**
 * @return {boolean} whether to blacklist all unverified devices by default
 */
MatrixClient.prototype.getGlobalBlacklistUnverifiedDevices = function() {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    return this._crypto.getGlobalBlacklistUnverifiedDevices();
};

/**
 * Get e2e information on the device that sent an event
 *
 * @param {MatrixEvent} event event to be checked
 *
 * @return {Promise<module:crypto/deviceinfo?>}
 */
MatrixClient.prototype.getEventSenderDeviceInfo = async function(event) {
    if (!this._crypto) {
        return null;
    }

    return this._crypto.getEventSenderDeviceInfo(event);
};

/**
 * Check if the sender of an event is verified
 *
 * @param {MatrixEvent} event event to be checked
 *
 * @return {boolean} true if the sender of this event has been verified using
 * {@link module:client~MatrixClient#setDeviceVerified|setDeviceVerified}.
 */
MatrixClient.prototype.isEventSenderVerified = async function(event) {
    const device = await this.getEventSenderDeviceInfo(event);
    if (!device) {
        return false;
    }
    return device.isVerified();
};

/**
 * Cancel a room key request for this event if one is ongoing and resend the
 * request.
 * @param  {MatrixEvent} event event of which to cancel and resend the room
 *                            key request.
 */
MatrixClient.prototype.cancelAndResendEventRoomKeyRequest = function(event) {
    event.cancelAndResendKeyRequest(this._crypto);
};

/**
 * Enable end-to-end encryption for a room.
 * @param {string} roomId The room ID to enable encryption in.
 * @param {object} config The encryption config for the room.
 * @return {Promise} A promise that will resolve when encryption is set up.
 */
MatrixClient.prototype.setRoomEncryption = function(roomId, config) {
    if (!this._crypto) {
        throw new Error("End-to-End encryption disabled");
    }
    return this._crypto.setRoomEncryption(roomId, config);
};

/**
 * Whether encryption is enabled for a room.
 * @param {string} roomId the room id to query.
 * @return {bool} whether encryption is enabled.
 */
MatrixClient.prototype.isRoomEncrypted = function(roomId) {
    const room = this.getRoom(roomId);
    if (!room) {
        // we don't know about this room, so can't determine if it should be
        // encrypted. Let's assume not.
        return false;
    }

    // if there is an 'm.room.encryption' event in this room, it should be
    // encrypted (independently of whether we actually support encryption)
    const ev = room.currentState.getStateEvents("m.room.encryption", "");
    if (ev) {
        return true;
    }

    // we don't have an m.room.encrypted event, but that might be because
    // the server is hiding it from us. Check the store to see if it was
    // previously encrypted.
    return this._roomList.isRoomEncrypted(roomId);
};

/**
 * Forces the current outbound group session to be discarded such
 * that another one will be created next time an event is sent.
 *
 * @param {string} roomId The ID of the room to discard the session for
 *
 * This should not normally be necessary.
 */
MatrixClient.prototype.forceDiscardSession = function(roomId) {
    if (!this._crypto) {
        throw new Error("End-to-End encryption disabled");
    }
    this._crypto.forceDiscardSession(roomId);
};

/**
 * Get a list containing all of the room keys
 *
 * This should be encrypted before returning it to the user.
 *
 * @return {module:client.Promise} a promise which resolves to a list of
 *    session export objects
 */
MatrixClient.prototype.exportRoomKeys = function() {
    if (!this._crypto) {
        return Promise.reject(new Error("End-to-end encryption disabled"));
    }
    return this._crypto.exportRoomKeys();
};

/**
 * Import a list of room keys previously exported by exportRoomKeys
 *
 * @param {Object[]} keys a list of session export objects
 *
 * @return {module:client.Promise} a promise which resolves when the keys
 *    have been imported
 */
MatrixClient.prototype.importRoomKeys = function(keys) {
    if (!this._crypto) {
        throw new Error("End-to-end encryption disabled");
    }
    return this._crypto.importRoomKeys(keys);
};

/**
 * Get information about the current key backup.
 * @returns {Promise} Information object from API or null
 */
MatrixClient.prototype.getKeyBackupVersion = function() {
    return this._http.authedRequest(
        undefined, "GET", "/room_keys/version",
    ).then((res) => {
        if (res.algorithm !== olmlib.MEGOLM_BACKUP_ALGORITHM) {
            const err = "Unknown backup algorithm: " + res.algorithm;
            return Promise.reject(err);
        } else if (!(typeof res.auth_data === "object")
                   || !res.auth_data.public_key) {
            const err = "Invalid backup data returned";
            return Promise.reject(err);
        } else {
            return res;
        }
    }).catch((e) => {
        if (e.errcode === 'M_NOT_FOUND') {
            return null;
        } else {
            throw e;
        }
    });
};

/**
 * @param {object} info key backup info dict from getKeyBackupVersion()
 * @return {object} {
 *     usable: [bool], // is the backup trusted, true iff there is a sig that is valid & from a trusted device
 *     sigs: [
 *         valid: [bool],
 *         device: [DeviceInfo],
 *     ]
 * }
 */
MatrixClient.prototype.isKeyBackupTrusted = function(info) {
    return this._crypto.isKeyBackupTrusted(info);
};

/**
 * @returns {bool} true if the client is configured to back up keys to
 *     the server, otherwise false.
 */
MatrixClient.prototype.getKeyBackupEnabled = function() {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    return Boolean(this._crypto.backupKey);
};

/**
 * Enable backing up of keys, using data previously returned from
 * getKeyBackupVersion.
 *
 * @param {object} info Backup information object as returned by getKeyBackupVersion
 */
MatrixClient.prototype.enableKeyBackup = function(info) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    this._crypto.backupInfo = info;
    if (this._crypto.backupKey) this._crypto.backupKey.free();
    this._crypto.backupKey = new global.Olm.PkEncryption();
    this._crypto.backupKey.set_recipient_key(info.auth_data.public_key);

    this.emit('crypto.keyBackupStatus', true);
};

/**
 * Disable backing up of keys.
 */
MatrixClient.prototype.disableKeyBackup = function() {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    this._crypto.backupInfo = null;
    if (this._crypto.backupKey) this._crypto.backupKey.free();
    this._crypto.backupKey = null;

    this.emit('crypto.keyBackupStatus', false);
};

/**
 * Set up the data required to create a new backup version.  The backup version
 * will not be created and enabled until createKeyBackupVersion is called.
 *
 * @param {string} password Passphrase string that can be entered by the user
 *     when restoring the backup as an alternative to entering the recovery key.
 *     Optional.
 *
 * @returns {Promise<object>} Object that can be passed to createKeyBackupVersion and
 *     additionally has a 'recovery_key' member with the user-facing recovery key string.
 */
MatrixClient.prototype.prepareKeyBackupVersion = async function(password) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    const decryption = new global.Olm.PkDecryption();
    try {
        let publicKey;
        const authData = {};
        if (password) {
            const keyInfo = await keyForNewBackup(password);
            publicKey = decryption.init_with_private_key(keyInfo.key);
            authData.private_key_salt = keyInfo.salt;
            authData.private_key_iterations = keyInfo.iterations;
        } else {
            publicKey = decryption.generate_key();
        }

        authData.public_key = publicKey;

        return {
            algorithm: olmlib.MEGOLM_BACKUP_ALGORITHM,
            auth_data: authData,
            recovery_key: encodeRecoveryKey(decryption.get_private_key()),
        };
    } finally {
        decryption.free();
    }
};

/**
 * Create a new key backup version and enable it, using the information return
 * from prepareKeyBackupVersion.
 *
 * @param {object} info Info object from prepareKeyBackupVersion
 * @returns {Promise<object>} Object with 'version' param indicating the version created
 */
MatrixClient.prototype.createKeyBackupVersion = function(info) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    const data = {
        algorithm: info.algorithm,
        auth_data: info.auth_data,
    };
    return this._crypto._signObject(data.auth_data).then(() => {
        return this._http.authedRequest(
            undefined, "POST", "/room_keys/version", undefined, data,
        );
    }).then((res) => {
        this.enableKeyBackup({
            algorithm: info.algorithm,
            auth_data: info.auth_data,
            version: res.version,
        });
        return res;
    });
};

MatrixClient.prototype.deleteKeyBackupVersion = function(version) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    // If we're currently backing up to this backup... stop.
    // (We start using it automatically in createKeyBackupVersion
    // so this is symmetrical).
    if (this._crypto.backupInfo && this._crypto.backupInfo.version === version) {
        this.disableKeyBackup();
    }

    const path = utils.encodeUri("/room_keys/version/$version", {
        $version: version,
    });

    return this._http.authedRequest(
        undefined, "DELETE", path, undefined, undefined,
    );
};

MatrixClient.prototype._makeKeyBackupPath = function(roomId, sessionId, version) {
    let path;
    if (sessionId !== undefined) {
        path = utils.encodeUri("/room_keys/keys/$roomId/$sessionId", {
            $roomId: roomId,
            $sessionId: sessionId,
        });
    } else if (roomId !== undefined) {
        path = utils.encodeUri("/room_keys/keys/$roomId", {
            $roomId: roomId,
        });
    } else {
        path = "/room_keys/keys";
    }
    const queryData = version === undefined ? undefined : { version: version };
    return {
        path: path,
        queryData: queryData,
    };
};

/**
 * Back up session keys to the homeserver.
 * @param {string} roomId ID of the room that the keys are for Optional.
 * @param {string} sessionId ID of the session that the keys are for Optional.
 * @param {integer} version backup version Optional.
 * @param {object} data Object keys to send
 * @return {module:client.Promise} a promise that will resolve when the keys
 * are uploaded
 */
MatrixClient.prototype.sendKeyBackup = function(roomId, sessionId, version, data) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    const path = this._makeKeyBackupPath(roomId, sessionId, version);
    return this._http.authedRequest(
        undefined, "PUT", path.path, path.queryData, data,
    );
};

MatrixClient.prototype.backupAllGroupSessions = function(version) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    return this._crypto.backupAllGroupSessions(version);
};

MatrixClient.prototype.isValidRecoveryKey = function(recoveryKey) {
    try {
        decodeRecoveryKey(recoveryKey);
        return true;
    } catch (e) {
        return false;
    }
};

MatrixClient.prototype.restoreKeyBackupWithPassword = async function(
    password, targetRoomId, targetSessionId, version,
) {
    const backupInfo = await this.getKeyBackupVersion();

    const privKey = await keyForExistingBackup(backupInfo, password);
    return this._restoreKeyBackup(
        privKey, targetRoomId, targetSessionId, version,
    );
};

MatrixClient.prototype.restoreKeyBackupWithRecoveryKey = function(
    recoveryKey, targetRoomId, targetSessionId, version,
) {
    const privKey = decodeRecoveryKey(recoveryKey);
    return this._restoreKeyBackup(
        privKey, targetRoomId, targetSessionId, version,
    );
};

MatrixClient.prototype._restoreKeyBackup = function(
    privKey, targetRoomId, targetSessionId, version,
) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }
    let totalKeyCount = 0;
    let keys = [];

    const path = this._makeKeyBackupPath(targetRoomId, targetSessionId, version);

    const decryption = new global.Olm.PkDecryption();
    try {
        decryption.init_with_private_key(privKey);
    } catch(e) {
        decryption.free();
        throw e;
    }

    return this._http.authedRequest(
        undefined, "GET", path.path, path.queryData,
    ).then((res) => {
        if (res.rooms) {
            for (const [roomId, roomData] of Object.entries(res.rooms)) {
                if (!roomData.sessions) continue;

                totalKeyCount += Object.keys(roomData.sessions).length;
                const roomKeys = keysFromRecoverySession(
                    roomData.sessions, decryption, roomId, roomKeys,
                );
                for (const k of roomKeys) {
                    k.room_id = roomId;
                    keys.push(k);
                }
            }
        } else if (res.sessions) {
            totalKeyCount = Object.keys(res.sessions).length;
            keys = keysFromRecoverySession(
                res.sessions, decryption, targetRoomId, keys,
            );
        } else {
            totalKeyCount = 1;
            try {
                const key = keyFromRecoverySession(res, decryption);
                key.room_id = targetRoomId;
                key.session_id = targetSessionId;
                keys.push(key);
            } catch (e) {
                console.log("Failed to decrypt session from backup");
            }
        }

        return this.importRoomKeys(keys);
    }).then(() => {
        return {total: totalKeyCount, imported: keys.length};
    }).finally(() => {
        decryption.free();
    });
};

MatrixClient.prototype.deleteKeysFromBackup = function(roomId, sessionId, version) {
    if (this._crypto === null) {
        throw new Error("End-to-end encryption disabled");
    }

    const path = this._makeKeyBackupPath(roomId, sessionId, version);
    return this._http.authedRequest(
        undefined, "DELETE", path.path, path.queryData,
    );
};

// Group ops
// =========
// Operations on groups that come down the sync stream (ie. ones the
// user is a member of or invited to)

/**
 * Get the group for the given group ID.
 * This function will return a valid group for any group for which a Group event
 * has been emitted.
 * @param {string} groupId The group ID
 * @return {Group} The Group or null if the group is not known or there is no data store.
 */
MatrixClient.prototype.getGroup = function(groupId) {
    return this.store.getGroup(groupId);
};

/**
 * Retrieve all known groups.
 * @return {Group[]} A list of groups, or an empty list if there is no data store.
 */
MatrixClient.prototype.getGroups = function() {
    return this.store.getGroups();
};

/**
 * Get the config for the media repository.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves with an object containing the config.
 */
MatrixClient.prototype.getMediaConfig = function(callback) {
    return this._http.authedRequestWithPrefix(
        callback, "GET", "/config", undefined, undefined, httpApi.PREFIX_MEDIA_R0,
    );
};

// Room ops
// ========

/**
 * Get the room for the given room ID.
 * This function will return a valid room for any room for which a Room event
 * has been emitted. Note in particular that other events, eg. RoomState.members
 * will be emitted for a room before this function will return the given room.
 * @param {string} roomId The room ID
 * @return {Room} The Room or null if it doesn't exist or there is no data store.
 */
MatrixClient.prototype.getRoom = function(roomId) {
    return this.store.getRoom(roomId);
};

/**
 * Retrieve all known rooms.
 * @return {Room[]} A list of rooms, or an empty list if there is no data store.
 */
MatrixClient.prototype.getRooms = function() {
    return this.store.getRooms();
};

/**
 * Retrieve all rooms that should be displayed to the user
 * This is essentially getRooms() with some rooms filtered out, eg. old versions
 * of rooms that have been replaced or (in future) other rooms that have been
 * marked at the protocol level as not to be displayed to the user.
 * @return {Room[]} A list of rooms, or an empty list if there is no data store.
 */
MatrixClient.prototype.getVisibleRooms = function() {
    const allRooms = this.store.getRooms();

    const replacedRooms = new Set();
    for (const r of allRooms) {
        const createEvent = r.currentState.getStateEvents('m.room.create', '');
        // invites are included in this list and we don't know their create events yet
        if (createEvent) {
            const predecessor = createEvent.getContent()['predecessor'];
            if (predecessor && predecessor['room_id']) {
                replacedRooms.add(predecessor['room_id']);
            }
        }
    }

    return allRooms.filter((r) => {
        const tombstone = r.currentState.getStateEvents('m.room.tombstone', '');
        if (tombstone && replacedRooms.has(r.roomId)) {
            return false;
        }
        return true;
    });
};

/**
 * Retrieve a user.
 * @param {string} userId The user ID to retrieve.
 * @return {?User} A user or null if there is no data store or the user does
 * not exist.
 */
MatrixClient.prototype.getUser = function(userId) {
    return this.store.getUser(userId);
};

/**
 * Retrieve all known users.
 * @return {User[]} A list of users, or an empty list if there is no data store.
 */
MatrixClient.prototype.getUsers = function() {
    return this.store.getUsers();
};

// User Account Data operations
// ============================

/**
 * Set account data event for the current user.
 * @param {string} eventType The event type
 * @param {Object} contents the contents object for the event
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setAccountData = function(eventType, contents, callback) {
    const path = utils.encodeUri("/user/$userId/account_data/$type", {
        $userId: this.credentials.userId,
        $type: eventType,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, contents,
    );
};

/**
 * Get account data event of given type for the current user.
 * @param {string} eventType The event type
 * @return {?object} The contents of the given account data event
 */
MatrixClient.prototype.getAccountData = function(eventType) {
    return this.store.getAccountData(eventType);
};

/**
 * Gets the users that are ignored by this client
 * @returns {string[]} The array of users that are ignored (empty if none)
 */
MatrixClient.prototype.getIgnoredUsers = function() {
    const event = this.getAccountData("m.ignored_user_list");
    if (!event || !event.getContent() || !event.getContent()["ignored_users"]) return [];
    return Object.keys(event.getContent()["ignored_users"]);
};

/**
 * Sets the users that the current user should ignore.
 * @param {string[]} userIds the user IDs to ignore
 * @param {module:client.callback} [callback] Optional.
 * @return {module:client.Promise} Resolves: Account data event
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setIgnoredUsers = function(userIds, callback) {
    const content = {ignored_users: {}};
    userIds.map((u) => content.ignored_users[u] = {});
    return this.setAccountData("m.ignored_user_list", content, callback);
};

/**
 * Gets whether or not a specific user is being ignored by this client.
 * @param {string} userId the user ID to check
 * @returns {boolean} true if the user is ignored, false otherwise
 */
MatrixClient.prototype.isUserIgnored = function(userId) {
    return this.getIgnoredUsers().indexOf(userId) !== -1;
};

// Room operations
// ===============

/**
 * Join a room. If you have already joined the room, this will no-op.
 * @param {string} roomIdOrAlias The room ID or room alias to join.
 * @param {Object} opts Options when joining the room.
 * @param {boolean} opts.syncRoom True to do a room initial sync on the resulting
 * room. If false, the <strong>returned Room object will have no current state.
 * </strong> Default: true.
 * @param {boolean} opts.inviteSignUrl If the caller has a keypair 3pid invite,
 *                                     the signing URL is passed in this parameter.
 * @param {string[]} opts.viaServers The server names to try and join through in
 *                                   addition to those that are automatically chosen.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Room object.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.joinRoom = function(roomIdOrAlias, opts, callback) {
    // to help people when upgrading..
    if (utils.isFunction(opts)) {
        throw new Error("Expected 'opts' object, got function.");
    }
    opts = opts || {};
    if (opts.syncRoom === undefined) {
        opts.syncRoom = true;
    }

    const room = this.getRoom(roomIdOrAlias);
    if (room && room.hasMembershipState(this.credentials.userId, "join")) {
        return Promise.resolve(room);
    }

    let sign_promise = Promise.resolve();

    if (opts.inviteSignUrl) {
        sign_promise = this._http.requestOtherUrl(
            undefined, 'POST',
            opts.inviteSignUrl, { mxid: this.credentials.userId },
        );
    }

    const queryString = {};
    if (opts.viaServers) {
        queryString["server_name"] = opts.viaServers;
    }

    const reqOpts = {qsStringifyOptions: {arrayFormat: 'repeat'}};

    const defer = Promise.defer();

    const self = this;
    sign_promise.then(function(signed_invite_object) {
        const data = {};
        if (signed_invite_object) {
            data.third_party_signed = signed_invite_object;
        }

        const path = utils.encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
        return self._http.authedRequest(
            undefined, "POST", path, queryString, data, reqOpts);
    }).then(function(res) {
        const roomId = res.room_id;
        const syncApi = new SyncApi(self, self._clientOpts);
        const room = syncApi.createRoom(roomId);
        if (opts.syncRoom) {
            // v2 will do this for us
            // return syncApi.syncRoom(room);
        }
        return Promise.resolve(room);
    }).done(function(room) {
        _resolve(callback, defer, room);
    }, function(err) {
        _reject(callback, defer, err);
    });
    return defer.promise;
};

/**
 * Resend an event.
 * @param {MatrixEvent} event The event to resend.
 * @param {Room} room Optional. The room the event is in. Will update the
 * timeline entry if provided.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.resendEvent = function(event, room) {
    _updatePendingEventStatus(room, event, EventStatus.SENDING);
    return _sendEvent(this, room, event);
};

/**
 * Cancel a queued or unsent event.
 *
 * @param {MatrixEvent} event   Event to cancel
 * @throws Error if the event is not in QUEUED or NOT_SENT state
 */
MatrixClient.prototype.cancelPendingEvent = function(event) {
    if ([EventStatus.QUEUED, EventStatus.NOT_SENT].indexOf(event.status) < 0) {
        throw new Error("cannot cancel an event with status " + event.status);
    }

    // first tell the scheduler to forget about it, if it's queued
    if (this.scheduler) {
        this.scheduler.removeEventFromQueue(event);
    }

    // then tell the room about the change of state, which will remove it
    // from the room's list of pending events.
    const room = this.getRoom(event.getRoomId());
    _updatePendingEventStatus(room, event, EventStatus.CANCELLED);
};

/**
 * @param {string} roomId
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomName = function(roomId, name, callback) {
    return this.sendStateEvent(roomId, "m.room.name", {name: name},
                               undefined, callback);
};

/**
 * @param {string} roomId
 * @param {string} topic
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomTopic = function(roomId, topic, callback) {
    return this.sendStateEvent(roomId, "m.room.topic", {topic: topic},
                               undefined, callback);
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getRoomTags = function(roomId, callback) {
    const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/", {
        $userId: this.credentials.userId,
        $roomId: roomId,
    });
    return this._http.authedRequest(
        callback, "GET", path, undefined,
    );
};

/**
 * @param {string} roomId
 * @param {string} tagName name of room tag to be set
 * @param {object} metadata associated with that tag to be stored
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomTag = function(roomId, tagName, metadata, callback) {
    const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
        $userId: this.credentials.userId,
        $roomId: roomId,
        $tag: tagName,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, metadata,
    );
};

/**
 * @param {string} roomId
 * @param {string} tagName name of room tag to be removed
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.deleteRoomTag = function(roomId, tagName, callback) {
    const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
        $userId: this.credentials.userId,
        $roomId: roomId,
        $tag: tagName,
    });
    return this._http.authedRequest(
        callback, "DELETE", path, undefined, undefined,
    );
};

/**
 * @param {string} roomId
 * @param {string} eventType event type to be set
 * @param {object} content event content
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomAccountData = function(roomId, eventType,
                                                     content, callback) {
    const path = utils.encodeUri("/user/$userId/rooms/$roomId/account_data/$type", {
        $userId: this.credentials.userId,
        $roomId: roomId,
        $type: eventType,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content,
    );
};

/**
 * Set a user's power level.
 * @param {string} roomId
 * @param {string} userId
 * @param {Number} powerLevel
 * @param {MatrixEvent} event
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setPowerLevel = function(roomId, userId, powerLevel,
                                                event, callback) {
    let content = {
        users: {},
    };
    if (event && event.getType() === "m.room.power_levels") {
        // take a copy of the content to ensure we don't corrupt
        // existing client state with a failed power level change
        content = utils.deepCopy(event.getContent());
    }
    content.users[userId] = powerLevel;
    const path = utils.encodeUri("/rooms/$roomId/state/m.room.power_levels", {
        $roomId: roomId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content,
    );
};

/**
 * @param {string} roomId
 * @param {string} eventType
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEvent = function(roomId, eventType, content, txnId,
                                            callback) {
    if (utils.isFunction(txnId)) {
        callback = txnId; txnId = undefined;
    }

    if (!txnId) {
        txnId = this.makeTxnId();
    }

    console.log(`sendEvent of type ${eventType} in ${roomId} with txnId ${txnId}`);

    // we always construct a MatrixEvent when sending because the store and
    // scheduler use them. We'll extract the params back out if it turns out
    // the client has no scheduler or store.
    const room = this.getRoom(roomId);
    const localEvent = new MatrixEvent({
        event_id: "~" + roomId + ":" + txnId,
        user_id: this.credentials.userId,
        room_id: roomId,
        type: eventType,
        origin_server_ts: new Date().getTime(),
        content: content,
    });
    localEvent._txnId = txnId;
    localEvent.status = EventStatus.SENDING;

    // add this event immediately to the local store as 'sending'.
    if (room) {
        room.addPendingEvent(localEvent, txnId);
    }

    // addPendingEvent can change the state to NOT_SENT if it believes
    // that there's other events that have failed. We won't bother to
    // try sending the event if the state has changed as such.
    if (localEvent.status === EventStatus.NOT_SENT) {
        return Promise.reject(new Error("Event blocked by other events not yet sent"));
    }

    return _sendEvent(this, room, localEvent, callback);
};


// encrypts the event if necessary
// adds the event to the queue, or sends it
// marks the event as sent/unsent
// returns a promise which resolves with the result of the send request
function _sendEvent(client, room, event, callback) {
    // Add an extra Promise.resolve() to turn synchronous exceptions into promise rejections,
    // so that we can handle synchronous and asynchronous exceptions with the
    // same code path.
    return Promise.resolve().then(function() {
        const encryptionPromise = _encryptEventIfNeeded(client, event, room);

        if (!encryptionPromise) {
            return null;
        }

        _updatePendingEventStatus(room, event, EventStatus.ENCRYPTING);
        return encryptionPromise.then(() => {
            _updatePendingEventStatus(room, event, EventStatus.SENDING);
        });
    }).then(function() {
        let promise;
        // this event may be queued
        if (client.scheduler) {
            // if this returns a promsie then the scheduler has control now and will
            // resolve/reject when it is done. Internally, the scheduler will invoke
            // processFn which is set to this._sendEventHttpRequest so the same code
            // path is executed regardless.
            promise = client.scheduler.queueEvent(event);
            if (promise && client.scheduler.getQueueForEvent(event).length > 1) {
                // event is processed FIFO so if the length is 2 or more we know
                // this event is stuck behind an earlier event.
                _updatePendingEventStatus(room, event, EventStatus.QUEUED);
            }
        }

        if (!promise) {
            promise = _sendEventHttpRequest(client, event);
        }
        return promise;
    }).then(function(res) {  // the request was sent OK
        if (room) {
            room.updatePendingEvent(event, EventStatus.SENT, res.event_id);
        }
        if (callback) {
            callback(null, res);
        }
        return res;
    }, function(err) {
        // the request failed to send.
        console.error("Error sending event", err.stack || err);

        try {
            // set the error on the event before we update the status:
            // updating the status emits the event, so the state should be
            // consistent at that point.
            event.error = err;
            _updatePendingEventStatus(room, event, EventStatus.NOT_SENT);
            // also put the event object on the error: the caller will need this
            // to resend or cancel the event
            err.event = event;

            if (callback) {
                callback(err);
            }
        } catch (err2) {
            console.error("Exception in error handler!", err2.stack || err);
        }
        throw err;
    });
}

/**
 * Encrypt an event according to the configuration of the room, if necessary.
 *
 * @param {MatrixClient} client
 *
 * @param {module:models/event.MatrixEvent} event  event to be sent
 *
 * @param {module:models/room?} room destination room. Null if the destination
 *     is not a room we have seen over the sync pipe.
 *
 * @return {module:client.Promise?} Promise which resolves when the event has been
 *     encrypted, or null if nothing was needed
 */

function _encryptEventIfNeeded(client, event, room) {
    if (event.isEncrypted()) {
        // this event has already been encrypted; this happens if the
        // encryption step succeeded, but the send step failed on the first
        // attempt.
        return null;
    }

    if (!client.isRoomEncrypted(event.getRoomId())) {
        // looks like this room isn't encrypted.
        return null;
    }

    if (!client._crypto) {
        throw new Error(
            "This room is configured to use encryption, but your client does " +
            "not support encryption.",
        );
    }

    return client._crypto.encryptEvent(event, room);
}

function _updatePendingEventStatus(room, event, newStatus) {
    if (room) {
        room.updatePendingEvent(event, newStatus);
    } else {
        event.status = newStatus;
    }
}

function _sendEventHttpRequest(client, event) {
    const txnId = event._txnId ? event._txnId : client.makeTxnId();

    const pathParams = {
        $roomId: event.getRoomId(),
        $eventType: event.getWireType(),
        $stateKey: event.getStateKey(),
        $txnId: txnId,
    };

    let path;

    if (event.isState()) {
        let pathTemplate = "/rooms/$roomId/state/$eventType";
        if (event.getStateKey() && event.getStateKey().length > 0) {
            pathTemplate = "/rooms/$roomId/state/$eventType/$stateKey";
        }
        path = utils.encodeUri(pathTemplate, pathParams);
    } else {
        path = utils.encodeUri(
            "/rooms/$roomId/send/$eventType/$txnId", pathParams,
        );
    }

    return client._http.authedRequest(
        undefined, "PUT", path, undefined, event.getWireContent(),
    ).then((res) => {
        console.log(
            `Event sent to ${event.getRoomId()} with event id ${res.event_id}`,
        );
        return res;
    });
}

/**
 * @param {string} roomId
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendMessage = function(roomId, content, txnId, callback) {
    if (utils.isFunction(txnId)) {
        callback = txnId; txnId = undefined;
    }
    return this.sendEvent(
        roomId, "m.room.message", content, txnId, callback,
    );
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTextMessage = function(roomId, body, txnId, callback) {
    const content = ContentHelpers.makeTextMessage(body);
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendNotice = function(roomId, body, txnId, callback) {
    const content = ContentHelpers.makeNotice(body);
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEmoteMessage = function(roomId, body, txnId, callback) {
    const content = ContentHelpers.makeEmoteMessage(body);
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} url
 * @param {Object} info
 * @param {string} text
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendImageMessage = function(roomId, url, info, text, callback) {
    if (utils.isFunction(text)) {
        callback = text; text = undefined;
    }
    if (!text) {
        text = "Image";
    }
    const content = {
         msgtype: "m.image",
         url: url,
         info: info,
         body: text,
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} url
 * @param {Object} info
 * @param {string} text
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendStickerMessage = function(roomId, url, info, text, callback) {
    if (utils.isFunction(text)) {
        callback = text; text = undefined;
    }
    if (!text) {
        text = "Sticker";
    }
    const content = {
         url: url,
         info: info,
         body: text,
    };
    return this.sendEvent(
        roomId, "m.sticker", content, callback, undefined,
    );
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlMessage = function(roomId, body, htmlBody, callback) {
    const content = ContentHelpers.makeHtmlMessage(body, htmlBody);
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlNotice = function(roomId, body, htmlBody, callback) {
    const content = ContentHelpers.makeHtmlNotice(body, htmlBody);
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlEmote = function(roomId, body, htmlBody, callback) {
    const content = ContentHelpers.makeHtmlEmote(body, htmlBody);
    return this.sendMessage(roomId, content, callback);
};

/**
 * Send a receipt.
 * @param {Event} event The event being acknowledged
 * @param {string} receiptType The kind of receipt e.g. "m.read"
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendReceipt = function(event, receiptType, callback) {
    if (this.isGuest()) {
        return Promise.resolve({}); // guests cannot send receipts so don't bother.
    }

    const path = utils.encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
        $roomId: event.getRoomId(),
        $receiptType: receiptType,
        $eventId: event.getId(),
    });
    const promise = this._http.authedRequest(
        callback, "POST", path, undefined, {},
    );

    const room = this.getRoom(event.getRoomId());
    if (room) {
        room._addLocalEchoReceipt(this.credentials.userId, event, receiptType);
    }
    return promise;
};

/**
 * Send a read receipt.
 * @param {Event} event The event that has been read.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendReadReceipt = function(event, callback) {
    return this.sendReceipt(event, "m.read", callback);
};

/**
 * Set a marker to indicate the point in a room before which the user has read every
 * event. This can be retrieved from room account data (the event type is `m.fully_read`)
 * and displayed as a horizontal line in the timeline that is visually distinct to the
 * position of the user's own read receipt.
 * @param {string} roomId ID of the room that has been read
 * @param {string} eventId ID of the event that has been read
 * @param {string} rrEvent the event tracked by the read receipt. This is here for
 * convenience because the RR and the RM are commonly updated at the same time as each
 * other. The local echo of this receipt will be done if set. Optional.
 * @return {module:client.Promise} Resolves: the empty object, {}.
 */
MatrixClient.prototype.setRoomReadMarkers = function(roomId, eventId, rrEvent) {
    const rmEventId = eventId;
    let rrEventId;

    // Add the optional RR update, do local echo like `sendReceipt`
    if (rrEvent) {
        rrEventId = rrEvent.getId();
        const room = this.getRoom(roomId);
        if (room) {
            room._addLocalEchoReceipt(this.credentials.userId, rrEvent, "m.read");
        }
    }

    return this.setRoomReadMarkersHttpRequest(roomId, rmEventId, rrEventId);
};

/**
 * Get a preview of the given URL as of (roughly) the given point in time,
 * described as an object with OpenGraph keys and associated values.
 * Attributes may be synthesized where actual OG metadata is lacking.
 * Caches results to prevent hammering the server.
 * @param {string} url The URL to get preview data for
 * @param {Number} ts The preferred point in time that the preview should
 * describe (ms since epoch).  The preview returned will either be the most
 * recent one preceding this timestamp if available, or failing that the next
 * most recent available preview.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Object of OG metadata.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * May return synthesized attributes if the URL lacked OG meta.
 */
MatrixClient.prototype.getUrlPreview = function(url, ts, callback) {
    const key = ts + "_" + url;
    const og = this.urlPreviewCache[key];
    if (og) {
        return Promise.resolve(og);
    }

    const self = this;
    return this._http.authedRequestWithPrefix(
        callback, "GET", "/preview_url", {
            url: url,
            ts: ts,
        }, undefined, httpApi.PREFIX_MEDIA_R0,
    ).then(function(response) {
        // TODO: expire cache occasionally
        self.urlPreviewCache[key] = response;
        return response;
    });
};

/**
 * @param {string} roomId
 * @param {boolean} isTyping
 * @param {Number} timeoutMs
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTyping = function(roomId, isTyping, timeoutMs, callback) {
    if (this.isGuest()) {
        return Promise.resolve({}); // guests cannot send typing notifications so don't bother.
    }

    const path = utils.encodeUri("/rooms/$roomId/typing/$userId", {
        $roomId: roomId,
        $userId: this.credentials.userId,
    });
    const data = {
        typing: isTyping,
    };
    if (isTyping) {
        data.timeout = timeoutMs ? timeoutMs : 20000;
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data,
    );
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.invite = function(roomId, userId, callback) {
    return _membershipChange(this, roomId, userId, "invite", undefined,
        callback);
};

/**
 * Invite a user to a room based on their email address.
 * @param {string} roomId The room to invite the user to.
 * @param {string} email The email address to invite.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.inviteByEmail = function(roomId, email, callback) {
    return this.inviteByThreePid(
        roomId, "email", email, callback,
    );
};

/**
 * Invite a user to a room based on a third-party identifier.
 * @param {string} roomId The room to invite the user to.
 * @param {string} medium The medium to invite the user e.g. "email".
 * @param {string} address The address for the specified medium.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.inviteByThreePid = function(roomId, medium, address, callback) {
    const path = utils.encodeUri(
        "/rooms/$roomId/invite",
        { $roomId: roomId },
    );

    const identityServerUrl = this.getIdentityServerUrl(true);
    if (!identityServerUrl) {
        return Promise.reject(new MatrixError({
            error: "No supplied identity server URL",
            errcode: "ORG.MATRIX.JSSDK_MISSING_PARAM",
        }));
    }

    return this._http.authedRequest(callback, "POST", path, undefined, {
        id_server: identityServerUrl,
        medium: medium,
        address: address,
    });
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.leave = function(roomId, callback) {
    return _membershipChange(this, roomId, undefined, "leave", undefined,
        callback);
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.ban = function(roomId, userId, reason, callback) {
    return _membershipChange(this, roomId, userId, "ban", reason,
        callback);
};

/**
 * @param {string} roomId
 * @param {boolean} deleteRoom True to delete the room from the store on success.
 * Default: true.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.forget = function(roomId, deleteRoom, callback) {
    if (deleteRoom === undefined) {
        deleteRoom = true;
    }
    const promise = _membershipChange(this, roomId, undefined, "forget", undefined,
        callback);
    if (!deleteRoom) {
        return promise;
    }
    const self = this;
    return promise.then(function(response) {
        self.store.removeRoom(roomId);
        self.emit("deleteRoom", roomId);
        return response;
    });
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Object (currently empty)
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.unban = function(roomId, userId, callback) {
    // unbanning != set their state to leave: this used to be
    // the case, but was then changed so that leaving was always
    // a revoking of priviledge, otherwise two people racing to
    // kick / ban someone could end up banning and then un-banning
    // them.
    const path = utils.encodeUri("/rooms/$roomId/unban", {
        $roomId: roomId,
    });
    const data = {
        user_id: userId,
    };
    return this._http.authedRequest(
        callback, "POST", path, undefined, data,
    );
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.kick = function(roomId, userId, reason, callback) {
    return _setMembershipState(
        this, roomId, userId, "leave", reason, callback,
    );
};

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membershipValue
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _setMembershipState(client, roomId, userId, membershipValue, reason,
                             callback) {
    if (utils.isFunction(reason)) {
        callback = reason; reason = undefined;
    }

    const path = utils.encodeUri(
        "/rooms/$roomId/state/m.room.member/$userId",
        { $roomId: roomId, $userId: userId},
    );

    return client._http.authedRequest(callback, "PUT", path, undefined, {
        membership: membershipValue,
        reason: reason,
    });
}

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membership
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _membershipChange(client, roomId, userId, membership, reason, callback) {
    if (utils.isFunction(reason)) {
        callback = reason; reason = undefined;
    }

    const path = utils.encodeUri("/rooms/$room_id/$membership", {
        $room_id: roomId,
        $membership: membership,
    });
    return client._http.authedRequest(
        callback, "POST", path, undefined, {
            user_id: userId,  // may be undefined e.g. on leave
            reason: reason,
        },
    );
}

/**
 * Obtain a dict of actions which should be performed for this event according
 * to the push rules for this user.  Caches the dict on the event.
 * @param {MatrixEvent} event The event to get push actions for.
 * @return {module:pushprocessor~PushAction} A dict of actions to perform.
 */
MatrixClient.prototype.getPushActionsForEvent = function(event) {
    if (!event.getPushActions()) {
        event.setPushActions(this._pushProcessor.actionsForEvent(event));
    }
    return event.getPushActions();
};

// Profile operations
// ==================

/**
 * @param {string} info The kind of info to set (e.g. 'avatar_url')
 * @param {Object} data The JSON object to set.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setProfileInfo = function(info, data, callback) {
    const path = utils.encodeUri("/profile/$userId/$info", {
        $userId: this.credentials.userId,
        $info: info,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data,
    );
};

/**
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setDisplayName = function(name, callback) {
    return this.setProfileInfo(
        "displayname", { displayname: name }, callback,
    );
};

/**
 * @param {string} url
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setAvatarUrl = function(url, callback) {
    return this.setProfileInfo(
        "avatar_url", { avatar_url: url }, callback,
    );
};

/**
 * Turn an MXC URL into an HTTP one. <strong>This method is experimental and
 * may change.</strong>
 * @param {string} mxcUrl The MXC URL
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
 * directly. Fetching such URLs will leak information about the user to
 * anyone they share a room with. If false, will return null for such URLs.
 * @return {?string} the avatar URL or null.
 */
MatrixClient.prototype.mxcUrlToHttp =
        function(mxcUrl, width, height, resizeMethod, allowDirectLinks) {
    return contentRepo.getHttpUriForMxc(
        this.baseUrl, mxcUrl, width, height, resizeMethod, allowDirectLinks,
    );
};

/**
 * Sets a new status message for the user. The message may be null/falsey
 * to clear the message.
 * @param {string} newMessage The new message to set.
 * @return {module:client.Promise} Resolves: to nothing
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype._unstable_setStatusMessage = function(newMessage) {
    return Promise.all(this.getRooms().map((room) => {
        const isJoined = room.getMyMembership() === "join";
        const looksLikeDm = room.getInvitedAndJoinedMemberCount() === 2;
        if (isJoined && looksLikeDm) {
            return this.sendStateEvent(room.roomId, "im.vector.user_status", {
                status: newMessage,
            }, this.getUserId());
        } else {
            return Promise.resolve();
        }
    }));
};

/**
 * @param {Object} opts Options to apply
 * @param {string} opts.presence One of "online", "offline" or "unavailable"
 * @param {string} opts.status_msg The status message to attach.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws If 'presence' isn't a valid presence enum value.
 */
MatrixClient.prototype.setPresence = function(opts, callback) {
    const path = utils.encodeUri("/presence/$userId/status", {
        $userId: this.credentials.userId,
    });

    if (typeof opts === "string") {
      opts = { presence: opts };
    }

    const validStates = ["offline", "online", "unavailable"];
    if (validStates.indexOf(opts.presence) == -1) {
        throw new Error("Bad presence value: " + opts.presence);
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, opts,
    );
};

function _presenceList(callback, client, opts, method) {
  const path = utils.encodeUri("/presence/list/$userId", {
      $userId: client.credentials.userId,
  });
  return client._http.authedRequest(callback, method, path, undefined, opts);
}

/**
* Retrieve current user presence list.
* @param {module:client.callback} callback Optional.
* @return {module:client.Promise} Resolves: TODO
* @return {module:http-api.MatrixError} Rejects: with an error response.
*/
MatrixClient.prototype.getPresenceList = function(callback) {
  return _presenceList(callback, this, undefined, "GET");
};

/**
* Add users to the current user presence list.
* @param {module:client.callback} callback Optional.
* @param {string[]} userIds
* @return {module:client.Promise} Resolves: TODO
* @return {module:http-api.MatrixError} Rejects: with an error response.
*/
MatrixClient.prototype.inviteToPresenceList = function(callback, userIds) {
  const opts = {"invite": userIds};
  return _presenceList(callback, this, opts, "POST");
};

/**
* Drop users from the current user presence list.
* @param {module:client.callback} callback Optional.
* @param {string[]} userIds
* @return {module:client.Promise} Resolves: TODO
* @return {module:http-api.MatrixError} Rejects: with an error response.
**/
MatrixClient.prototype.dropFromPresenceList = function(callback, userIds) {
  const opts = {"drop": userIds};
  return _presenceList(callback, this, opts, "POST");
};

/**
 * Retrieve older messages from the given room and put them in the timeline.
 *
 * If this is called multiple times whilst a request is ongoing, the <i>same</i>
 * Promise will be returned. If there was a problem requesting scrollback, there
 * will be a small delay before another request can be made (to prevent tight-looping
 * when there is no connection).
 *
 * @param {Room} room The room to get older messages in.
 * @param {Integer} limit Optional. The maximum number of previous events to
 * pull in. Default: 30.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Room. If you are at the beginning
 * of the timeline, <code>Room.oldState.paginationToken</code> will be
 * <code>null</code>.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.scrollback = function(room, limit, callback) {
    if (utils.isFunction(limit)) {
        callback = limit; limit = undefined;
    }
    limit = limit || 30;
    let timeToWaitMs = 0;

    let info = this._ongoingScrollbacks[room.roomId] || {};
    if (info.promise) {
        return info.promise;
    } else if (info.errorTs) {
        const timeWaitedMs = Date.now() - info.errorTs;
        timeToWaitMs = Math.max(SCROLLBACK_DELAY_MS - timeWaitedMs, 0);
    }

    if (room.oldState.paginationToken === null) {
        return Promise.resolve(room); // already at the start.
    }
    // attempt to grab more events from the store first
    const numAdded = this.store.scrollback(room, limit).length;
    if (numAdded === limit) {
        // store contained everything we needed.
        return Promise.resolve(room);
    }
    // reduce the required number of events appropriately
    limit = limit - numAdded;

    const defer = Promise.defer();
    info = {
        promise: defer.promise,
        errorTs: null,
    };
    const self = this;
    // wait for a time before doing this request
    // (which may be 0 in order not to special case the code paths)
    Promise.delay(timeToWaitMs).then(function() {
        return self._createMessagesRequest(
            room.roomId,
            room.oldState.paginationToken,
            limit,
            'b');
    }).done(function(res) {
        const matrixEvents = utils.map(res.chunk, _PojoToMatrixEventMapper(self));
        if (res.state) {
            const stateEvents = utils.map(res.state, _PojoToMatrixEventMapper(self));
            room.currentState.setUnknownStateEvents(stateEvents);
        }
        room.addEventsToTimeline(matrixEvents, true, room.getLiveTimeline());
        room.oldState.paginationToken = res.end;
        if (res.chunk.length === 0) {
            room.oldState.paginationToken = null;
        }
        self.store.storeEvents(room, matrixEvents, res.end, true);
        self._ongoingScrollbacks[room.roomId] = null;
        _resolve(callback, defer, room);
    }, function(err) {
        self._ongoingScrollbacks[room.roomId] = {
            errorTs: Date.now(),
        };
        _reject(callback, defer, err);
    });
    this._ongoingScrollbacks[room.roomId] = info;
    return defer.promise;
};

/**
 * Get an EventTimeline for the given event
 *
 * <p>If the EventTimelineSet object already has the given event in its store, the
 * corresponding timeline will be returned. Otherwise, a /context request is
 * made, and used to construct an EventTimeline.
 *
 * @param {EventTimelineSet} timelineSet  The timelineSet to look for the event in
 * @param {string} eventId  The ID of the event to look for
 *
 * @return {module:client.Promise} Resolves:
 *    {@link module:models/event-timeline~EventTimeline} including the given
 *    event
 */
MatrixClient.prototype.getEventTimeline = function(timelineSet, eventId) {
    // don't allow any timeline support unless it's been enabled.
    if (!this.timelineSupport) {
        throw new Error("timeline support is disabled. Set the 'timelineSupport'" +
                    " parameter to true when creating MatrixClient to enable" +
                    " it.");
    }

    if (timelineSet.getTimelineForEvent(eventId)) {
        return Promise.resolve(timelineSet.getTimelineForEvent(eventId));
    }

    const path = utils.encodeUri(
        "/rooms/$roomId/context/$eventId", {
            $roomId: timelineSet.room.roomId,
            $eventId: eventId,
        },
    );

    let params = undefined;
    if (this._clientOpts.lazyLoadMembers) {
        params = {filter: JSON.stringify(Filter.LAZY_LOADING_MESSAGES_FILTER)};
    }

    // TODO: we should implement a backoff (as per scrollback()) to deal more
    // nicely with HTTP errors.
    const self = this;
    const promise =
        self._http.authedRequest(undefined, "GET", path, params,
    ).then(function(res) {
        if (!res.event) {
            throw new Error("'event' not in '/context' result - homeserver too old?");
        }

        // by the time the request completes, the event might have ended up in
        // the timeline.
        if (timelineSet.getTimelineForEvent(eventId)) {
            return timelineSet.getTimelineForEvent(eventId);
        }

        // we start with the last event, since that's the point at which we
        // have known state.
        // events_after is already backwards; events_before is forwards.
        res.events_after.reverse();
        const events = res.events_after
            .concat([res.event])
            .concat(res.events_before);
        const matrixEvents = utils.map(events, self.getEventMapper());

        let timeline = timelineSet.getTimelineForEvent(matrixEvents[0].getId());
        if (!timeline) {
            timeline = timelineSet.addTimeline();
            timeline.initialiseState(utils.map(res.state,
                                               self.getEventMapper()));
            timeline.getState(EventTimeline.FORWARDS).paginationToken = res.end;
        } else {
            const stateEvents = utils.map(res.state, self.getEventMapper());
            timeline.getState(EventTimeline.BACKWARDS).setUnknownStateEvents(stateEvents);
        }
        timelineSet.addEventsToTimeline(matrixEvents, true, timeline, res.start);

        // there is no guarantee that the event ended up in "timeline" (we
        // might have switched to a neighbouring timeline) - so check the
        // room's index again. On the other hand, there's no guarantee the
        // event ended up anywhere, if it was later redacted, so we just
        // return the timeline we first thought of.
        const tl = timelineSet.getTimelineForEvent(eventId) || timeline;
        return tl;
    });
    return promise;
};

/**
 * Makes a request to /messages with the appropriate lazy loading filter set.
 * XXX: if we do get rid of scrollback (as it's not used at the moment),
 * we could inline this method again in paginateEventTimeline as that would
 * then be the only call-site
 * @param {string} roomId
 * @param {string} fromToken
 * @param {number} limit the maximum amount of events the retrieve
 * @param {string} dir 'f' or 'b'
 * @param {Filter} timelineFilter the timeline filter to pass
 * @return {Promise}
 */
MatrixClient.prototype._createMessagesRequest =
function(roomId, fromToken, limit, dir, timelineFilter = undefined) {
    const path = utils.encodeUri(
        "/rooms/$roomId/messages", {$roomId: roomId},
    );
    if (limit === undefined) {
        limit = 30;
    }
    const params = {
        from: fromToken,
        limit: limit,
        dir: dir,
    };

    let filter = null;
    if (this._clientOpts.lazyLoadMembers) {
        // create a shallow copy of LAZY_LOADING_MESSAGES_FILTER,
        // so the timelineFilter doesn't get written into it below
        filter = Object.assign({}, Filter.LAZY_LOADING_MESSAGES_FILTER);
    }
    if (timelineFilter) {
        // XXX: it's horrific that /messages' filter parameter doesn't match
        // /sync's one - see https://matrix.org/jira/browse/SPEC-451
        filter = filter || {};
        Object.assign(filter, timelineFilter.getRoomTimelineFilterComponent());
    }
    if (filter) {
        params.filter = JSON.stringify(filter);
    }
    return this._http.authedRequest(undefined, "GET", path, params);
};

/**
 * Take an EventTimeline, and back/forward-fill results.
 *
 * @param {module:models/event-timeline~EventTimeline} eventTimeline timeline
 *    object to be updated
 * @param {Object}   [opts]
 * @param {bool}     [opts.backwards = false]  true to fill backwards,
 *    false to go forwards
 * @param {number}   [opts.limit = 30]         number of events to request
 *
 * @return {module:client.Promise} Resolves to a boolean: false if there are no
 *    events and we reached either end of the timeline; else true.
 */
MatrixClient.prototype.paginateEventTimeline = function(eventTimeline, opts) {
    const isNotifTimeline = (eventTimeline.getTimelineSet() === this._notifTimelineSet);

    // TODO: we should implement a backoff (as per scrollback()) to deal more
    // nicely with HTTP errors.
    opts = opts || {};
    const backwards = opts.backwards || false;

    if (isNotifTimeline) {
        if (!backwards) {
            throw new Error("paginateNotifTimeline can only paginate backwards");
        }
    }

    const dir = backwards ? EventTimeline.BACKWARDS : EventTimeline.FORWARDS;

    const token = eventTimeline.getPaginationToken(dir);
    if (!token) {
        // no token - no results.
        return Promise.resolve(false);
    }

    const pendingRequest = eventTimeline._paginationRequests[dir];

    if (pendingRequest) {
        // already a request in progress - return the existing promise
        return pendingRequest;
    }

    let path, params, promise;
    const self = this;

    if (isNotifTimeline) {
        path = "/notifications";
        params = {
            limit: ('limit' in opts) ? opts.limit : 30,
            only: 'highlight',
        };

        if (token && token !== "end") {
            params.from = token;
        }

        promise =
            this._http.authedRequestWithPrefix(undefined, "GET", path, params,
                undefined, httpApi.PREFIX_UNSTABLE,
        ).then(function(res) {
            const token = res.next_token;
            const matrixEvents = [];

            for (let i = 0; i < res.notifications.length; i++) {
                const notification = res.notifications[i];
                const event = self.getEventMapper()(notification.event);
                event.setPushActions(
                    PushProcessor.actionListToActionsObject(notification.actions),
                );
                event.event.room_id = notification.room_id; // XXX: gutwrenching
                matrixEvents[i] = event;
            }

            eventTimeline.getTimelineSet()
                .addEventsToTimeline(matrixEvents, backwards, eventTimeline, token);

            // if we've hit the end of the timeline, we need to stop trying to
            // paginate. We need to keep the 'forwards' token though, to make sure
            // we can recover from gappy syncs.
            if (backwards && !res.next_token) {
                eventTimeline.setPaginationToken(null, dir);
            }
            return res.next_token ? true : false;
        }).finally(function() {
            eventTimeline._paginationRequests[dir] = null;
        });
        eventTimeline._paginationRequests[dir] = promise;
    } else {
        const room = this.getRoom(eventTimeline.getRoomId());
        if (!room) {
            throw new Error("Unknown room " + eventTimeline.getRoomId());
        }

        promise = this._createMessagesRequest(
            eventTimeline.getRoomId(),
            token,
            opts.limit,
            dir,
            eventTimeline.getFilter());
        promise.then(function(res) {
            if (res.state) {
                const roomState = eventTimeline.getState(dir);
                const stateEvents = utils.map(res.state, self.getEventMapper());
                roomState.setUnknownStateEvents(stateEvents);
            }
            const token = res.end;
            const matrixEvents = utils.map(res.chunk, self.getEventMapper());
            eventTimeline.getTimelineSet()
                .addEventsToTimeline(matrixEvents, backwards, eventTimeline, token);

            // if we've hit the end of the timeline, we need to stop trying to
            // paginate. We need to keep the 'forwards' token though, to make sure
            // we can recover from gappy syncs.
            if (backwards && res.end == res.start) {
                eventTimeline.setPaginationToken(null, dir);
            }
            return res.end != res.start;
        }).finally(function() {
            eventTimeline._paginationRequests[dir] = null;
        });
        eventTimeline._paginationRequests[dir] = promise;
    }

    return promise;
};

/**
 * Reset the notifTimelineSet entirely, paginating in some historical notifs as
 * a starting point for subsequent pagination.
 */
MatrixClient.prototype.resetNotifTimelineSet = function() {
    if (!this._notifTimelineSet) {
        return;
    }

    // FIXME: This thing is a total hack, and results in duplicate events being
    // added to the timeline both from /sync and /notifications, and lots of
    // slow and wasteful processing and pagination.  The correct solution is to
    // extend /messages or /search or something to filter on notifications.

    // use the fictitious token 'end'. in practice we would ideally give it
    // the oldest backwards pagination token from /sync, but /sync doesn't
    // know about /notifications, so we have no choice but to start paginating
    // from the current point in time.  This may well overlap with historical
    // notifs which are then inserted into the timeline by /sync responses.
    this._notifTimelineSet.resetLiveTimeline('end', null);

    // we could try to paginate a single event at this point in order to get
    // a more valid pagination token, but it just ends up with an out of order
    // timeline. given what a mess this is and given we're going to have duplicate
    // events anyway, just leave it with the dummy token for now.
    /*
    this.paginateNotifTimeline(this._notifTimelineSet.getLiveTimeline(), {
        backwards: true,
        limit: 1
    });
    */
};

/**
 * Peek into a room and receive updates about the room. This only works if the
 * history visibility for the room is world_readable.
 * @param {String} roomId The room to attempt to peek into.
 * @return {module:client.Promise} Resolves: Room object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.peekInRoom = function(roomId) {
    if (this._peekSync) {
        this._peekSync.stopPeeking();
    }
    this._peekSync = new SyncApi(this, this._clientOpts);
    return this._peekSync.peek(roomId);
};

/**
 * Stop any ongoing room peeking.
 */
MatrixClient.prototype.stopPeeking = function() {
    if (this._peekSync) {
        this._peekSync.stopPeeking();
        this._peekSync = null;
    }
};

/**
 * Set r/w flags for guest access in a room.
 * @param {string} roomId The room to configure guest access in.
 * @param {Object} opts Options
 * @param {boolean} opts.allowJoin True to allow guests to join this room. This
 * implicitly gives guests write access. If false or not given, guests are
 * explicitly forbidden from joining the room.
 * @param {boolean} opts.allowRead True to set history visibility to
 * be world_readable. This gives guests read access *from this point forward*.
 * If false or not given, history visibility is not modified.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setGuestAccess = function(roomId, opts) {
    const writePromise = this.sendStateEvent(roomId, "m.room.guest_access", {
        guest_access: opts.allowJoin ? "can_join" : "forbidden",
    });

    let readPromise = Promise.resolve();
    if (opts.allowRead) {
        readPromise = this.sendStateEvent(roomId, "m.room.history_visibility", {
            history_visibility: "world_readable",
        });
    }

    return Promise.all([readPromise, writePromise]);
};

// Registration/Login operations
// =============================

/**
 * Requests an email verification token for the purposes of registration.
 * This API proxies the Identity Server /validate/email/requestToken API,
 * adding registration-specific behaviour. Specifically, if an account with
 * the given email address already exists, it will either send an email
 * to the address informing them of this or return M_THREEPID_IN_USE
 * (which one is up to the Home Server).
 *
 * requestEmailToken calls the equivalent API directly on the ID server,
 * therefore bypassing the registration-specific logic.
 *
 * Parameters and return value are as for requestEmailToken

 * @param {string} email As requestEmailToken
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestRegisterEmailToken = function(email, clientSecret,
                                                    sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/register/email/requestToken",
        {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Requests a text message verification token for the purposes of registration.
 * This API proxies the Identity Server /validate/msisdn/requestToken API,
 * adding registration-specific behaviour, as with requestRegisterEmailToken.
 *
 * @param {string} phoneCountry The ISO 3166-1 alpha-2 code for the country in which
 *    phoneNumber should be parsed relative to.
 * @param {string} phoneNumber The phone number, in national or international format
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestRegisterMsisdnToken = function(phoneCountry, phoneNumber,
                                                    clientSecret, sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/register/msisdn/requestToken",
        {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Requests an email verification token for the purposes of adding a
 * third party identifier to an account.
 * This API proxies the Identity Server /validate/email/requestToken API,
 * adding specific behaviour for the addition of email addresses to an
 * account. Specifically, if an account with
 * the given email address already exists, it will either send an email
 * to the address informing them of this or return M_THREEPID_IN_USE
 * (which one is up to the Home Server).
 *
 * requestEmailToken calls the equivalent API directly on the ID server,
 * therefore bypassing the email addition specific logic.
 *
 * @param {string} email As requestEmailToken
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestAdd3pidEmailToken = function(email, clientSecret,
                                                    sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/account/3pid/email/requestToken",
        {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Requests a text message verification token for the purposes of adding a
 * third party identifier to an account.
 * This API proxies the Identity Server /validate/email/requestToken API,
 * adding specific behaviour for the addition of phone numbers to an
 * account, as requestAdd3pidEmailToken.
 *
 * @param {string} phoneCountry As requestRegisterMsisdnToken
 * @param {string} phoneNumber As requestRegisterMsisdnToken
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestAdd3pidMsisdnToken = function(phoneCountry, phoneNumber,
                                                    clientSecret, sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/account/3pid/msisdn/requestToken",
        {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Requests an email verification token for the purposes of resetting
 * the password on an account.
 * This API proxies the Identity Server /validate/email/requestToken API,
 * adding specific behaviour for the password resetting. Specifically,
 * if no account with the given email address exists, it may either
 * return M_THREEPID_NOT_FOUND or send an email
 * to the address informing them of this (which one is up to the Home Server).
 *
 * requestEmailToken calls the equivalent API directly on the ID server,
 * therefore bypassing the password reset specific logic.
 *
 * @param {string} email As requestEmailToken
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @param {module:client.callback} callback Optional. As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestPasswordEmailToken = function(email, clientSecret,
                                                    sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/account/password/email/requestToken",
        {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Requests a text message verification token for the purposes of resetting
 * the password on an account.
 * This API proxies the Identity Server /validate/email/requestToken API,
 * adding specific behaviour for the password resetting, as requestPasswordEmailToken.
 *
 * @param {string} phoneCountry As requestRegisterMsisdnToken
 * @param {string} phoneNumber As requestRegisterMsisdnToken
 * @param {string} clientSecret As requestEmailToken
 * @param {number} sendAttempt As requestEmailToken
 * @param {string} nextLink As requestEmailToken
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype.requestPasswordMsisdnToken = function(phoneCountry, phoneNumber,
                                                    clientSecret, sendAttempt, nextLink) {
    return this._requestTokenFromEndpoint(
        "/account/password/msisdn/requestToken",
        {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        },
    );
};

/**
 * Internal utility function for requesting validation tokens from usage-specific
 * requestToken endpoints.
 *
 * @param {string} endpoint The endpoint to send the request to
 * @param {object} params Parameters for the POST request
 * @return {module:client.Promise} Resolves: As requestEmailToken
 */
MatrixClient.prototype._requestTokenFromEndpoint = function(endpoint, params) {
    const id_server_url = url.parse(this.idBaseUrl);
    if (id_server_url.host === null) {
        throw new Error("Invalid ID server URL: " + this.idBaseUrl);
    }

    const postParams = Object.assign({}, params, {
        id_server: id_server_url.host,
    });
    return this._http.request(
        undefined, "POST", endpoint, undefined,
        postParams,
    );
};


// Push operations
// ===============

/**
 * Get the room-kind push rule associated with a room.
 * @param {string} scope "global" or device-specific.
 * @param {string} roomId the id of the room.
 * @return {object} the rule or undefined.
 */
MatrixClient.prototype.getRoomPushRule = function(scope, roomId) {
    // There can be only room-kind push rule per room
    // and its id is the room id.
    if (this.pushRules) {
        for (let i = 0; i < this.pushRules[scope].room.length; i++) {
            const rule = this.pushRules[scope].room[i];
            if (rule.rule_id === roomId) {
                return rule;
            }
        }
    } else {
        throw new Error(
            "SyncApi.sync() must be done before accessing to push rules.",
        );
    }
};

/**
 * Set a room-kind muting push rule in a room.
 * The operation also updates MatrixClient.pushRules at the end.
 * @param {string} scope "global" or device-specific.
 * @param {string} roomId the id of the room.
 * @param {string} mute the mute state.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomMutePushRule = function(scope, roomId, mute) {
    const self = this;
    let deferred, hasDontNotifyRule;

    // Get the existing room-kind push rule if any
    const roomPushRule = this.getRoomPushRule(scope, roomId);
    if (roomPushRule) {
        if (0 <= roomPushRule.actions.indexOf("dont_notify")) {
            hasDontNotifyRule = true;
        }
    }

    if (!mute) {
        // Remove the rule only if it is a muting rule
        if (hasDontNotifyRule) {
            deferred = this.deletePushRule(scope, "room", roomPushRule.rule_id);
        }
    } else {
        if (!roomPushRule) {
            deferred = this.addPushRule(scope, "room", roomId, {
                actions: ["dont_notify"],
            });
        } else if (!hasDontNotifyRule) {
            // Remove the existing one before setting the mute push rule
            // This is a workaround to SYN-590 (Push rule update fails)
            deferred = Promise.defer();
            this.deletePushRule(scope, "room", roomPushRule.rule_id)
            .done(function() {
                self.addPushRule(scope, "room", roomId, {
                    actions: ["dont_notify"],
                }).done(function() {
                    deferred.resolve();
                }, function(err) {
                    deferred.reject(err);
                });
            }, function(err) {
                deferred.reject(err);
            });

            deferred = deferred.promise;
        }
    }

    if (deferred) {
        // Update this.pushRules when the operation completes
        const ruleRefreshDeferred = Promise.defer();
        deferred.done(function() {
            self.getPushRules().done(function(result) {
                self.pushRules = result;
                ruleRefreshDeferred.resolve();
            }, function(err) {
                ruleRefreshDeferred.reject(err);
            });
        }, function(err) {
            // Update it even if the previous operation fails. This can help the
            // app to recover when push settings has been modifed from another client
            self.getPushRules().done(function(result) {
                self.pushRules = result;
                ruleRefreshDeferred.reject(err);
            }, function(err2) {
                ruleRefreshDeferred.reject(err);
            });
        });
        return ruleRefreshDeferred.promise;
    }
};

// Search
// ======

/**
 * Perform a server-side search for messages containing the given text.
 * @param {Object} opts Options for the search.
 * @param {string} opts.query The text to query.
 * @param {string=} opts.keys The keys to search on. Defaults to all keys. One
 * of "content.body", "content.name", "content.topic".
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.searchMessageText = function(opts, callback) {
    const roomEvents = {
        search_term: opts.query,
    };

    if ('keys' in opts) {
        roomEvents.keys = opts.keys;
    }

    return this.search({
        body: {
            search_categories: {
                room_events: roomEvents,
            },
        },
    }, callback);
};

/**
 * Perform a server-side search for room events.
 *
 * The returned promise resolves to an object containing the fields:
 *
 *  * {number}  count:       estimate of the number of results
 *  * {string}  next_batch:  token for back-pagination; if undefined, there are
 *                           no more results
 *  * {Array}   highlights:  a list of words to highlight from the stemming
 *                           algorithm
 *  * {Array}   results:     a list of results
 *
 * Each entry in the results list is a {module:models/search-result.SearchResult}.
 *
 * @param {Object} opts
 * @param {string} opts.term     the term to search for
 * @param {Object} opts.filter   a JSON filter object to pass in the request
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.searchRoomEvents = function(opts) {
    // TODO: support groups

    const body = {
        search_categories: {
            room_events: {
                search_term: opts.term,
                filter: opts.filter,
                order_by: "recent",
                event_context: {
                    before_limit: 1,
                    after_limit: 1,
                    include_profile: true,
                },
            },
        },
    };

    const searchResults = {
        _query: body,
        results: [],
        highlights: [],
    };

    return this.search({body: body}).then(
        this._processRoomEventsSearch.bind(this, searchResults),
    );
};

/**
 * Take a result from an earlier searchRoomEvents call, and backfill results.
 *
 * @param  {object} searchResults  the results object to be updated
 * @return {module:client.Promise} Resolves: updated result object
 * @return {Error} Rejects: with an error response.
 */
MatrixClient.prototype.backPaginateRoomEventsSearch = function(searchResults) {
    // TODO: we should implement a backoff (as per scrollback()) to deal more
    // nicely with HTTP errors.

    if (!searchResults.next_batch) {
        return Promise.reject(new Error("Cannot backpaginate event search any further"));
    }

    if (searchResults.pendingRequest) {
        // already a request in progress - return the existing promise
        return searchResults.pendingRequest;
    }

    const searchOpts = {
        body: searchResults._query,
        next_batch: searchResults.next_batch,
    };

    const promise = this.search(searchOpts).then(
        this._processRoomEventsSearch.bind(this, searchResults),
    ).finally(function() {
        searchResults.pendingRequest = null;
    });
    searchResults.pendingRequest = promise;

    return promise;
};

/**
 * helper for searchRoomEvents and backPaginateRoomEventsSearch. Processes the
 * response from the API call and updates the searchResults
 *
 * @param {Object} searchResults
 * @param {Object} response
 * @return {Object} searchResults
 * @private
 */
MatrixClient.prototype._processRoomEventsSearch = function(searchResults, response) {
    const room_events = response.search_categories.room_events;

    searchResults.count = room_events.count;
    searchResults.next_batch = room_events.next_batch;

    // combine the highlight list with our existing list; build an object
    // to avoid O(N^2) fail
    const highlights = {};
    room_events.highlights.forEach(function(hl) {
        highlights[hl] = 1;
    });
    searchResults.highlights.forEach(function(hl) {
        highlights[hl] = 1;
    });

    // turn it back into a list.
    searchResults.highlights = Object.keys(highlights);

    // append the new results to our existing results
    for (let i = 0; i < room_events.results.length; i++) {
        const sr = SearchResult.fromJson(room_events.results[i], this.getEventMapper());
        searchResults.results.push(sr);
    }
    return searchResults;
};


/**
 * Populate the store with rooms the user has left.
 * @return {module:client.Promise} Resolves: TODO - Resolved when the rooms have
 * been added to the data store.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.syncLeftRooms = function() {
    // Guard against multiple calls whilst ongoing and multiple calls post success
    if (this._syncedLeftRooms) {
        return Promise.resolve([]); // don't call syncRooms again if it succeeded.
    }
    if (this._syncLeftRoomsPromise) {
        return this._syncLeftRoomsPromise; // return the ongoing request
    }
    const self = this;
    const syncApi = new SyncApi(this, this._clientOpts);
    this._syncLeftRoomsPromise = syncApi.syncLeftRooms();

    // cleanup locks
    this._syncLeftRoomsPromise.then(function(res) {
        console.log("Marking success of sync left room request");
        self._syncedLeftRooms = true; // flip the bit on success
    }).finally(function() {
        self._syncLeftRoomsPromise = null; // cleanup ongoing request state
    });

    return this._syncLeftRoomsPromise;
};

// Filters
// =======

/**
 * Create a new filter.
 * @param {Object} content The HTTP body for the request
 * @return {Filter} Resolves to a Filter object.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.createFilter = function(content) {
    const self = this;
    const path = utils.encodeUri("/user/$userId/filter", {
        $userId: this.credentials.userId,
    });
    return this._http.authedRequest(
        undefined, "POST", path, undefined, content,
    ).then(function(response) {
        // persist the filter
        const filter = Filter.fromJson(
            self.credentials.userId, response.filter_id, content,
        );
        self.store.storeFilter(filter);
        return filter;
    });
};

/**
 * Retrieve a filter.
 * @param {string} userId The user ID of the filter owner
 * @param {string} filterId The filter ID to retrieve
 * @param {boolean} allowCached True to allow cached filters to be returned.
 * Default: True.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getFilter = function(userId, filterId, allowCached) {
    if (allowCached) {
        const filter = this.store.getFilter(userId, filterId);
        if (filter) {
            return Promise.resolve(filter);
        }
    }

    const self = this;
    const path = utils.encodeUri("/user/$userId/filter/$filterId", {
        $userId: userId,
        $filterId: filterId,
    });

    return this._http.authedRequest(
        undefined, "GET", path, undefined, undefined,
    ).then(function(response) {
        // persist the filter
        const filter = Filter.fromJson(
            userId, filterId, response,
        );
        self.store.storeFilter(filter);
        return filter;
    });
};

/**
 * @param {string} filterName
 * @param {Filter} filter
 * @return {Promise<String>} Filter ID
 */
MatrixClient.prototype.getOrCreateFilter = function(filterName, filter) {
    const filterId = this.store.getFilterIdByName(filterName);
    let promise = Promise.resolve();
    const self = this;

    if (filterId) {
        // check that the existing filter matches our expectations
        promise = self.getFilter(self.credentials.userId,
                         filterId, true,
        ).then(function(existingFilter) {
            const oldDef = existingFilter.getDefinition();
            const newDef = filter.getDefinition();

            if (utils.deepCompare(oldDef, newDef)) {
                // super, just use that.
                // debuglog("Using existing filter ID %s: %s", filterId,
                //          JSON.stringify(oldDef));
                return Promise.resolve(filterId);
            }
            // debuglog("Existing filter ID %s: %s; new filter: %s",
            //          filterId, JSON.stringify(oldDef), JSON.stringify(newDef));
            self.store.setFilterIdByName(filterName, undefined);
            return undefined;
        }, function(error) {
            // Synapse currently returns the following when the filter cannot be found:
            // {
            //     errcode: "M_UNKNOWN",
            //     name: "M_UNKNOWN",
            //     message: "No row found",
            //     data: Object, httpStatus: 404
            // }
            if (error.httpStatus === 404 &&
                (error.errcode === "M_UNKNOWN" || error.errcode === "M_NOT_FOUND")) {
                // Clear existing filterId from localStorage
                // if it no longer exists on the server
                self.store.setFilterIdByName(filterName, undefined);
                // Return a undefined value for existingId further down the promise chain
                return undefined;
            } else {
                throw error;
            }
        });
    }

    return promise.then(function(existingId) {
        if (existingId) {
            return existingId;
        }

        // create a new filter
        return self.createFilter(filter.getDefinition(),
        ).then(function(createdFilter) {
            // debuglog("Created new filter ID %s: %s", createdFilter.filterId,
            //          JSON.stringify(createdFilter.getDefinition()));
            self.store.setFilterIdByName(filterName, createdFilter.filterId);
            return createdFilter.filterId;
        });
    });
};


/**
 * Gets a bearer token from the Home Server that the user can
 * present to a third party in order to prove their ownership
 * of the Matrix account they are logged into.
 * @return {module:client.Promise} Resolves: Token object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getOpenIdToken = function() {
    const path = utils.encodeUri("/user/$userId/openid/request_token", {
        $userId: this.credentials.userId,
    });

    return this._http.authedRequest(
        undefined, "POST", path, undefined, {},
    );
};


// VoIP operations
// ===============

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.turnServer = function(callback) {
    return this._http.authedRequest(callback, "GET", "/voip/turnServer");
};

/**
 * Get the TURN servers for this home server.
 * @return {Array<Object>} The servers or an empty list.
 */
MatrixClient.prototype.getTurnServers = function() {
    return this._turnServers || [];
};

// Higher level APIs
// =================

// TODO: stuff to handle:
//   local echo
//   event dup suppression? - apparently we should still be doing this
//   tracking current display name / avatar per-message
//   pagination
//   re-sending (including persisting pending messages to be sent)
//   - Need a nice way to callback the app for arbitrary events like
//     displayname changes
//   due to ambiguity (or should this be on a chat-specific layer)?
//   reconnect after connectivity outages


/**
 * High level helper method to begin syncing and poll for new events. To listen for these
 * events, add a listener for {@link module:client~MatrixClient#event:"event"}
 * via {@link module:client~MatrixClient#on}. Alternatively, listen for specific
 * state change events.
 * @param {Object=} opts Options to apply when syncing.
 * @param {Number=} opts.initialSyncLimit The event <code>limit=</code> to apply
 * to initial sync. Default: 8.
 * @param {Boolean=} opts.includeArchivedRooms True to put <code>archived=true</code>
 * on the <code>/initialSync</code> request. Default: false.
 * @param {Boolean=} opts.resolveInvitesToProfiles True to do /profile requests
 * on every invite event if the displayname/avatar_url is not known for this user ID.
 * Default: false.
 *
 * @param {String=} opts.pendingEventOrdering Controls where pending messages
 * appear in a room's timeline. If "<b>chronological</b>", messages will appear
 * in the timeline when the call to <code>sendEvent</code> was made. If
 * "<b>detached</b>", pending messages will appear in a separate list,
 * accessbile via {@link module:models/room#getPendingEvents}. Default:
 * "chronological".
 *
 * @param {Number=} opts.pollTimeout The number of milliseconds to wait on /sync.
 * Default: 30000 (30 seconds).
 *
 * @param {Filter=} opts.filter The filter to apply to /sync calls. This will override
 * the opts.initialSyncLimit, which would normally result in a timeline limit filter.
 *
 * @param {Boolean=} opts.disablePresence True to perform syncing without automatically
 * updating presence.
 * @param {Boolean=} opts.lazyLoadMembers True to not load all membership events during
 * initial sync but fetch them when needed by calling `loadOutOfBandMembers`
 * This will override the filter option at this moment.
 */
MatrixClient.prototype.startClient = async function(opts) {
    if (this.clientRunning) {
        // client is already running.
        return;
    }
    this.clientRunning = true;
    // backwards compat for when 'opts' was 'historyLen'.
    if (typeof opts === "number") {
        opts = {
            initialSyncLimit: opts,
        };
    }

    if (this._crypto) {
        this._crypto.uploadDeviceKeys().done();
        this._crypto.start();
    }

    // periodically poll for turn servers if we support voip
    checkTurnServers(this);

    if (this._syncApi) {
        // This shouldn't happen since we thought the client was not running
        console.error("Still have sync object whilst not running: stopping old one");
        this._syncApi.stop();
    }

    // shallow-copy the opts dict before modifying and storing it
    opts = Object.assign({}, opts);

    opts.crypto = this._crypto;
    opts.canResetEntireTimeline = (roomId) => {
        if (!this._canResetTimelineCallback) {
            return false;
        }
        return this._canResetTimelineCallback(roomId);
    };
    this._clientOpts = opts;
    this._syncApi = new SyncApi(this, opts);
    this._syncApi.sync();
};

/**
 * store client options with boolean/string/numeric values
 * to know in the next session what flags the sync data was
 * created with (e.g. lazy loading)
 * @param {object} opts the complete set of client options
 * @return {Promise} for store operation */
MatrixClient.prototype._storeClientOptions = function() {
    const primTypes = ["boolean", "string", "number"];
    const serializableOpts = Object.entries(this._clientOpts)
        .filter(([key, value]) => {
            return primTypes.includes(typeof value);
        })
        .reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {});
    return this.store.storeClientOptions(serializableOpts);
};

/**
 * High level helper method to stop the client from polling and allow a
 * clean shutdown.
 */
MatrixClient.prototype.stopClient = function() {
    console.log('stopping MatrixClient');

    this.clientRunning = false;
    // TODO: f.e. Room => self.store.storeRoom(room) ?
    if (this._syncApi) {
        this._syncApi.stop();
        this._syncApi = null;
    }
    if (this._crypto) {
        this._crypto.stop();
    }
    if (this._peekSync) {
        this._peekSync.stopPeeking();
    }
    global.clearTimeout(this._checkTurnServersTimeoutID);
};

/*
 * Query the server to see if it support members lazy loading
 * @return {Promise<boolean>} true if server supports lazy loading
 */
MatrixClient.prototype.doesServerSupportLazyLoading = async function() {
    if (this._serverSupportsLazyLoading === null) {
        const response = await this._http.request(
            undefined, // callback
            "GET", "/_matrix/client/versions",
            undefined, // queryParams
            undefined, // data
            {
                prefix: '',
            },
        );
        const unstableFeatures = response["unstable_features"];
        this._serverSupportsLazyLoading =
            unstableFeatures && unstableFeatures["m.lazy_load_members"];
    }
    return this._serverSupportsLazyLoading;
};

/*
 * Get if lazy loading members is being used.
 * @return {boolean} Whether or not members are lazy loaded by this client
 */
MatrixClient.prototype.hasLazyLoadMembersEnabled = function() {
    return !!this._clientOpts.lazyLoadMembers;
};

/*
 * Set a function which is called when /sync returns a 'limited' response.
 * It is called with a room ID and returns a boolean. It should return 'true' if the SDK
 * can SAFELY remove events from this room. It may not be safe to remove events if there
 * are other references to the timelines for this room, e.g because the client is
 * actively viewing events in this room.
 * Default: returns false.
 * @param {Function} cb The callback which will be invoked.
 */
MatrixClient.prototype.setCanResetTimelineCallback = function(cb) {
    this._canResetTimelineCallback = cb;
};

/**
 * Get the callback set via `setCanResetTimelineCallback`.
 * @return {?Function} The callback or null
 */
MatrixClient.prototype.getCanResetTimelineCallback = function() {
    return this._canResetTimelineCallback;
};

function setupCallEventHandler(client) {
    const candidatesByCall = {
        // callId: [Candidate]
    };

    // Maintain a buffer of events before the client has synced for the first time.
    // This buffer will be inspected to see if we should send incoming call
    // notifications. It needs to be buffered to correctly determine if an
    // incoming call has had a matching answer/hangup.
    let callEventBuffer = [];
    let isClientPrepared = false;
    client.on("sync", function(state) {
        if (state === "PREPARED") {
            isClientPrepared = true;
            const ignoreCallIds = {}; // Set<String>
            // inspect the buffer and mark all calls which have been answered
            // or hung up before passing them to the call event handler.
            for (let i = callEventBuffer.length - 1; i >= 0; i--) {
                const ev = callEventBuffer[i];
                if (ev.getType() === "m.call.answer" ||
                        ev.getType() === "m.call.hangup") {
                    ignoreCallIds[ev.getContent().call_id] = "yep";
                }
            }
            // now loop through the buffer chronologically and inject them
            callEventBuffer.forEach(function(e) {
                if (ignoreCallIds[e.getContent().call_id]) {
                    // This call has previously been ansered or hung up: ignore it
                    return;
                }
                callEventHandler(e);
            });
            callEventBuffer = [];
        }
    });

    client.on("event", onEvent);

    function onEvent(event) {
        if (event.getType().indexOf("m.call.") !== 0) {
            // not a call event
            if (event.isBeingDecrypted() || event.isDecryptionFailure()) {
                // not *yet* a call event, but might become one...
                event.once("Event.decrypted", onEvent);
            }
            return;
        }
        if (!isClientPrepared) {
            callEventBuffer.push(event);
            return;
        }
        callEventHandler(event);
    }

    function callEventHandler(event) {
        const content = event.getContent();
        let call = content.call_id ? client.callList[content.call_id] : undefined;
        let i;
        //console.log("RECV %s content=%s", event.getType(), JSON.stringify(content));

        if (event.getType() === "m.call.invite") {
            if (event.getSender() === client.credentials.userId) {
                return; // ignore invites you send
            }

            if (event.getAge() > content.lifetime) {
                return; // expired call
            }

            if (call && call.state === "ended") {
                return; // stale/old invite event
            }
            if (call) {
                console.log(
                    "WARN: Already have a MatrixCall with id %s but got an " +
                    "invite. Clobbering.",
                    content.call_id,
                );
            }

            call = webRtcCall.createNewMatrixCall(client, event.getRoomId(), {
                forceTURN: client._forceTURN,
            });
            if (!call) {
                console.log(
                    "Incoming call ID " + content.call_id + " but this client " +
                    "doesn't support WebRTC",
                );
                // don't hang up the call: there could be other clients
                // connected that do support WebRTC and declining the
                // the call on their behalf would be really annoying.
                return;
            }

            call.callId = content.call_id;
            call._initWithInvite(event);
            client.callList[call.callId] = call;

            // if we stashed candidate events for that call ID, play them back now
            if (candidatesByCall[call.callId]) {
                for (i = 0; i < candidatesByCall[call.callId].length; i++) {
                    call._gotRemoteIceCandidate(
                        candidatesByCall[call.callId][i],
                    );
                }
            }

            // Were we trying to call that user (room)?
            let existingCall;
            const existingCalls = utils.values(client.callList);
            for (i = 0; i < existingCalls.length; ++i) {
                const thisCall = existingCalls[i];
                if (call.roomId === thisCall.roomId &&
                        thisCall.direction === 'outbound' &&
                        (["wait_local_media", "create_offer", "invite_sent"].indexOf(
                            thisCall.state) !== -1)) {
                    existingCall = thisCall;
                    break;
                }
            }

            if (existingCall) {
                // If we've only got to wait_local_media or create_offer and
                // we've got an invite, pick the incoming call because we know
                // we haven't sent our invite yet otherwise, pick whichever
                // call has the lowest call ID (by string comparison)
                if (existingCall.state === 'wait_local_media' ||
                        existingCall.state === 'create_offer' ||
                        existingCall.callId > call.callId) {
                    console.log(
                        "Glare detected: answering incoming call " + call.callId +
                        " and canceling outgoing call " + existingCall.callId,
                    );
                    existingCall._replacedBy(call);
                    call.answer();
                } else {
                    console.log(
                        "Glare detected: rejecting incoming call " + call.callId +
                        " and keeping outgoing call " + existingCall.callId,
                    );
                    call.hangup();
                }
            } else {
                client.emit("Call.incoming", call);
            }
        } else if (event.getType() === 'm.call.answer') {
            if (!call) {
                return;
            }
            if (event.getSender() === client.credentials.userId) {
                if (call.state === 'ringing') {
                    call._onAnsweredElsewhere(content);
                }
            } else {
                call._receivedAnswer(content);
            }
        } else if (event.getType() === 'm.call.candidates') {
            if (event.getSender() === client.credentials.userId) {
                return;
            }
            if (!call) {
                // store the candidates; we may get a call eventually.
                if (!candidatesByCall[content.call_id]) {
                    candidatesByCall[content.call_id] = [];
                }
                candidatesByCall[content.call_id] = candidatesByCall[
                    content.call_id
                ].concat(content.candidates);
            } else {
                for (i = 0; i < content.candidates.length; i++) {
                    call._gotRemoteIceCandidate(content.candidates[i]);
                }
            }
        } else if (event.getType() === 'm.call.hangup') {
            // Note that we also observe our own hangups here so we can see
            // if we've already rejected a call that would otherwise be valid
            if (!call) {
                // if not live, store the fact that the call has ended because
                // we're probably getting events backwards so
                // the hangup will come before the invite
                call = webRtcCall.createNewMatrixCall(client, event.getRoomId());
                if (call) {
                    call.callId = content.call_id;
                    call._initWithHangup(event);
                    client.callList[content.call_id] = call;
                }
            } else {
                if (call.state !== 'ended') {
                    call._onHangupReceived(content);
                    delete client.callList[content.call_id];
                }
            }
        }
    }
}

function checkTurnServers(client) {
    if (!client._supportsVoip) {
        return;
    }
    if (client.isGuest()) {
        return; // guests can't access TURN servers
    }

    client.turnServer().done(function(res) {
        if (res.uris) {
            console.log("Got TURN URIs: " + res.uris + " refresh in " +
                res.ttl + " secs");
            // map the response to a format that can be fed to
            // RTCPeerConnection
            const servers = {
                urls: res.uris,
                username: res.username,
                credential: res.password,
            };
            client._turnServers = [servers];
            // re-fetch when we're about to reach the TTL
            client._checkTurnServersTimeoutID = setTimeout(() => {
                checkTurnServers(client);
            }, (res.ttl || (60 * 60)) * 1000 * 0.9);
        }
    }, function(err) {
        console.error("Failed to get TURN URIs");
        client._checkTurnServersTimeoutID =
            setTimeout(function() {
 checkTurnServers(client);
}, 60000);
    });
}

function _reject(callback, defer, err) {
    if (callback) {
        callback(err);
    }
    defer.reject(err);
}

function _resolve(callback, defer, res) {
    if (callback) {
        callback(null, res);
    }
    defer.resolve(res);
}

function _PojoToMatrixEventMapper(client) {
    function mapper(plainOldJsObject) {
        const event = new MatrixEvent(plainOldJsObject);
        if (event.isEncrypted()) {
            client.reEmitter.reEmit(event, [
                "Event.decrypted",
            ]);
            event.attemptDecryption(client._crypto);
        }
        return event;
    }
    return mapper;
}

/**
 * @return {Function}
 */
MatrixClient.prototype.getEventMapper = function() {
    return _PojoToMatrixEventMapper(this);
};

// Identity Server Operations
// ==========================

/**
 * Generates a random string suitable for use as a client secret. <strong>This
 * method is experimental and may change.</strong>
 * @return {string} A new client secret
 */
MatrixClient.prototype.generateClientSecret = function() {
    return randomString(32);
};

/** */
module.exports.MatrixClient = MatrixClient;
/** */
module.exports.CRYPTO_ENABLED = CRYPTO_ENABLED;

// MatrixClient Event JSDocs

/**
 * Fires whenever the SDK receives a new event.
 * <p>
 * This is only fired for live events received via /sync - it is not fired for
 * events received over context, search, or pagination APIs.
 *
 * @event module:client~MatrixClient#"event"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("event", function(event){
 *   var sender = event.getSender();
 * });
 */

/**
 * Fires whenever the SDK receives a new to-device event.
 * @event module:client~MatrixClient#"toDeviceEvent"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("toDeviceEvent", function(event){
 *   var sender = event.getSender();
 * });
 */

/**
 * Fires whenever the SDK's syncing state is updated. The state can be one of:
 * <ul>
 *
 * <li>PREPARED: The client has synced with the server at least once and is
 * ready for methods to be called on it. This will be immediately followed by
 * a state of SYNCING. <i>This is the equivalent of "syncComplete" in the
 * previous API.</i></li>
 *
 * <li>CATCHUP: The client has detected the connection to the server might be
 * available again and will now try to do a sync again. As this sync might take
 * a long time (depending how long ago was last synced, and general server
 * performance) the client is put in this mode so the UI can reflect trying
 * to catch up with the server after losing connection.</li>
 *
 * <li>SYNCING : The client is currently polling for new events from the server.
 * This will be called <i>after</i> processing latest events from a sync.</li>
 *
 * <li>ERROR : The client has had a problem syncing with the server. If this is
 * called <i>before</i> PREPARED then there was a problem performing the initial
 * sync. If this is called <i>after</i> PREPARED then there was a problem polling
 * the server for updates. This may be called multiple times even if the state is
 * already ERROR. <i>This is the equivalent of "syncError" in the previous
 * API.</i></li>
 *
 * <li>RECONNECTING: The sync connection has dropped, but not (yet) in a way that
 * should be considered erroneous.
 * </li>
 *
 * <li>STOPPED: The client has stopped syncing with server due to stopClient
 * being called.
 * </li>
 * </ul>
 * State transition diagram:
 * <pre>
 *                                          +---->STOPPED
 *                                          |
 *              +----->PREPARED -------> SYNCING <--+
 *              |                        ^  |  ^    |
 *              |      CATCHUP ----------+  |  |    |
 *              |        ^                  V  |    |
 *   null ------+        |  +------- RECONNECTING   |
 *              |        V  V                       |
 *              +------->ERROR ---------------------+
 *
 * NB: 'null' will never be emitted by this event.
 *
 * </pre>
 * Transitions:
 * <ul>
 *
 * <li><code>null -> PREPARED</code> : Occurs when the initial sync is completed
 * first time. This involves setting up filters and obtaining push rules.
 *
 * <li><code>null -> ERROR</code> : Occurs when the initial sync failed first time.
 *
 * <li><code>ERROR -> PREPARED</code> : Occurs when the initial sync succeeds
 * after previously failing.
 *
 * <li><code>PREPARED -> SYNCING</code> : Occurs immediately after transitioning
 * to PREPARED. Starts listening for live updates rather than catching up.
 *
 * <li><code>SYNCING -> RECONNECTING</code> : Occurs when the live update fails.
 *
 * <li><code>RECONNECTING -> RECONNECTING</code> : Can occur if the update calls
 * continue to fail, but the keepalive calls (to /versions) succeed.
 *
 * <li><code>RECONNECTING -> ERROR</code> : Occurs when the keepalive call also fails
 *
 * <li><code>ERROR -> SYNCING</code> : Occurs when the client has performed a
 * live update after having previously failed.
 *
 * <li><code>ERROR -> ERROR</code> : Occurs when the client has failed to keepalive
 * for a second time or more.</li>
 *
 * <li><code>SYNCING -> SYNCING</code> : Occurs when the client has performed a live
 * update. This is called <i>after</i> processing.</li>
 *
 * <li><code>* -> STOPPED</code> : Occurs once the client has stopped syncing or
 * trying to sync after stopClient has been called.</li>
 * </ul>
 *
 * @event module:client~MatrixClient#"sync"
 *
 * @param {string} state An enum representing the syncing state. One of "PREPARED",
 * "SYNCING", "ERROR", "STOPPED".
 *
 * @param {?string} prevState An enum representing the previous syncing state.
 * One of "PREPARED", "SYNCING", "ERROR", "STOPPED" <b>or null</b>.
 *
 * @param {?Object} data Data about this transition.
 *
 * @param {MatrixError} data.error The matrix error if <code>state=ERROR</code>.
 *
 * @param {String} data.oldSyncToken The 'since' token passed to /sync.
 *    <code>null</code> for the first successful sync since this client was
 *    started. Only present if <code>state=PREPARED</code> or
 *    <code>state=SYNCING</code>.
 *
 * @param {String} data.nextSyncToken The 'next_batch' result from /sync, which
 *    will become the 'since' token for the next call to /sync. Only present if
 *    <code>state=PREPARED</code> or <code>state=SYNCING</code>.
 *
 * @param {boolean} data.catchingUp True if we are working our way through a
 *    backlog of events after connecting. Only present if <code>state=SYNCING</code>.
 *
 * @example
 * matrixClient.on("sync", function(state, prevState, data) {
 *   switch (state) {
 *     case "ERROR":
 *       // update UI to say "Connection Lost"
 *       break;
 *     case "SYNCING":
 *       // update UI to remove any "Connection Lost" message
 *       break;
 *     case "PREPARED":
 *       // the client instance is ready to be queried.
 *       var rooms = matrixClient.getRooms();
 *       break;
 *   }
 * });
 */

 /**
 * Fires whenever the sdk learns about a new group. <strong>This event
 * is experimental and may change.</strong>
 * @event module:client~MatrixClient#"Group"
 * @param {Group} group The newly created, fully populated group.
 * @example
 * matrixClient.on("Group", function(group){
 *   var groupId = group.groupId;
 * });
 */

 /**
 * Fires whenever a new Room is added. This will fire when you are invited to a
 * room, as well as when you join a room. <strong>This event is experimental and
 * may change.</strong>
 * @event module:client~MatrixClient#"Room"
 * @param {Room} room The newly created, fully populated room.
 * @example
 * matrixClient.on("Room", function(room){
 *   var roomId = room.roomId;
 * });
 */

 /**
 * Fires whenever a Room is removed. This will fire when you forget a room.
 * <strong>This event is experimental and may change.</strong>
 * @event module:client~MatrixClient#"deleteRoom"
 * @param {string} roomId The deleted room ID.
 * @example
 * matrixClient.on("deleteRoom", function(roomId){
 *   // update UI from getRooms()
 * });
 */

/**
 * Fires whenever an incoming call arrives.
 * @event module:client~MatrixClient#"Call.incoming"
 * @param {module:webrtc/call~MatrixCall} call The incoming call.
 * @example
 * matrixClient.on("Call.incoming", function(call){
 *   call.answer(); // auto-answer
 * });
 */

/**
 * Fires whenever the login session the JS SDK is using is no
 * longer valid and the user must log in again.
 * NB. This only fires when action is required from the user, not
 * when then login session can be renewed by using a refresh token.
 * @event module:client~MatrixClient#"Session.logged_out"
 * @example
 * matrixClient.on("Session.logged_out", function(call){
 *   // show the login screen
 * });
 */

/**
 * Fires when the JS SDK receives a M_CONSENT_NOT_GIVEN error in response
 * to a HTTP request.
 * @event module:client~MatrixClient#"no_consent"
 * @example
 * matrixClient.on("no_consent", function(message, contentUri) {
 *     console.info(message + ' Go to ' + contentUri);
 * });
 */

/**
 * Fires when a device is marked as verified/unverified/blocked/unblocked by
 * {@link module:client~MatrixClient#setDeviceVerified|MatrixClient.setDeviceVerified} or
 * {@link module:client~MatrixClient#setDeviceBlocked|MatrixClient.setDeviceBlocked}.
 *
 * @event module:client~MatrixClient#"deviceVerificationChanged"
 * @param {string} userId the owner of the verified device
 * @param {string} deviceId the id of the verified device
 * @param {module:crypto/deviceinfo} deviceInfo updated device information
 */

/**
 * Fires whenever new user-scoped account_data is added.
 * @event module:client~MatrixClient#"accountData"
 * @param {MatrixEvent} event The event describing the account_data just added
 * @example
 * matrixClient.on("accountData", function(event){
 *   myAccountData[event.type] = event.content;
 * });
 */

/**
 * Fires whenever the status of e2e key backup changes, as returned by getKeyBackupEnabled()
 * @event module:client~MatrixClient#"crypto.keyBackupStatus"
 * @param {bool} enabled true if key backup has been enabled, otherwise false
 * @example
 * matrixClient.on("crypto.keyBackupStatus", function(enabled){
 *   if (enabled) {
 *     [...]
 *   }
 * });
 */

/**
 * Fires when we want to suggest to the user that they restore their megolm keys
 * from backup or by cross-signing the device.
 *
 * @event module:client~MatrixClient#"crypto.suggestKeyRestore"
 */

// EventEmitter JSDocs

/**
 * The {@link https://nodejs.org/api/events.html|EventEmitter} class.
 * @external EventEmitter
 * @see {@link https://nodejs.org/api/events.html}
 */

/**
 * Adds a listener to the end of the listeners array for the specified event.
 * No checks are made to see if the listener has already been added. Multiple
 * calls passing the same combination of event and listener will result in the
 * listener being added multiple times.
 * @function external:EventEmitter#on
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Alias for {@link external:EventEmitter#on}.
 * @function external:EventEmitter#addListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Adds a <b>one time</b> listener for the event. This listener is invoked only
 * the next time the event is fired, after which it is removed.
 * @function external:EventEmitter#once
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Remove a listener from the listener array for the specified event.
 * <b>Caution:</b> changes array indices in the listener array behind the
 * listener.
 * @function external:EventEmitter#removeListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Removes all listeners, or those of the specified event. It's not a good idea
 * to remove listeners that were added elsewhere in the code, especially when
 * it's on an emitter that you didn't create (e.g. sockets or file streams).
 * @function external:EventEmitter#removeAllListeners
 * @param {string} event Optional. The event to remove listeners for.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Execute each of the listeners in order with the supplied arguments.
 * @function external:EventEmitter#emit
 * @param {string} event The event to emit.
 * @param {Function} listener The function to invoke.
 * @return {boolean} true if event had listeners, false otherwise.
 */

/**
 * By default EventEmitters will print a warning if more than 10 listeners are
 * added for a particular event. This is a useful default which helps finding
 * memory leaks. Obviously not all Emitters should be limited to 10. This
 * function allows that to be increased. Set to zero for unlimited.
 * @function external:EventEmitter#setMaxListeners
 * @param {Number} n The max number of listeners.
 * @return {EventEmitter} for call chaining.
 */

// MatrixClient Callback JSDocs

/**
 * The standard MatrixClient callback interface. Functions which accept this
 * will specify 2 return arguments. These arguments map to the 2 parameters
 * specified in this callback.
 * @callback module:client.callback
 * @param {Object} err The error value, the "rejected" value or null.
 * @param {Object} data The data returned, the "resolved" value.
 */

 /**
  * {@link https://github.com/kriskowal/q|A promise implementation (Q)}. Functions
  * which return this will specify 2 return arguments. These arguments map to the
  * "onFulfilled" and "onRejected" values of the Promise.
  * @typedef {Object} Promise
  * @static
  * @property {Function} then promise.then(onFulfilled, onRejected, onProgress)
  * @property {Function} catch promise.catch(onRejected)
  * @property {Function} finally promise.finally(callback)
  * @property {Function} done promise.done(onFulfilled, onRejected, onProgress)
  */
