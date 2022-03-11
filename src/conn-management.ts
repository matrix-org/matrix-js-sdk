/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import * as utils from "./utils";
import { IDeferred } from "./utils";
import { MatrixClient } from "./client";
import { ISyncStateData } from "./sync";
import { Method } from "./http-api";
import {SyncState } from "./sync";

/**
 * ConnectionManagement is a class which handles keep-alives and invokes a callback when the connection
 * is alive/dead. Uses /versions as a keep-alive endpoint.
 */
export class ConnectionManagement {
    private keepAliveTimer: number = null;
    private connectionReturnedDefer: IDeferred<boolean> = null;
    private client: MatrixClient;
    private callback: (newState: SyncState, data?: ISyncStateData) => void;

    constructor(client, callback) {
        this.client = client;
        this.callback = callback;
    }

    /**
     * Retry a backed off syncing request immediately. This should only be used when
     * the user <b>explicitly</b> attempts to retry their lost connection.
     * @return {boolean} True if this resulted in a request being retried.
     */
    public retryImmediately(): boolean {
        if (!this.connectionReturnedDefer) {
            return false;
        }
        this.startKeepAlives(0);
        return true;
    }

    public start(): void {
        if (global.window && global.window.addEventListener) {
            global.window.addEventListener("online", this.onOnline, false);
        }
    }

    public stop(): void {
        // It is necessary to check for the existance of
        // global.window AND global.window.removeEventListener.
        // Some platforms (e.g. React Native) register global.window,
        // but do not have global.window.removeEventListener.
        if (global.window && global.window.removeEventListener) {
            global.window.removeEventListener("online", this.onOnline, false);
        }
        
        if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    /**
     * Make a dummy call to /_matrix/client/versions, to see if the HS is
     * reachable.
     *
     * On failure, schedules a call back to itself. On success, resolves
     * this.connectionReturnedDefer.
     *
     * @param {boolean} connDidFail True if a connectivity failure has been detected. Optional.
     */
    private async pokeKeepAlive(connDidFail = false) {
        const success = () => {
            clearTimeout(this.keepAliveTimer);
            if (this.connectionReturnedDefer) {
                this.connectionReturnedDefer.resolve(connDidFail);
                this.connectionReturnedDefer = null;
            }
        };

        try {
            await this.client.http.request(
                undefined, // callback
                Method.Get, "/_matrix/client/versions",
                undefined, // queryParams
                undefined, // data
                {
                    prefix: '',
                    localTimeoutMs: 15 * 1000,
                },
            )
            success();
        } catch (err) {
            if (err.httpStatus == 400 || err.httpStatus == 404) {
                // treat this as a success because the server probably just doesn't
                // support /versions: point is, we're getting a response.
                // We wait a short time though, just in case somehow the server
                // is in a mode where it 400s /versions responses and sync etc.
                // responses fail, this will mean we don't hammer in a loop.
                this.keepAliveTimer = setTimeout(success, 2000);
            } else {
                connDidFail = true;
                this.keepAliveTimer = setTimeout(
                    this.pokeKeepAlive.bind(this, connDidFail),
                    5000 + Math.floor(Math.random() * 5000),
                );
                // A keepalive has failed, so we emit the
                // error state (whether or not this is the
                // first failure).
                // Note we do this after setting the timer:
                // this lets the unit tests advance the mock
                // clock when they get the error.
                this.callback(SyncState.Error, { error: err });
            }
        }
    }

    /**
     * Starts polling the connectivity check endpoint
     * @param {number} delay How long to delay until the first poll.
     *        defaults to a short, randomised interval (to prevent
     *        tightlooping if /versions succeeds but /sync etc. fail).
     * @return {promise} which resolves once the connection returns
     */
     private startKeepAlives(delay?: number): Promise<boolean> {
        if (delay === undefined) {
            delay = 2000 + Math.floor(Math.random() * 5000);
        }

        if (this.keepAliveTimer !== null) {
            clearTimeout(this.keepAliveTimer);
        }
        if (delay > 0) {
            this.keepAliveTimer = setTimeout(this.pokeKeepAlive.bind(this), delay);
        } else {
            this.pokeKeepAlive();
        }
        if (!this.connectionReturnedDefer) {
            this.connectionReturnedDefer = utils.defer();
        }
        return this.connectionReturnedDefer.promise;
    }

    /**
     * Event handler for the 'online' event
     * This event is generally unreliable and precise behaviour
     * varies between browsers, so we poll for connectivity too,
     * but this might help us reconnect a little faster.
     */
    private onOnline = (): void => {
        this.startKeepAlives(0);
    };
}