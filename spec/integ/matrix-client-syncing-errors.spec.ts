/*
Copyright 2023 Holi Moli GmbH

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

import "fake-indexeddb/auto";
import fetchMock from "fetch-mock-jest";

import { MatrixClient, ClientEvent, createClient, SyncState } from "../../src";

const makeQueryablePromise = <T = void>(promise: Promise<T>) => {
    let resolved = false;
    let rejected = false;

    // Observe the promise, saving the fulfillment in a closure scope.
    const newPromise = promise.then(
        (value) => {
            resolved = true;
            return value;
        },
        (error) => {
            rejected = true;
            throw error;
        },
    );
    const isFulfilled = () => {
        return resolved || rejected;
    };
    const isResolved = () => {
        return resolved;
    };
    const isRejected = () => {
        return rejected;
    };
    return { promise: newPromise, isFulfilled, isResolved, isRejected };
};

const queryablePromise = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;

    const promise = makeQueryablePromise<T>(
        new Promise<T>((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        }),
    );

    return { resolve, reject, ...promise };
};

describe("MatrixClient syncing errors", () => {
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const unknownTokenErrorData = {
        status: 401,
        body: {
            errcode: "M_UNKNOWN_TOKEN",
            error: "Invalid access token passed.",
            soft_logout: false,
        },
    };
    let client: MatrixClient | undefined;

    beforeEach(() => {
        client = createClient({
            baseUrl: "http://tocal.test.server",
            userId: selfUserId,
            accessToken: selfAccessToken,
            deviceId: "myDevice",
        });
    });

    it("should retry, until errors are solved.", async () => {
        jest.useFakeTimers();
        fetchMock.config.overwriteRoutes = false;
        fetchMock
            .getOnce("end:versions", {}) // first version check without credentials needs to succeed
            .getOnce("end:versions", 429) // second version check fails with 429 triggering another retry
            .get("end:versions", {}) // further version checks succeed
            .getOnce("end:pushrules/", 429) // first pushrules check fails starting retry
            .get("end:pushrules/", {}) // further pushrules check succeed
            .catch({}); // all other calls succeed

        const syncEvents = Array.from({ length: 5 }, queryablePromise<SyncState>);

        client!.on(ClientEvent.Sync, (state: SyncState, lastState: SyncState | null) => {
            let i = 0;
            for (; i < syncEvents.length && syncEvents[i].isFulfilled(); i++) {
                // find index of first unfulfilled promise
            }
            syncEvents[i].resolve(state);
        });

        await client!.startClient();
        expect(await syncEvents[0].promise).toBe(SyncState.Error);
        jest.advanceTimersByTime(60 * 1000); // this will skip forward to trigger the keepAlive/sync
        expect(await syncEvents[1].promise).toBe(SyncState.Error);
        jest.advanceTimersByTime(60 * 1000); // this will skip forward to trigger the keepAlive/sync
        expect(await syncEvents[2].promise).toBe(SyncState.Prepared);
        jest.advanceTimersByTime(60 * 1000); // this will skip forward to trigger the keepAlive/sync
        expect(await syncEvents[3].promise).toBe(SyncState.Syncing);
        jest.advanceTimersByTime(60 * 1000); // this will skip forward to trigger the keepAlive/sync
        expect(await syncEvents[4].promise).toBe(SyncState.Syncing);
    });

    it("should stop sync keep alive when client is stopped.", async () => {
        jest.useFakeTimers();
        fetchMock.config.overwriteRoutes = false;
        fetchMock
            .get("end:capabilities", {})
            .getOnce("end:versions", {}) // first version check without credentials needs to succeed
            .get("end:versions", unknownTokenErrorData) // further version checks fails with 401
            .get("end:pushrules/", 401) // fails with 401 without an error. This does happen in practice e.g. with Synapse
            .post("end:logout", unknownTokenErrorData) // just to keep up a consistent scenario. Does not have a real effect for this testcase
            .post("end:filter", 401); // just to keep up a consistent scenario. Does not have a real effect for this testcase

        const firstSyncEvent = queryablePromise<SyncState>();
        const secondSyncEvent = queryablePromise<SyncState>();
        client!.on(ClientEvent.Sync, (state: SyncState, lastState: SyncState | null) => {
            if (firstSyncEvent.isFulfilled()) secondSyncEvent.resolve(state);
            firstSyncEvent.resolve(state);
        });

        await client!.startClient();
        const logoutDone = queryablePromise();
        client!
            .logout(true)
            .then(() => {
                logoutDone.resolve();
            })
            .catch((e) => {
                logoutDone.resolve();
            });

        const syntState = await firstSyncEvent.promise;
        expect(syntState).toBe(SyncState.Error);
        jest.runAllTimers(); // this will skip forward to trigger the keepAlive

        jest.useRealTimers(); // we need real timer for the setTimout below to work

        const timeoutPromise = makeQueryablePromise(new Promise<void>((res) => setTimeout(res, 1)));

        await Promise.race([secondSyncEvent.promise, timeoutPromise.promise]);
        // when syncing stopped, then the secondSyncEvent will never happen and the promise will not be resolved,
        /// so the timeoutPromise will be resolved instead
        expect(timeoutPromise.isFulfilled()).toBe(true);
        expect(secondSyncEvent.isFulfilled()).toBe(false);

        await logoutDone.promise; // wait for the logout to finish to prevent processing and logging after the test is done.
    });
});
