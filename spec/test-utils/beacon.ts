import { MatrixEvent } from "../../src";
import { M_BEACON, M_BEACON_INFO } from "../../src/@types/beacon";
import { LocationAssetType } from "../../src/@types/location";
import {
    makeBeaconContent,
    makeBeaconInfoContent,
} from "../../src/content-helpers";

type InfoContentProps = {
    timeout: number;
    isLive?: boolean;
    assetType?: LocationAssetType;
    description?: string;
};
const DEFAULT_INFO_CONTENT_PROPS: InfoContentProps = {
    timeout: 3600000,
};

/**
 * Create an m.beacon_info event
 * all required properties are mocked
 * override with contentProps
 */
export const makeBeaconInfoEvent = (
    sender: string,
    contentProps: Partial<InfoContentProps> = {},
): MatrixEvent => {
    const {
        timeout, isLive, description, assetType,
    } = {
        ...DEFAULT_INFO_CONTENT_PROPS,
        ...contentProps,
    };
    const event = new MatrixEvent({
        type: `${M_BEACON_INFO.name}.${sender}`,
        state_key: sender,
        content: makeBeaconInfoContent(timeout, isLive, description, assetType),
    });

    return event;
};

type ContentProps = {
    uri: string;
    timestamp: number;
    beaconInfoId: string;
    description?: string;
};
const DEFAULT_CONTENT_PROPS: ContentProps = {
    uri: 'geo:-36.24484561954707,175.46884959563613;u=10',
    timestamp: 123,
    beaconInfoId: '$123',
};

/**
 * Create an m.beacon event
 * all required properties are mocked
 * override with contentProps
 */
export const makeBeaconEvent = (
    sender: string,
    contentProps: Partial<ContentProps> = {},
): MatrixEvent => {
    const { uri, timestamp, beaconInfoId, description } = {
        ...DEFAULT_CONTENT_PROPS,
        ...contentProps,
    };

    return new MatrixEvent({
        type: M_BEACON.name,
        sender,
        content: makeBeaconContent(uri, timestamp, beaconInfoId, description),
    });
};

/**
 * Create a mock geolocation position
 * defaults all required properties
 */
export const makeGeolocationPosition = (
    { timestamp, coords }:
        { timestamp?: number, coords: Partial<GeolocationCoordinates> },
): GeolocationPosition => ({
    timestamp: timestamp ?? 1647256791840,
    coords: {
        accuracy: 1,
        latitude: 54.001927,
        longitude: -8.253491,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        ...coords,
    },
});
