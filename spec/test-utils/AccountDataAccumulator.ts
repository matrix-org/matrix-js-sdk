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

import fetchMock from "@fetch-mock/vitest";

import { type ISyncResponder } from "./SyncResponder";

/**
 * An object which intercepts `account_data` get and set requests via fetch-mock.
 *
 * To use this, call {@link interceptSetAccountData} for each type of account date that should be handled. The updated
 * account data will be stored in {@link accountDataEvents}; it will also trigger a sync response echoing the updated
 * data.
 *
 * Optionally, you can also call {@link interceptGetAccountData}.
 */
export class AccountDataAccumulator {
    /**
     * The account data events to be returned by the sync.
     * Will be updated when fetchMock intercepts calls to PUT `/_matrix/client/v3/user/:userId/account_data/`.
     */
    public accountDataEvents: Map<string, any> = new Map();

    public constructor(private syncResponder: ISyncResponder) {}

    private accountDataResolvers = new Map<string, PromiseWithResolvers<any>>();
    private setInterceptRunning = false;

    /**
     * Intercept setting of account data.
     *
     * Once it is set, its data is stored (for future return by `interceptGetAccountData` etc) and the resolved promise is
     * resolved.
     *
     * @returns a Promise which will resolve (with the content of the account data) once it is set.
     */
    public interceptSetAccountData(): void {
        if (this.setInterceptRunning) return;
        this.setInterceptRunning = true;

        fetchMock.put(`express:/_matrix/client/v3/user/:userId/account_data/:type`, (callLog) => {
            const content = JSON.parse(callLog.options.body as string);
            const type = callLog.url.split("/").pop();
            // update account data for sync response
            this.accountDataEvents.set(type!, content);

            this.accountDataResolvers.get(type!)?.resolve(content);
            if (!this.accountDataResolvers.delete(type!)) {
                // Check for a wildcard matcher
                for (const [key, resolver] of this.accountDataResolvers) {
                    if (key.endsWith("*") && type?.startsWith(key.slice(0, -1))) {
                        resolver.resolve(content);
                        this.accountDataResolvers.delete(key);
                    }
                }
            }

            // return a sync response
            this.sendSyncResponseWithUpdatedAccountData();
            return {};
        });
    }

    /**
     * Wait for a particular type of account data.
     *
     * Once it is set, its data is stored (for future return by `interceptGetAccountData` etc) and the resolved promise is
     * resolved.
     *
     * @returns a Promise which will resolve (with the content of the account data) once it is set.
     */
    public waitForAccountData(type: string): Promise<any> {
        const resolvers = Promise.withResolvers<any>();
        this.accountDataResolvers.set(type, resolvers);
        this.interceptSetAccountData();
        return resolvers.promise;
    }

    /**
     * Intercept all requests to get account data
     */
    public interceptGetAccountData(): void {
        fetchMock.get(`express:/_matrix/client/v3/user/:userId/account_data/:type`, (callLog) => {
            const type = callLog.url.split("/").pop();
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
        });
    }

    /**
     * Send a sync response the current account data events.
     */
    private sendSyncResponseWithUpdatedAccountData(): void {
        try {
            this.syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                account_data: {
                    events: Array.from(this.accountDataEvents, ([type, content]) => ({
                        type: type,
                        content: content,
                    })),
                },
            });
        } catch {
            // Might fail with "Cannot queue more than one /sync response" if called too often.
            // It's ok if it fails here, the sync response is cumulative and will contain
            // the latest account data.
        }
    }
}
