import { VerificationRequest } from "./VerificationRequest";
import { IVerificationChannel } from "./Channel";
import { MatrixClient } from "../../../client";
import { MatrixEvent } from "../../../models/event";
/**
 * A key verification channel that sends verification events in the timeline of a room.
 * Uses the event id of the initial m.key.verification.request event as a transaction id.
 */
export declare class InRoomChannel implements IVerificationChannel {
    private readonly client;
    readonly roomId: string;
    userId: string;
    private requestEventId;
    /**
     * @param {MatrixClient} client the matrix client, to send messages with and get current user & device from.
     * @param {string} roomId id of the room where verification events should be posted in, should be a DM with the given user.
     * @param {string} userId id of user that the verification request is directed at, should be present in the room.
     */
    constructor(client: MatrixClient, roomId: string, userId?: string);
    get receiveStartFromOtherDevices(): boolean;
    /** The transaction id generated/used by this verification channel */
    get transactionId(): string;
    static getOtherPartyUserId(event: MatrixEvent, client: MatrixClient): string;
    /**
     * @param {MatrixEvent} event the event to get the timestamp of
     * @return {number} the timestamp when the event was sent
     */
    getTimestamp(event: MatrixEvent): number;
    /**
     * Checks whether the given event type should be allowed to initiate a new VerificationRequest over this channel
     * @param {string} type the event type to check
     * @returns {boolean} boolean flag
     */
    static canCreateRequest(type: string): boolean;
    canCreateRequest(type: string): boolean;
    /**
     * Extract the transaction id used by a given key verification event, if any
     * @param {MatrixEvent} event the event
     * @returns {string} the transaction id
     */
    static getTransactionId(event: MatrixEvent): string;
    /**
     * Checks whether this event is a well-formed key verification event.
     * This only does checks that don't rely on the current state of a potentially already channel
     * so we can prevent channels being created by invalid events.
     * `handleEvent` can do more checks and choose to ignore invalid events.
     * @param {MatrixEvent} event the event to validate
     * @param {MatrixClient} client the client to get the current user and device id from
     * @returns {boolean} whether the event is valid and should be passed to handleEvent
     */
    static validateEvent(event: MatrixEvent, client: MatrixClient): boolean;
    /**
     * As m.key.verification.request events are as m.room.message events with the InRoomChannel
     * to have a fallback message in non-supporting clients, we map the real event type
     * to the symbolic one to keep things in unison with ToDeviceChannel
     * @param {MatrixEvent} event the event to get the type of
     * @returns {string} the "symbolic" event type
     */
    static getEventType(event: MatrixEvent): string;
    /**
     * Changes the state of the channel, request, and verifier in response to a key verification event.
     * @param {MatrixEvent} event to handle
     * @param {VerificationRequest} request the request to forward handling to
     * @param {boolean} isLiveEvent whether this is an even received through sync or not
     * @returns {Promise} a promise that resolves when any requests as an answer to the passed-in event are sent.
     */
    handleEvent(event: MatrixEvent, request: VerificationRequest, isLiveEvent?: boolean): Promise<void>;
    /**
     * Adds the transaction id (relation) back to a received event
     * so it has the same format as returned by `completeContent` before sending.
     * The relation can not appear on the event content because of encryption,
     * relations are excluded from encryption.
     * @param {MatrixEvent} event the received event
     * @returns {Object} the content object with the relation added again
     */
    completedContentFromEvent(event: MatrixEvent): Record<string, any>;
    /**
     * Add all the fields to content needed for sending it over this channel.
     * This is public so verification methods (SAS uses this) can get the exact
     * content that will be sent independent of the used channel,
     * as they need to calculate the hash of it.
     * @param {string} type the event type
     * @param {object} content the (incomplete) content
     * @returns {object} the complete content, as it will be sent.
     */
    completeContent(type: string, content: Record<string, any>): Record<string, any>;
    /**
     * Send an event over the channel with the content not having gone through `completeContent`.
     * @param {string} type the event type
     * @param {object} uncompletedContent the (incomplete) content
     * @returns {Promise} the promise of the request
     */
    send(type: string, uncompletedContent: Record<string, any>): Promise<void>;
    /**
     * Send an event over the channel with the content having gone through `completeContent` already.
     * @param {string} type the event type
     * @param {object} content
     * @returns {Promise} the promise of the request
     */
    sendCompleted(type: string, content: Record<string, any>): Promise<void>;
}
export declare class InRoomRequests {
    private requestsByRoomId;
    getRequest(event: MatrixEvent): VerificationRequest;
    getRequestByChannel(channel: InRoomChannel): VerificationRequest;
    private getRequestByTxnId;
    setRequest(event: MatrixEvent, request: VerificationRequest): void;
    setRequestByChannel(channel: InRoomChannel, request: VerificationRequest): void;
    private doSetRequest;
    removeRequest(event: MatrixEvent): void;
    findRequestInProgress(roomId: string): VerificationRequest;
}
//# sourceMappingURL=InRoomChannel.d.ts.map