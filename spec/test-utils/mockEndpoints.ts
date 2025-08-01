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

import { type KeyBackupInfo } from "../../src/crypto-api";

/**
 * Mock out the endpoints that the js-sdk calls when we call `MatrixClient.start()`.
 *
 * @param homeserverUrl - the homeserver url for the client under test
 * @param userId - the local user's ID. Defaults to `@alice:localhost`.
 */
export function mockInitialApiRequests(homeserverUrl: string, userId: string = "@alice:localhost") {
    fetchMock.getOnce(
        new URL("/_matrix/client/versions", homeserverUrl).toString(),
        { versions: ["v1.1"] },
        { overwriteRoutes: true },
    );
    fetchMock.getOnce(
        new URL("/_matrix/client/v3/pushrules/", homeserverUrl).toString(),
        {},
        { overwriteRoutes: true },
    );
    fetchMock.postOnce(
        new URL(`/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`, homeserverUrl).toString(),
        { filter_id: "fid" },
        { overwriteRoutes: true },
    );
}

/**
 * Mock the requests needed to set up cross signing, besides those provided by {@link E2EKeyReceiver}.
 *
 * Return 404 error for `GET _matrix/client/v3/user/:userId/account_data/:type` request
 */
export function mockSetupCrossSigningRequests(): void {
    // have account_data requests return an empty object
    fetchMock.get("express:/_matrix/client/v3/user/:userId/account_data/:type", {
        status: 404,
        body: { errcode: "M_NOT_FOUND", error: "Account data not found." },
    });
}

/**
 * Mock out requests to `/room_keys/version`.
 *
 * Returns `404 M_NOT_FOUND` for GET requests until `POST room_keys/version` is called.
 * Once the POST is done, `GET /room_keys/version` will return the posted backup
 * instead of 404.
 *
 * @param backupVersion - The backup version that will be returned by `POST room_keys/version`.
 */
export function mockSetupMegolmBackupRequests(backupVersion: string): void {
    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
        status: 404,
        body: {
            errcode: "M_NOT_FOUND",
            error: "No current backup version",
        },
    });

    fetchMock.post("path:/_matrix/client/v3/room_keys/version", (url, request) => {
        const backupData: KeyBackupInfo = JSON.parse((request.body as string) ?? "{}");
        backupData.version = backupVersion;
        backupData.count = 0;
        backupData.etag = "zer";
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", backupData, {
            overwriteRoutes: true,
        });
        return {
            version: backupVersion,
        };
    });
}
