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

import { EventType } from "../../../src";
import { M_BEACON_INFO } from "../../../src/@types/beacon";
import {
    isTimestampInDuration,
    isBeaconInfoEventType,
    Beacon,
    BeaconEvent,
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
        const roomId = '$room:server.org';
        // 14.03.2022 16:15
        const now = 1647270879403;
        const HOUR_MS = 3600000;

        // beacon_info events
        // created 'an hour ago'
        // without timeout of 3 hours
        let liveBeaconEvent;
        let notLiveBeaconEvent;
        beforeEach(() => {
            // go back in time to create the beacon
            jest.spyOn(global.Date, 'now').mockReturnValue(now - HOUR_MS);
            liveBeaconEvent = makeBeaconInfoEvent(userId, roomId, { timeout: HOUR_MS * 3, isLive: true }, '$live123');
            notLiveBeaconEvent = makeBeaconInfoEvent(
                userId,
                roomId,
                { timeout: HOUR_MS * 3, isLive: false },
                '$dead123',
            );

            // back to now
            jest.spyOn(global.Date, 'now').mockReturnValue(now);
        });

        afterAll(() => {
            jest.spyOn(global.Date, 'now').mockRestore();
        });

        it('creates beacon from event', () => {
            const beacon = new Beacon(liveBeaconEvent);

            expect(beacon.beaconInfoId).toEqual(liveBeaconEvent.getId());
            expect(beacon.isLive).toEqual(true);
        });

        describe('isLive()', () => {
            it('returns false when beacon is explicitly set to not live', () => {
                const beacon = new Beacon(notLiveBeaconEvent);
                expect(beacon.isLive).toEqual(false);
            });

            it('returns false when beacon is expired', () => {
                // time travel to beacon creation + 3 hours
                jest.spyOn(global.Date, 'now').mockReturnValue(now - 3 * HOUR_MS);
                const beacon = new Beacon(liveBeaconEvent);
                expect(beacon.isLive).toEqual(false);
            });

            it('returns false when beacon timestamp is in future', () => {
                // time travel to before beacon events timestamp
                // event was created now - 1 hour
                jest.spyOn(global.Date, 'now').mockReturnValue(now - HOUR_MS - HOUR_MS);
                const beacon = new Beacon(liveBeaconEvent);
                expect(beacon.isLive).toEqual(false);
            });

            it('returns true when beacon was created in past and not yet expired', () => {
                // liveBeaconEvent was created 1 hour ago
                const beacon = new Beacon(liveBeaconEvent);
                expect(beacon.isLive).toEqual(true);
            });
        });

        describe('update()', () => {
            it('does not update with different event', () => {
                const beacon = new Beacon(liveBeaconEvent);

                expect(beacon.beaconInfoId).toEqual(liveBeaconEvent.getId());

                expect(() => beacon.update(notLiveBeaconEvent)).toThrow();
                expect(beacon.isLive).toEqual(true);
            });

            it('updates event', () => {
                const beacon = new Beacon(liveBeaconEvent);
                const emitSpy = jest.spyOn(beacon, 'emit');

                expect(beacon.isLive).toEqual(true);

                const updatedBeaconEvent = makeBeaconInfoEvent(
                    userId, roomId, { timeout: HOUR_MS * 3, isLive: false }, '$live123');

                beacon.update(updatedBeaconEvent);
                expect(beacon.isLive).toEqual(false);
                expect(emitSpy).toHaveBeenCalledWith(BeaconEvent.Update, updatedBeaconEvent, beacon);
            });
        });
    });
});
