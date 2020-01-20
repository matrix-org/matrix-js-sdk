/*
Copyright 2018 New Vector Ltd

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

/**
 * Error messages.
 *
 * @module crypto/verification/Error
 */

import {MatrixEvent} from "../../models/event";

export function newVerificationError(code, reason, extradata) {
    const content = Object.assign({}, {code, reason}, extradata);
    return new MatrixEvent({
        type: "m.key.verification.cancel",
        content,
    });
}

export function errorFactory(code, reason) {
    return function(extradata) {
        return newVerificationError(code, reason, extradata);
    };
}

/**
 * The verification was cancelled by the user.
 */
export const newUserCancelledError = errorFactory("m.user", "Cancelled by user");

/**
 * The verification timed out.
 */
export const newTimeoutError = errorFactory("m.timeout", "Timed out");

/**
 * The transaction is unknown.
 */
export const newUnknownTransactionError = errorFactory(
    "m.unknown_transaction", "Unknown transaction",
);

/**
 * An unknown method was selected.
 */
export const newUnknownMethodError = errorFactory("m.unknown_method", "Unknown method");

/**
 * An unexpected message was sent.
 */
export const newUnexpectedMessageError = errorFactory(
    "m.unexpected_message", "Unexpected message",
);

/**
 * The key does not match.
 */
export const newKeyMismatchError = errorFactory(
    "m.key_mismatch", "Key mismatch",
);

/**
 * The user does not match.
 */
export const newUserMismatchError = errorFactory("m.user_error", "User mismatch");

/**
 * An invalid message was sent.
 */
export const newInvalidMessageError = errorFactory(
    "m.invalid_message", "Invalid message",
);

export function errorFromEvent(event) {
    const content = event.getContent();
    if (content) {
        const {code, reason} = content;
        return {code, reason};
    } else {
        return {code: "Unknown error", reason: "m.unknown"};
    }
}
