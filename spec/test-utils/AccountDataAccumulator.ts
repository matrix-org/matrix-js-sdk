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

import { ISyncResponder } from "./SyncResponder";

/**
 *  An object which intercepts `account_data` get and set requests via fetch-mock.
 */
export class AccountDataAccumulator {
    /**
     * The account data events to be returned by the sync.
     * Will be updated when fetchMock intercepts calls to PUT `/_matrix/client/v3/user/:userId/account_data/`.
     * Will be used by `sendSyncResponseWithUpdatedAccountData`
     */
    public accountDataEvents: Map<String, any> = new Map();

    /**
     * Intercept requests to set a particular type of account data.
     *
     * Once it is set, its data is stored (for future return by `interceptGetAccountData` etc) and the resolved promise is
     * resolved.
     *
     * @param accountDataType - type of account data to be intercepted
     * @param opts - options to pass to fetchMock
     * @returns a Promise which will resolve (with the content of the account data) once it is set.
     */
    public interceptSetAccountData(
        accountDataType: string,
        opts?: Parameters<(typeof fetchMock)["put"]>[2],
    ): Promise<any> {
        return new Promise((resolve) => {
            // Called when the cross signing key is uploaded
            fetchMock.put(
                `express:/_matrix/client/v3/user/:userId/account_data/${accountDataType}`,
                (url: string, options: RequestInit) => {
                    const content = JSON.parse(options.body as string);
                    const type = url.split("/").pop();
                    // update account data for sync response
                    this.accountDataEvents.set(type!, content);
                    resolve(content);
                    return {};
                },
                opts,
            );
        });
    }

    /**
     * Intercept all requests to get account data
     */
    public interceptGetAccountData(): void {
        fetchMock.get(
            `express:/_matrix/client/v3/user/:userId/account_data/:type`,
            (url) => {
                const type = url.split("/").pop();
                const existing = this.accountDataEvents.get(type!);
                if (existing) {
                    // return it
                    return {
                        status: 200,
                        body: existing,
                    };
                } else {
                    // 404
                    return {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "Account data not found." },
                    };
                }
            },
            { overwriteRoutes: true },
        );
    }

    /**
     * Send a sync response the current account data events.
     */
    public sendSyncResponseWithUpdatedAccountData(syncResponder: ISyncResponder): void {
        try {
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                account_data: {
                    events: Array.from(this.accountDataEvents, ([type, content]) => ({
                        type: type,
                        content: content,
                    })),
                },
            });
        } catch (err) {
            // Might fail with "Cannot queue more than one /sync response" if called too often.
            // It's ok if it fails here, the sync response is cumulative and will contain
            // the latest account data.
        }
    }
}
