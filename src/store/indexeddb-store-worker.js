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
import LocalIndexedDBStoreBackend from "./indexeddb-local-backend.js";

/**
 * This class lives in the webworker and drives a LocalIndexedDBStoreBackend
 * controlled by messages from the main process.
 *
 * It should be instantiated by a web worker script provided by the application
 * in a script, for example:
 *
 * import {IndexedDBStoreWorker} from 'matrix-js-sdk/lib/indexeddb-worker.js';
 * const remoteWorker = new IndexedDBStoreWorker(postMessage);
 * onmessage = remoteWorker.onMessage;
 *
 * Note that it is advisable to import this class by referencing the file directly to
 * avoid a dependency on the whole js-sdk.
 *
 */
class IndexedDBStoreWorker {
    /**
     * @param {function} postMessage The web worker postMessage function that
     * should be used to communicate back to the main script.
     */
    constructor(postMessage) {
        this.backend = null;
        this.postMessage = postMessage;

        this.onMessage = this.onMessage.bind(this);
    }

    /**
     * Passes a message event from the main script into the class. This method
     * can be directly assigned to the web worker `onmessage` variable.
     *
     * @param {Object} ev The message event
     */
    onMessage(ev) {
        const msg = ev.data;
        let prom;

        switch (msg.command) {
            case '_setupWorker':
                this.backend = new LocalIndexedDBStoreBackend(
                    // this is the 'indexedDB' global (where global != window
                    // because it's a web worker and there is no window).
                    indexedDB, msg.args[0],
                );
                prom = q();
                break;
            case 'connect':
                prom = this.backend.connect();
                break;
            case 'clearDatabase':
                prom = this.backend.clearDatabase().then((result) => {
                    // This returns special classes which can't be cloned
                    // across to the main script, so don't try.
                    return {};
                });
                break;
            case 'getSavedSync':
                prom = this.backend.getSavedSync(false);
                break;
            case 'setSyncData':
                prom = this.backend.setSyncData(...msg.args);
                break;
            case 'syncToDatabase':
                prom = this.backend.syncToDatabase(...msg.args).then(() => {
                    // This also returns IndexedDB events which are not cloneable
                    return {};
                });
                break;
            case 'loadUserPresenceEvents':
                prom = this.backend.loadUserPresenceEvents();
                break;
            case 'loadAccountData':
                prom = this.backend.loadAccountData();
                break;
            case 'loadSyncData':
                prom = this.backend.loadSyncData();
                break;
        }

        if (prom === undefined) {
            postMessage({
                command: 'cmd_fail',
                seq: msg.seq,
                // Can't be an Error because they're not structured cloneable
                error: "Unrecognised command",
            });
            return;
        }

        prom.done((ret) => {
            this.postMessage.call(null, {
                command: 'cmd_success',
                seq: msg.seq,
                result: ret,
            });
        }, (err) => {
            console.error("Error running command: "+msg.command);
            console.error(err);
            this.postMessage.call(null, {
                command: 'cmd_fail',
                seq: msg.seq,
                // Just send a string because Error objects aren't cloneable
                error: "Error running command",
            });
        });
    }
}

module.exports = IndexedDBStoreWorker;
