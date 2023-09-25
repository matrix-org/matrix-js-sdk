/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import fetchMock from "fetch-mock-jest";

import { MapWithDefault } from "../../src/utils";
import { IDownloadKeyResult } from "../../src";
import { IDeviceKeys } from "../../src/@types/crypto";
import { E2EKeyReceiver } from "./E2EKeyReceiver";

/**
 * An object which intercepts `/keys/query` fetches via fetch-mock.
 */
export class E2EKeyResponder {
    private deviceKeysByUserByDevice = new MapWithDefault<string, Map<string, any>>(() => new Map());
    private e2eKeyReceiversByUser = new Map<string, E2EKeyReceiver>();
    private masterKeysByUser: Record<string, any> = {};
    private selfSigningKeysByUser: Record<string, any> = {};
    private userSigningKeysByUser: Record<string, any> = {};

    /**
     * Construct a new E2EKeyResponder.
     *
     * It will immediately register an intercept of `/keys/query` requests for the given homeserverUrl.
     * Only /query requests made to this server will be intercepted: this allows a single test to use more than one
     * client and have the keys collected separately.
     *
     * @param homeserverUrl - the Homeserver Url of the client under test.
     */
    public constructor(homeserverUrl: string) {
        // set up a listener for /keys/query.
        const listener = (url: string, options: RequestInit) => this.onKeyQueryRequest(options);
        fetchMock.post(new URL("/_matrix/client/v3/keys/query", homeserverUrl).toString(), listener);
    }

    private onKeyQueryRequest(options: RequestInit) {
        const content = JSON.parse(options.body as string);
        const usersToReturn = Object.keys(content["device_keys"]);
        const response = {
            device_keys: {} as { [userId: string]: any },
            master_keys: {} as { [userId: string]: any },
            self_signing_keys: {} as { [userId: string]: any },
            user_signing_keys: {} as { [userId: string]: any },
            failures: {} as { [serverName: string]: any },
        };
        for (const user of usersToReturn) {
            const userKeys = this.deviceKeysByUserByDevice.get(user);
            if (userKeys !== undefined) {
                response.device_keys[user] = Object.fromEntries(userKeys.entries());
            }

            const e2eKeyReceiver = this.e2eKeyReceiversByUser.get(user);
            if (e2eKeyReceiver !== undefined) {
                const deviceKeys = e2eKeyReceiver.getUploadedDeviceKeys();
                if (deviceKeys !== null) {
                    response.device_keys[user] ??= {};
                    response.device_keys[user][deviceKeys.device_id] = deviceKeys;
                }
            }

            if (this.masterKeysByUser.hasOwnProperty(user)) {
                response.master_keys[user] = this.masterKeysByUser[user];
            }
            if (this.selfSigningKeysByUser.hasOwnProperty(user)) {
                response.self_signing_keys[user] = this.selfSigningKeysByUser[user];
            }
            if (this.userSigningKeysByUser.hasOwnProperty(user)) {
                response.user_signing_keys[user] = this.userSigningKeysByUser[user];
            }
        }
        return response;
    }

    /**
     * Add a set of device keys for return by a future `/keys/query`, as if they had been `/upload`ed
     *
     * @param keys - device keys for this device.
     */
    public addDeviceKeys(keys: IDeviceKeys) {
        this.deviceKeysByUserByDevice.getOrCreate(keys.user_id).set(keys.device_id, keys);
    }

    /** Add a set of cross-signing keys for return by a future `/keys/query`, as if they had been `/keys/device_signing/upload`ed
     *
     * @param data cross-signing data
     */
    public addCrossSigningData(
        data: Pick<IDownloadKeyResult, "master_keys" | "self_signing_keys" | "user_signing_keys">,
    ) {
        Object.assign(this.masterKeysByUser, data.master_keys);
        Object.assign(this.selfSigningKeysByUser, data.self_signing_keys);
        Object.assign(this.userSigningKeysByUser, data.user_signing_keys);
    }

    /**
     * Add an E2EKeyReceiver to poll for uploaded keys
     *
     * Any keys which have been uploaded to the given `E2EKeyReceiver` at the time of the `/keys/query` request will
     * be added to the response.
     *
     * @param e2eKeyReceiver
     */
    public addKeyReceiver(userId: string, e2eKeyReceiver: E2EKeyReceiver) {
        this.e2eKeyReceiversByUser.set(userId, e2eKeyReceiver);
    }
}
