/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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
import { type E2EKeyReceiver } from "./E2EKeyReceiver";
import { type IClaimKeysRequest } from "../../src";

/**
 * An object which intercepts `/keys/claim` fetches via fetch-mock.
 */
export class E2EOTKClaimResponder {
    private e2eKeyReceiversByUserByDevice = new MapWithDefault<string, Map<string, E2EKeyReceiver>>(() => new Map());

    /**
     * Construct a new E2EOTKClaimResponder.
     *
     * It will immediately register an intercept of `/keys/claim` requests for the given homeserverUrl.
     * Only /claim requests made to this server will be intercepted: this allows a single test to use more than one
     * client and have the keys collected separately.
     *
     * @param homeserverUrl - the Homeserver Url of the client under test.
     */
    public constructor(homeserverUrl: string) {
        const listener = (url: string, options: RequestInit) => this.onKeyClaimRequest(options);
        fetchMock.post(new URL("/_matrix/client/v3/keys/claim", homeserverUrl).toString(), listener);
    }

    private onKeyClaimRequest(options: RequestInit) {
        const content = JSON.parse(options.body as string) as IClaimKeysRequest;
        const response = {
            one_time_keys: {} as { [userId: string]: any },
        };
        for (const [userId, devices] of Object.entries(content["one_time_keys"])) {
            for (const deviceId of Object.keys(devices)) {
                const e2eKeyReceiver = this.e2eKeyReceiversByUserByDevice.get(userId)?.get(deviceId);
                const otk = e2eKeyReceiver?.getOneTimeKey();
                if (otk) {
                    const [keyId, key] = otk;
                    response.one_time_keys[userId] ??= {};
                    response.one_time_keys[userId][deviceId] = {
                        [keyId]: key,
                    };
                }
            }
        }
        return response;
    }

    /**
     * Add an E2EKeyReceiver to poll for uploaded keys
     *
     * When the `/keys/claim` request is received, a OTK will be removed from the `E2EKeyReceiver` and
     * added to the response.
     */
    public addKeyReceiver(userId: string, deviceId: string, e2eKeyReceiver: E2EKeyReceiver) {
        this.e2eKeyReceiversByUserByDevice.getOrCreate(userId).set(deviceId, e2eKeyReceiver);
    }
}
