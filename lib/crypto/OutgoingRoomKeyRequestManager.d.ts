import { MatrixClient } from "../client";
import { IRoomKeyRequestBody, IRoomKeyRequestRecipient } from "./index";
import { CryptoStore, OutgoingRoomKeyRequest } from './store/base';
/** possible states for a room key request
 *
 * The state machine looks like:
 *
 *     |         (cancellation sent)
 *     | .-------------------------------------------------.
 *     | |                                                 |
 *     V V       (cancellation requested)                  |
 *   UNSENT  -----------------------------+                |
 *     |                                  |                |
 *     |                                  |                |
 *     | (send successful)                |  CANCELLATION_PENDING_AND_WILL_RESEND
 *     V                                  |                Λ
 *    SENT                                |                |
 *     |--------------------------------  |  --------------'
 *     |                                  |  (cancellation requested with intent
 *     |                                  |   to resend the original request)
 *     |                                  |
 *     | (cancellation requested)         |
 *     V                                  |
 * CANCELLATION_PENDING                   |
 *     |                                  |
 *     | (cancellation sent)              |
 *     V                                  |
 * (deleted)  <---------------------------+
 *
 * @enum {number}
 */
export declare enum RoomKeyRequestState {
    /** request not yet sent */
    Unsent = 0,
    /** request sent, awaiting reply */
    Sent = 1,
    /** reply received, cancellation not yet sent */
    CancellationPending = 2,
    /**
     * Cancellation not yet sent and will transition to UNSENT instead of
     * being deleted once the cancellation has been sent.
     */
    CancellationPendingAndWillResend = 3
}
export declare class OutgoingRoomKeyRequestManager {
    private readonly baseApis;
    private readonly deviceId;
    private readonly cryptoStore;
    private sendOutgoingRoomKeyRequestsTimer;
    private sendOutgoingRoomKeyRequestsRunning;
    private clientRunning;
    constructor(baseApis: MatrixClient, deviceId: string, cryptoStore: CryptoStore);
    /**
     * Called when the client is started. Sets background processes running.
     */
    start(): void;
    /**
     * Called when the client is stopped. Stops any running background processes.
     */
    stop(): void;
    /**
     * Send any requests that have been queued
     */
    sendQueuedRequests(): void;
    /**
     * Queue up a room key request, if we haven't already queued or sent one.
     *
     * The `requestBody` is compared (with a deep-equality check) against
     * previous queued or sent requests and if it matches, no change is made.
     * Otherwise, a request is added to the pending list, and a job is started
     * in the background to send it.
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     * @param {Array<{userId: string, deviceId: string}>} recipients
     * @param {boolean} resend whether to resend the key request if there is
     *    already one
     *
     * @returns {Promise} resolves when the request has been added to the
     *    pending list (or we have established that a similar request already
     *    exists)
     */
    queueRoomKeyRequest(requestBody: IRoomKeyRequestBody, recipients: IRoomKeyRequestRecipient[], resend?: boolean): Promise<void>;
    /**
     * Cancel room key requests, if any match the given requestBody
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *
     * @returns {Promise} resolves when the request has been updated in our
     *    pending list.
     */
    cancelRoomKeyRequest(requestBody: IRoomKeyRequestBody): Promise<unknown>;
    /**
     * Look for room key requests by target device and state
     *
     * @param {string} userId Target user ID
     * @param {string} deviceId Target device ID
     *
     * @return {Promise} resolves to a list of all the
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     */
    getOutgoingSentRoomKeyRequest(userId: string, deviceId: string): Promise<OutgoingRoomKeyRequest[]>;
    /**
     * Find anything in `sent` state, and kick it around the loop again.
     * This is intended for situations where something substantial has changed, and we
     * don't really expect the other end to even care about the cancellation.
     * For example, after initialization or self-verification.
     * @return {Promise} An array of `queueRoomKeyRequest` outputs.
     */
    cancelAndResendAllOutgoingRequests(): Promise<void[]>;
    private startTimer;
    private sendOutgoingRoomKeyRequests;
    private sendOutgoingRoomKeyRequest;
    private sendOutgoingRoomKeyRequestCancellation;
    private sendMessageToDevices;
}
//# sourceMappingURL=OutgoingRoomKeyRequestManager.d.ts.map