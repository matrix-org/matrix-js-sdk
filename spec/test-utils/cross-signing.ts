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

import { IAuthDict, MatrixClient, UIAuthCallback } from "../../src";

/**
 * Mock the requests needed to set up cross signing
 *
 * Return `{}` for `GET _matrix/client/r0/user/:userId/account_data/:type` request
 * Return `{}` for `POST _matrix/client/v3/keys/signatures/upload` request (named `upload-sigs` for fetchMock check)
 * Return `{}` for `POST /_matrix/client/(unstable|v3)/keys/device_signing/upload` request (named `upload-keys` for fetchMock check)
 */
export function mockSetupCrossSigningRequests(): void {
    // have account_data requests return an empty object
    fetchMock.get("express:/_matrix/client/r0/user/:userId/account_data/:type", {});

    // we expect a request to upload signatures for our device ...
    fetchMock.post({ url: "path:/_matrix/client/v3/keys/signatures/upload", name: "upload-sigs" }, {});

    // ... and one to upload the cross-signing keys (with UIA)
    fetchMock.post(
        // legacy crypto uses /unstable/; /v3/ is correct
        {
            url: new RegExp("/_matrix/client/(unstable|v3)/keys/device_signing/upload"),
            name: "upload-keys",
        },
        {},
    );
}

/**
 * Create cross-signing keys and publish the keys
 *
 * @param matrixClient - The matrixClient to bootstrap.
 * @param authDict - The parameters to as the `auth` dict in the key upload request.
 * @see https://spec.matrix.org/v1.6/client-server-api/#authentication-types
 */
export async function bootstrapCrossSigning(matrixClient: MatrixClient, authDict: IAuthDict): Promise<void> {
    const uiaCallback: UIAuthCallback<void> = async (makeRequest) => {
        await makeRequest(authDict);
    };

    // now bootstrap cross signing, and check it resolves successfully
    await matrixClient.getCrypto()?.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: uiaCallback,
    });
}
