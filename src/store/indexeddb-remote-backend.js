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

import q from "q";

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
 * @param {Object} WorkerApi The web worker compatible interface object
 */
const RemoteIndexedDBStoreBackend = function RemoteIndexedDBStoreBackend(
    workerScript, dbName, WorkerApi,
) {
    this._dbName = dbName;
    this._worker = new WorkerApi(workerScript);
    this._nextSeq = 0;
    // The currently in-flight requests to the actual backend
    this._inFlight = {
        // seq: promise,
    };

    this._worker.onmessage = this._onWorkerMessage.bind(this);
};


RemoteIndexedDBStoreBackend.prototype = {
    /**
     * Attempt to connect to the database. This can fail if the user does not
     * grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect: function() {
        return this._doCmd('_setupWorker', [this._dbName]).then(() => {
            console.log("IndexedDB worker is ready");
            return this._doCmd('connect');
        });
    },

    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase: function() {
        return this._doCmd('clearDatabase');
    },

    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync: function() {
        return this._doCmd('getSavedSync');
    },

    setSyncData: function(syncData) {
        return this._doCmd('setSyncData', [syncData]);
    },

    syncToDatabase: function(users) {
        return this._doCmd('syncToDatabase', [users]);
    },


    /**
     * Load all user presence events from the database. This is not cached.
     * @return {Promise<Object[]>} A list of presence events in their raw form.
     */
    getUserPresenceEvents: function() {
        return this._doCmd('getUserPresenceEvents');
    },

    _doCmd: function(cmd, args) {
        // wrap in a q so if the postMessage throws,
        // the promise automatically gets rejected
        return q().then(() => {
            const seq = this._nextSeq++;
            const def = q.defer();

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
                console.error("Got reply from worker with no seq");
                return;
            }

            const def = this._inFlight[msg.seq];
            if (def === undefined) {
                console.error("Got reply for unknown seq " + msg.seq);
                return;
            }
            delete this._inFlight[msg.seq];

            if (msg.command == 'cmd_success') {
                def.resolve(msg.result);
            } else {
                def.reject(msg.error);
            }
        } else {
            console.warn("Unrecognised message from worker: " + msg);
        }
    },
};

export default RemoteIndexedDBStoreBackend;
