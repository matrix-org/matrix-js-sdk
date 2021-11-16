/**
 * Error messages.
 *
 * @module crypto/verification/Error
 */
import { MatrixEvent } from "../../models/event";
export declare function newVerificationError(code: string, reason: string, extraData: Record<string, any>): MatrixEvent;
export declare function errorFactory(code: string, reason: string): (extraData?: Record<string, any>) => MatrixEvent;
/**
 * The verification was cancelled by the user.
 */
export declare const newUserCancelledError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * The verification timed out.
 */
export declare const newTimeoutError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * The transaction is unknown.
 */
export declare const newUnknownTransactionError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * An unknown method was selected.
 */
export declare const newUnknownMethodError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * An unexpected message was sent.
 */
export declare const newUnexpectedMessageError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * The key does not match.
 */
export declare const newKeyMismatchError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * The user does not match.
 */
export declare const newUserMismatchError: (extraData?: Record<string, any>) => MatrixEvent;
/**
 * An invalid message was sent.
 */
export declare const newInvalidMessageError: (extraData?: Record<string, any>) => MatrixEvent;
export declare function errorFromEvent(event: MatrixEvent): {
    code: string;
    reason: string;
};
//# sourceMappingURL=Error.d.ts.map