import { MatrixEvent } from "../../src";
import { M_BEACON, M_BEACON_INFO } from "../../src/@types/beacon";
import {
    makeBeaconContent,
    MakeBeaconContent,
    MakeBeaconInfoContent,
    makeBeaconInfoContent,
} from "../../src/content-helpers";

export const makeBeaconInfoEvent = (sender: string, ...props: Parameters<MakeBeaconInfoContent>): MatrixEvent =>
    new MatrixEvent({
        type: `${M_BEACON_INFO.name}.${sender}`,
        state_key: sender,
        content: makeBeaconInfoContent(...props),
    });

export const makeBeaconEvent = (sender: string, ...props: Parameters<MakeBeaconContent>): MatrixEvent =>
    new MatrixEvent({
        type: M_BEACON.name,
        sender,
        content: makeBeaconContent(...props),
    });

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
