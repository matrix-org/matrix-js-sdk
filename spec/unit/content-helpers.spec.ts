import { REFERENCE_RELATION } from "matrix-events-sdk";

import { M_BEACON_INFO } from "../../src/@types/beacon";
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
                'nice beacon_info',
                LocationAssetType.Pin,
            )).toEqual({
                [M_BEACON_INFO.name]: {
                    description: 'nice beacon_info',
                    timeout: 1234,
                },
                [M_TIMESTAMP.name]: mockDateNow,
                [M_ASSET.name]: {
                    type: LocationAssetType.Pin,
                },
            });
        });

        it('defaults timestamp to current time', () => {
            expect(makeBeaconInfoContent(
                1234,
                'nice beacon_info',
                LocationAssetType.Pin,
            )).toEqual(expect.objectContaining({
                [M_TIMESTAMP.name]: mockDateNow,
            }));
        });

        it('defaults asset type to self when not set', () => {
            expect(makeBeaconInfoContent(
                1234,
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
