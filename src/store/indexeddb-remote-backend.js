/*
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import {logger} from '../logger';
import {defer} from '../utils';

/**
 * An IndexedDB store backend where the actual backend sits in a web
 * worker.
 *
 * Construct a new Indexed Database store backend. This requires a call to
 * <code>connect()</code> before this store can be used.
 * @constructor
 * @param {string} workerScript URL to the worker script
 * @param {string=} dbName Optional database name. The same name must be used
 * to open the same database.
 * @param {Object} workerApi The web worker compatible interface object
 */
export function RemoteIndexedDBStoreBackend(
    workerScript, dbName, workerApi,
) {
    this._workerScript = workerScript;
    this._dbName = dbName;
    this._workerApi = workerApi;
    this._worker = null;
    this._nextSeq = 0;
    // The currently in-flight requests to the actual backend
    this._inFlight = {
        // seq: promise,
    };
    // Once we start connecting, we keep the promise and re-use it
    // if we try to connect again
    this._startPromise = null;
}


RemoteIndexedDBStoreBackend.prototype = {
    /**
     * Attempt to connect to the database. This can fail if the user does not
     * grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect: function() {
        return this._ensureStarted().then(() => this._doCmd('connect'));
    },

    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase: function() {
        return this._ensureStarted().then(() => this._doCmd('clearDatabase'));
    },
    /** @return {Promise<bool>} whether or not the database was newly created in this session. */
    isNewlyCreated: function() {
        return this._doCmd('isNewlyCreated');
    },
    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync: function() {
        return this._doCmd('getSavedSync');
    },

    getNextBatchToken: function() {
        return this._doCmd('getNextBatchToken');
    },

    setSyncData: function(syncData) {
        return this._doCmd('setSyncData', [syncData]);
    },

    syncToDatabase: function(users) {
        return this._doCmd('syncToDatabase', [users]);
    },

    /**
     * Returns the out-of-band membership events for this room that
     * were previously loaded.
     * @param {string} roomId
     * @returns {event[]} the events, potentially an empty array if OOB loading didn't yield any new members
     * @returns {null} in case the members for this room haven't been stored yet
     */
    getOutOfBandMembers: function(roomId) {
        return this._doCmd('getOutOfBandMembers', [roomId]);
    },

    /**
     * Stores the out-of-band membership events for this room. Note that
     * it still makes sense to store an empty array as the OOB status for the room is
     * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
     * @param {string} roomId
     * @param {event[]} membershipEvents the membership events to store
     * @returns {Promise} when all members have been stored
     */
    setOutOfBandMembers: function(roomId, membershipEvents) {
        return this._doCmd('setOutOfBandMembers', [roomId, membershipEvents]);
    },

    clearOutOfBandMembers: function(roomId) {
        return this._doCmd('clearOutOfBandMembers', [roomId]);
    },

    getClientOptions: function() {
        return this._doCmd('getClientOptions');
    },

    storeClientOptions: function(options) {
        return this._doCmd('storeClientOptions', [options]);
    },

    /**
     * Load all user presence events from the database. This is not cached.
     * @return {Promise<Object[]>} A list of presence events in their raw form.
     */
    getUserPresenceEvents: function() {
        return this._doCmd('getUserPresenceEvents');
    },

    _ensureStarted: function() {
        if (this._startPromise === null) {
            this._worker = new this._workerApi(this._workerScript);
            this._worker.onmessage = this._onWorkerMessage.bind(this);

            // tell the worker the db name.
            this._startPromise = this._doCmd('_setupWorker', [this._dbName]).then(() => {
                logger.log("IndexedDB worker is ready");
            });
        }
        return this._startPromise;
    },

    _doCmd: function(cmd, args) {
        // wrap in a q so if the postMessage throws,
        // the promise automatically gets rejected
        return Promise.resolve().then(() => {
            const seq = this._nextSeq++;
            const def = defer();

            this._inFlight[seq] = def;

            this._worker.postMessage({
                command: cmd,
                seq: seq,
                args: args,
            });

            return def.promise;
        });
    },

    _onWorkerMessage: function(ev) {
        const msg = ev.data;

        if (msg.command == 'cmd_success' || msg.command == 'cmd_fail') {
            if (msg.seq === undefined) {
                logger.error("Got reply from worker with no seq");
                return;
            }

            const def = this._inFlight[msg.seq];
            if (def === undefined) {
                logger.error("Got reply for unknown seq " + msg.seq);
                return;
            }
            delete this._inFlight[msg.seq];

            if (msg.command == 'cmd_success') {
                def.resolve(msg.result);
            } else {
                const error = new Error(msg.error.message);
                error.name = msg.error.name;
                def.reject(error);
            }
        } else {
            logger.warn("Unrecognised message from worker: " + msg);
        }
    },
};
