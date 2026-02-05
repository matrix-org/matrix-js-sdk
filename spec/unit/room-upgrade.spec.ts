/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { MatrixClient } from "../../src/client";

describe("Room upgrades", function () {
    it("Sends an HTTP request upgrading the room", () => {
        // Given a client with a fake authedRequest method
        const { client, authedRequest } = createClient();

        // When we upgrade the room to version 12
        client.upgradeRoom("!r1", "12");

        // Then we make an HTTP request to the correct endpoint, with the
        // version provided in the JSON.
        expect(authedRequest).toHaveBeenCalledWith("POST", "/rooms/!r1/upgrade", undefined, { new_version: "12" });
    });

    it("Includes additional_creators if provided", () => {
        // Given a client with a fake authedRequest method
        const { client, authedRequest } = createClient();

        // When we upgrade the room to version 13 and supply additionalCreators
        client.upgradeRoom("!r1", "13", ["@u:s.co", "@v:a.b"]);

        // Then we make an HTTP request to the correct endpoint, with the
        // version and additional creators provided.
        expect(authedRequest).toHaveBeenCalledWith("POST", "/rooms/!r1/upgrade", undefined, {
            new_version: "13",
            additional_creators: ["@u:s.co", "@v:a.b"],
        });
    });
});

///
function createClient(): { client: MatrixClient; authedRequest: any } {
    const authedRequest = vi.fn();
    const client = new MatrixClient({
        baseUrl: "https://my.home.server",
        userId: "@u:s.co",
    });
    client.http.authedRequest = authedRequest;
    return { client, authedRequest };
}
