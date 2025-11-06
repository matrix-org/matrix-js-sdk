/**
 * Thrown when an event does not look valid for use with MatrixRTC.
 */
export class MatrixRTCMembershipParseError extends Error {
    public constructor(
        public readonly type: string,
        public readonly errors: string[],
    ) {
        super(`Does not match ${type}:\n${errors.join("\n")}`);
    }
}
