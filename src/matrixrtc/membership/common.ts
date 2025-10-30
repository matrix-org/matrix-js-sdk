export class MatrixRTCMembershipParseError extends Error {
    constructor(public readonly type: string, public readonly errors: string[]) {
        super(`Does not match ${type}:\n${errors.join("\n")}`);
    }
}