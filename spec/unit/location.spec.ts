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

import { makeLocationContent } from "../../src/content-helpers";
import {
    ASSET_NODE_TYPE,
    LocationAssetType,
    LOCATION_EVENT_TYPE,
    TIMESTAMP_NODE_TYPE,
} from "../../src/@types/location";
import { TEXT_NODE_TYPE } from "../../src/@types/extensible_events";

describe("Location", function() {
    it("should create a valid location with defaults", function() {
        const loc = makeLocationContent("txt", "geo:foo", 134235435);
        expect(loc.body).toEqual("txt");
        expect(loc.msgtype).toEqual("m.location");
        expect(loc.geo_uri).toEqual("geo:foo");
        expect(LOCATION_EVENT_TYPE.findIn(loc)).toEqual({
            uri: "geo:foo",
            description: undefined,
        });
        expect(ASSET_NODE_TYPE.findIn(loc)).toEqual({ type: LocationAssetType.Self });
        expect(TEXT_NODE_TYPE.findIn(loc)).toEqual("txt");
        expect(TIMESTAMP_NODE_TYPE.findIn(loc)).toEqual(134235435);
    });

    it("should create a valid location with explicit properties", function() {
        const loc = makeLocationContent(
            "txxt", "geo:bar", 134235436, "desc", LocationAssetType.Pin);

        expect(loc.body).toEqual("txxt");
        expect(loc.msgtype).toEqual("m.location");
        expect(loc.geo_uri).toEqual("geo:bar");
        expect(LOCATION_EVENT_TYPE.findIn(loc)).toEqual({
            uri: "geo:bar",
            description: "desc",
        });
        expect(ASSET_NODE_TYPE.findIn(loc)).toEqual({ type: LocationAssetType.Pin });
        expect(TEXT_NODE_TYPE.findIn(loc)).toEqual("txxt");
        expect(TIMESTAMP_NODE_TYPE.findIn(loc)).toEqual(134235436);
    });
});
