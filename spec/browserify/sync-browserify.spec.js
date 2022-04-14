/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

// load XmlHttpRequest mock
import "./setupTests";
import "../../dist/browser-matrix"; // uses browser-matrix instead of the src
import * as utils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";

const USER_ID = "@user:test.server";
const DEVICE_ID = "device_id";
const ACCESS_TOKEN = "access_token";
const ROOM_ID = "!room_id:server.test";

describe("Browserify Test", function() {
    let client;
    let httpBackend;

    beforeEach(() => {
        const testClient = new TestClient(USER_ID, DEVICE_ID, ACCESS_TOKEN);

        client = testClient.client;
        httpBackend = testClient.httpBackend;

        httpBackend.when("GET", "/versions").respond(200, {});
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });

        client.startClient();
    });

    afterEach(async () => {
        client.stopClient();
        httpBackend.stop();
    });

    it("Sync", async function() {
        const event = utils.mkMembership({
            room: ROOM_ID,
            mship: "join",
            user: "@other_user:server.test",
            name: "Displayname",
        });

        const syncData = {
            next_batch: "batch1",
            rooms: {
                join: {},
            },
        };
        syncData.rooms.join[ROOM_ID] = {
            timeline: {
                events: [
                    event,
                ],
                limited: false,
            },
        };

        httpBackend.when("GET", "/sync").respond(200, syncData);
        return await Promise.race([
            httpBackend.flushAllExpected(),
            new Promise((_, reject) => {
                client.once("sync.unexpectedError", reject);
            }),
        ]);
    }, 20000); // additional timeout as this test can take quite a while
});
