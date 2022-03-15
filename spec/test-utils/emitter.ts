/**
 * Filter emitter.emit mock calls to find relevant events
 * eg:
 * ```
 * const emitSpy = jest.spyOn(state, 'emit');
 * << actions >>
 * const beaconLivenessEmits = emitCallsByEventType(BeaconEvent.New, emitSpy);
 * expect(beaconLivenessEmits.length).toBe(1);
 * ```
 */
export const filterEmitCallsByEventType = (eventType: string, spy: jest.SpyInstance<any, unknown[]>) =>
    spy.mock.calls.filter((args) => args[0] === eventType);
