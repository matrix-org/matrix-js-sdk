import { EventType } from "../../../src";
import { M_BEACON_INFO } from "../../../src/@types/beacon";
import {
    isTimestampInDuration,
    isBeaconInfoEventType,
    Beacon,
} from "../../../src/models/beacon";
import { makeBeaconInfoEvent } from "../../test-utils/beacon";

describe('Beacon', () => {
    describe('isTimestampInDuration()', () => {
        const startTs = new Date('2022-03-11T12:07:47.592Z').getTime();
        const HOUR_MS = 3600000;
        it('returns false when timestamp is before start time', () => {
            // day before
            const timestamp = new Date('2022-03-10T12:07:47.592Z').getTime();
            expect(isTimestampInDuration(startTs, HOUR_MS, timestamp)).toBe(false);
        });

        it('returns false when timestamp is after start time + duration', () => {
            // 1 second later
            const timestamp = new Date('2022-03-10T12:07:48.592Z').getTime();
            expect(isTimestampInDuration(startTs, HOUR_MS, timestamp)).toBe(false);
        });

        it('returns true when timestamp is exactly start time', () => {
            expect(isTimestampInDuration(startTs, HOUR_MS, startTs)).toBe(true);
        });

        it('returns true when timestamp is exactly the end of the duration', () => {
            expect(isTimestampInDuration(startTs, HOUR_MS, startTs + HOUR_MS)).toBe(true);
        });

        it('returns true when timestamp is within the duration', () => {
            const twoHourDuration = HOUR_MS * 2;
            const now = startTs + HOUR_MS;
            expect(isTimestampInDuration(startTs, twoHourDuration, now)).toBe(true);
        });
    });

    describe('isBeaconInfoEventType', () => {
        it.each([
            EventType.CallAnswer,
            `prefix.${M_BEACON_INFO.name}`,
            `prefix.${M_BEACON_INFO.altName}`,
        ])('returns false for %s', (type) => {
            expect(isBeaconInfoEventType(type)).toBe(false);
        });

        it.each([
            M_BEACON_INFO.name,
            M_BEACON_INFO.altName,
            `${M_BEACON_INFO.name}.@test:server.org.12345`,
            `${M_BEACON_INFO.altName}.@test:server.org.12345`,
        ])('returns true for %s', (type) => {
            expect(isBeaconInfoEventType(type)).toBe(true);
        });
    });

    describe('Beacon', () => {
        const userId = '@user:server.org';
        // 14.03.2022 16:15
        const now = 1647270879403;
        beforeEach(() => {
            jest.spyOn(global.Date, 'now').mockReturnValue(now);
        });

        afterAll(() => {
            jest.spyOn(global.Date, 'now').mockRestore();
        });

        it('creates beacon from event', () => {
            const liveBeacon = makeBeaconInfoEvent(userId, 1000, true);
        });
    });
});
