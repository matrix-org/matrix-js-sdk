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
 * This is an internal module. See {@link IndexedDBStore} for the public class.
 * @module store/indexeddb
 */

const VERSION = 1;

/**
 * Construct a new Indexed Database store. This requires a call to <code>connect()</code> before
 * this store can be used.
 * @constructor
 * @param {Object} indexedDBInterface The Indexed DB interface e.g <code>window.indexedDB</code>
 */
module.exports.IndexedDBStore = function IndexedDBStore(indexedDBInterface) {
    this.indexedDB = indexedDBInterface;
    this.db = null;
};


module.exports.IndexedDBStore.prototype = {
    /**
     * Attempt to connect to the database. This can fail if the user does not grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect: function() {
        if (this.db) {
            return Promise.resolve();
        }
        const req = this.indexedDB.open("matrix-js-sdk", VERSION);
        req.onupgradeneeded = (ev) => {
            const db = req.result;
            const oldVersion = ev.oldVersion;
            if (oldVersion < 1) { // The database did not previously exist.
                createDatabase(db);
            }
            // Expand as needed.
        }
        return promiseify(req).then((ev) => {
            this.db = ev.target.result;
        });
    }
}

function createDatabase(db) {
    // TODO: Make object stores and indexes.
}

function promiseify(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = function(event) {
            resolve(event);
        };
        req.onerror = function(event) {
            reject(event);
        };
    });
}