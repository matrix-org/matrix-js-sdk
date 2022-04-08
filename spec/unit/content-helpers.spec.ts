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

import { REFERENCE_RELATION } from "matrix-events-sdk";

import { LocationAssetType, M_ASSET, M_LOCATION, M_TIMESTAMP } from "../../src/@types/location";
import { makeBeaconContent, makeBeaconInfoContent } from "../../src/content-helpers";

describe('Beacon content helpers', () => {
    describe('makeBeaconInfoContent()', () => {
        const mockDateNow = 123456789;
        beforeEach(() => {
            jest.spyOn(global.Date, 'now').mockReturnValue(mockDateNow);
        });
        afterAll(() => {
            jest.spyOn(global.Date, 'now').mockRestore();
        });
        it('create fully defined event content', () => {
            expect(makeBeaconInfoContent(
                1234,
                true,
                'nice beacon_info',
                LocationAssetType.Pin,
            )).toEqual({
                description: 'nice beacon_info',
                timeout: 1234,
                live: true,
                [M_TIMESTAMP.name]: mockDateNow,
                [M_ASSET.name]: {
                    type: LocationAssetType.Pin,
                },
            });
        });

        it('defaults timestamp to current time', () => {
            expect(makeBeaconInfoContent(
                1234,
                true,
                'nice beacon_info',
                LocationAssetType.Pin,
            )).toEqual(expect.objectContaining({
                [M_TIMESTAMP.name]: mockDateNow,
            }));
        });

        it('uses timestamp when provided', () => {
            expect(makeBeaconInfoContent(
                1234,
                true,
                'nice beacon_info',
                LocationAssetType.Pin,
                99999,
            )).toEqual(expect.objectContaining({
                [M_TIMESTAMP.name]: 99999,
            }));
        });

        it('defaults asset type to self when not set', () => {
            expect(makeBeaconInfoContent(
                1234,
                true,
                'nice beacon_info',
                // no assetType passed
            )).toEqual(expect.objectContaining({
                [M_ASSET.name]: {
                    type: LocationAssetType.Self,
                },
            }));
        });
    });

    describe('makeBeaconContent()', () => {
        it('creates event content without description', () => {
            expect(makeBeaconContent(
                'geo:foo',
                123,
                '$1234',
                // no description
            )).toEqual({
                [M_LOCATION.name]: {
                    description: undefined,
                    uri: 'geo:foo',
                },
                [M_TIMESTAMP.name]: 123,
                "m.relates_to": {
                    rel_type: REFERENCE_RELATION.name,
                    event_id: '$1234',
                },
            });
        });

        it('creates event content with description', () => {
            expect(makeBeaconContent(
                'geo:foo',
                123,
                '$1234',
                'test description',
            )).toEqual({
                [M_LOCATION.name]: {
                    description: 'test description',
                    uri: 'geo:foo',
                },
                [M_TIMESTAMP.name]: 123,
                "m.relates_to": {
                    rel_type: REFERENCE_RELATION.name,
                    event_id: '$1234',
                },
            });
        });
    });
});
