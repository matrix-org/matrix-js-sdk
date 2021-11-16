/**
 * Verification method that is illegal to have (cannot possibly
 * do verification with this method).
 * @module crypto/verification/IllegalMethod
 */
import { VerificationBase as Base } from "./Base";
import { IVerificationChannel } from "./request/Channel";
import { MatrixClient } from "../../client";
import { MatrixEvent } from "../../models/event";
import { VerificationRequest } from "./request/VerificationRequest";
/**
 * @class crypto/verification/IllegalMethod/IllegalMethod
 * @extends {module:crypto/verification/Base}
 */
export declare class IllegalMethod extends Base {
    static factory(channel: IVerificationChannel, baseApis: MatrixClient, userId: string, deviceId: string, startEvent: MatrixEvent, request: VerificationRequest): IllegalMethod;
    static get NAME(): string;
    protected doVerification: () => Promise<void>;
}
//# sourceMappingURL=IllegalMethod.d.ts.map