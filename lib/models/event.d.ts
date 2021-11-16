/// <reference types="node" />
/**
 * This is an internal module. See {@link MatrixEvent} and {@link RoomEvent} for
 * the public classes.
 * @module models/event
 */
import { EventEmitter } from 'events';
import { VerificationRequest } from "../crypto/verification/request/VerificationRequest";
import { EventType, MsgType, RelationType } from "../@types/event";
import { Crypto } from "../crypto";
import { RoomMember } from "./room-member";
import { Thread } from "./thread";
import { IActionsObject } from '../pushprocessor';
/**
 * Enum for event statuses.
 * @readonly
 * @enum {string}
 */
export declare enum EventStatus {
    /** The event was not sent and will no longer be retried. */
    NOT_SENT = "not_sent",
    /** The message is being encrypted */
    ENCRYPTING = "encrypting",
    /** The event is in the process of being sent. */
    SENDING = "sending",
    /** The event is in a queue waiting to be sent. */
    QUEUED = "queued",
    /** The event has been sent to the server, but we have not yet received the echo. */
    SENT = "sent",
    /** The event was cancelled before it was successfully sent. */
    CANCELLED = "cancelled"
}
export interface IContent {
    [key: string]: any;
    msgtype?: MsgType | string;
    membership?: string;
    avatar_url?: string;
    displayname?: string;
    "m.relates_to"?: IEventRelation;
}
declare type StrippedState = Required<Pick<IEvent, "content" | "state_key" | "type" | "sender">>;
export interface IUnsigned {
    age?: number;
    prev_sender?: string;
    prev_content?: IContent;
    redacted_because?: IEvent;
    transaction_id?: string;
    invite_room_state?: StrippedState[];
}
export interface IEvent {
    event_id: string;
    type: string;
    content: IContent;
    sender: string;
    room_id: string;
    origin_server_ts: number;
    txn_id?: string;
    state_key?: string;
    membership?: string;
    unsigned: IUnsigned;
    redacts?: string;
    user_id?: string;
    prev_content?: IContent;
    age?: number;
}
interface IAggregatedRelation {
    origin_server_ts: number;
    event_id?: string;
    sender?: string;
    type?: string;
    count?: number;
    key?: string;
}
export interface IEventRelation {
    rel_type: RelationType | string;
    event_id: string;
    key?: string;
}
export interface IClearEvent {
    type: string;
    content: Omit<IContent, "membership" | "avatar_url" | "displayname" | "m.relates_to">;
    unsigned?: IUnsigned;
}
interface IKeyRequestRecipient {
    userId: string;
    deviceId: "*" | string;
}
export interface IDecryptOptions {
    emit?: boolean;
    isRetry?: boolean;
}
export declare class MatrixEvent extends EventEmitter {
    event: Partial<IEvent>;
    private pushActions;
    private _replacingEvent;
    private _localRedactionEvent;
    private _isCancelled;
    private clearEvent?;
    private senderCurve25519Key;
    private claimedEd25519Key;
    private forwardingCurve25519KeyChain;
    private untrusted;
    private _decryptionPromise;
    private retryDecryption;
    private txnId;
    /**
     * @experimental
     * A reference to the thread this event belongs to
     */
    private thread;
    private readonly localTimestamp;
    sender: RoomMember;
    target: RoomMember;
    status: EventStatus;
    error: any;
    forwardLooking: boolean;
    verificationRequest: any;
    private readonly reEmitter;
    /**
     * Construct a Matrix Event object
     * @constructor
     *
     * @param {Object} event The raw event to be wrapped in this DAO
     *
     * @prop {Object} event The raw (possibly encrypted) event. <b>Do not access
     * this property</b> directly unless you absolutely have to. Prefer the getter
     * methods defined on this class. Using the getter methods shields your app
     * from changes to event JSON between Matrix versions.
     *
     * @prop {RoomMember} sender The room member who sent this event, or null e.g.
     * this is a presence event. This is only guaranteed to be set for events that
     * appear in a timeline, ie. do not guarantee that it will be set on state
     * events.
     * @prop {RoomMember} target The room member who is the target of this event, e.g.
     * the invitee, the person being banned, etc.
     * @prop {EventStatus} status The sending status of the event.
     * @prop {Error} error most recent error associated with sending the event, if any
     * @prop {boolean} forwardLooking True if this event is 'forward looking', meaning
     * that getDirectionalContent() will return event.content and not event.prev_content.
     * Default: true. <strong>This property is experimental and may change.</strong>
     */
    constructor(event?: Partial<IEvent>);
    /**
     * Gets the event as though it would appear unencrypted. If the event is already not
     * encrypted, it is simply returned as-is.
     * @returns {IEvent} The event in wire format.
     */
    getEffectiveEvent(): IEvent;
    /**
     * Get the event_id for this event.
     * @return {string} The event ID, e.g. <code>$143350589368169JsLZx:localhost
     * </code>
     */
    getId(): string;
    /**
     * Get the user_id for this event.
     * @return {string} The user ID, e.g. <code>@alice:matrix.org</code>
     */
    getSender(): string;
    /**
     * Get the (decrypted, if necessary) type of event.
     *
     * @return {string} The event type, e.g. <code>m.room.message</code>
     */
    getType(): EventType | string;
    /**
     * Get the (possibly encrypted) type of the event that will be sent to the
     * homeserver.
     *
     * @return {string} The event type.
     */
    getWireType(): EventType | string;
    /**
     * Get the room_id for this event. This will return <code>undefined</code>
     * for <code>m.presence</code> events.
     * @return {string} The room ID, e.g. <code>!cURbafjkfsMDVwdRDQ:matrix.org
     * </code>
     */
    getRoomId(): string;
    /**
     * Get the timestamp of this event.
     * @return {Number} The event timestamp, e.g. <code>1433502692297</code>
     */
    getTs(): number;
    /**
     * Get the timestamp of this event, as a Date object.
     * @return {Date} The event date, e.g. <code>new Date(1433502692297)</code>
     */
    getDate(): Date | null;
    /**
     * Get the (decrypted, if necessary) event content JSON, even if the event
     * was replaced by another event.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getOriginalContent<T = IContent>(): T;
    /**
     * Get the (decrypted, if necessary) event content JSON,
     * or the content from the replacing event, if any.
     * See `makeReplaced`.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getContent<T = IContent>(): T;
    /**
     * Get the (possibly encrypted) event content JSON that will be sent to the
     * homeserver.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getWireContent(): IContent;
    /**
     * @experimental
     * Get the event ID of the thread head
     */
    get threadRootId(): string;
    /**
     * @experimental
     */
    get isThreadRelation(): boolean;
    /**
     * @experimental
     */
    get isThreadRoot(): boolean;
    get parentEventId(): string;
    get replyEventId(): string;
    /**
     * Get the previous event content JSON. This will only return something for
     * state events which exist in the timeline.
     * @return {Object} The previous event content JSON, or an empty object.
     */
    getPrevContent(): IContent;
    /**
     * Get either 'content' or 'prev_content' depending on if this event is
     * 'forward-looking' or not. This can be modified via event.forwardLooking.
     * In practice, this means we get the chronologically earlier content value
     * for this event (this method should surely be called getEarlierContent)
     * <strong>This method is experimental and may change.</strong>
     * @return {Object} event.content if this event is forward-looking, else
     * event.prev_content.
     */
    getDirectionalContent(): IContent;
    /**
     * Get the age of this event. This represents the age of the event when the
     * event arrived at the device, and not the age of the event when this
     * function was called.
     * @return {Number} The age of this event in milliseconds.
     */
    getAge(): number;
    /**
     * Get the age of the event when this function was called.
     * This is the 'age' field adjusted according to how long this client has
     * had the event.
     * @return {Number} The age of this event in milliseconds.
     */
    getLocalAge(): number;
    /**
     * Get the event state_key if it has one. This will return <code>undefined
     * </code> for message events.
     * @return {string} The event's <code>state_key</code>.
     */
    getStateKey(): string | undefined;
    /**
     * Check if this event is a state event.
     * @return {boolean} True if this is a state event.
     */
    isState(): boolean;
    /**
     * Replace the content of this event with encrypted versions.
     * (This is used when sending an event; it should not be used by applications).
     *
     * @internal
     *
     * @param {string} cryptoType type of the encrypted event - typically
     * <tt>"m.room.encrypted"</tt>
     *
     * @param {object} cryptoContent raw 'content' for the encrypted event.
     *
     * @param {string} senderCurve25519Key curve25519 key to record for the
     *   sender of this event.
     *   See {@link module:models/event.MatrixEvent#getSenderKey}.
     *
     * @param {string} claimedEd25519Key claimed ed25519 key to record for the
     *   sender if this event.
     *   See {@link module:models/event.MatrixEvent#getClaimedEd25519Key}
     */
    makeEncrypted(cryptoType: string, cryptoContent: object, senderCurve25519Key: string, claimedEd25519Key: string): void;
    /**
     * Check if this event is currently being decrypted.
     *
     * @return {boolean} True if this event is currently being decrypted, else false.
     */
    isBeingDecrypted(): boolean;
    getDecryptionPromise(): Promise<void>;
    /**
     * Check if this event is an encrypted event which we failed to decrypt
     *
     * (This implies that we might retry decryption at some point in the future)
     *
     * @return {boolean} True if this event is an encrypted event which we
     *     couldn't decrypt.
     */
    isDecryptionFailure(): boolean;
    shouldAttemptDecryption(): boolean;
    /**
     * Start the process of trying to decrypt this event.
     *
     * (This is used within the SDK: it isn't intended for use by applications)
     *
     * @internal
     *
     * @param {module:crypto} crypto crypto module
     * @param {object} options
     * @param {boolean} options.isRetry True if this is a retry (enables more logging)
     * @param {boolean} options.emit Emits "event.decrypted" if set to true
     *
     * @returns {Promise} promise which resolves (to undefined) when the decryption
     * attempt is completed.
     */
    attemptDecryption(crypto: Crypto, options?: IDecryptOptions): Promise<void>;
    /**
     * Cancel any room key request for this event and resend another.
     *
     * @param {module:crypto} crypto crypto module
     * @param {string} userId the user who received this event
     *
     * @returns {Promise} a promise that resolves when the request is queued
     */
    cancelAndResendKeyRequest(crypto: Crypto, userId: string): Promise<void>;
    /**
     * Calculate the recipients for keyshare requests.
     *
     * @param {string} userId the user who received this event.
     *
     * @returns {Array} array of recipients
     */
    getKeyRequestRecipients(userId: string): IKeyRequestRecipient[];
    private decryptionLoop;
    private badEncryptedMessage;
    /**
     * Update the cleartext data on this event.
     *
     * (This is used after decrypting an event; it should not be used by applications).
     *
     * @internal
     *
     * @fires module:models/event.MatrixEvent#"Event.decrypted"
     *
     * @param {module:crypto~EventDecryptionResult} decryptionResult
     *     the decryption result, including the plaintext and some key info
     */
    private setClearData;
    /**
     * Gets the cleartext content for this event. If the event is not encrypted,
     * or encryption has not been completed, this will return null.
     *
     * @returns {Object} The cleartext (decrypted) content for the event
     */
    getClearContent(): IContent | null;
    /**
     * Check if the event is encrypted.
     * @return {boolean} True if this event is encrypted.
     */
    isEncrypted(): boolean;
    /**
     * The curve25519 key for the device that we think sent this event
     *
     * For an Olm-encrypted event, this is inferred directly from the DH
     * exchange at the start of the session: the curve25519 key is involved in
     * the DH exchange, so only a device which holds the private part of that
     * key can establish such a session.
     *
     * For a megolm-encrypted event, it is inferred from the Olm message which
     * established the megolm session
     *
     * @return {string}
     */
    getSenderKey(): string | null;
    /**
     * The additional keys the sender of this encrypted event claims to possess.
     *
     * Just a wrapper for #getClaimedEd25519Key (q.v.)
     *
     * @return {Object<string, string>}
     */
    getKeysClaimed(): Record<"ed25519", string>;
    /**
     * Get the ed25519 the sender of this event claims to own.
     *
     * For Olm messages, this claim is encoded directly in the plaintext of the
     * event itself. For megolm messages, it is implied by the m.room_key event
     * which established the megolm session.
     *
     * Until we download the device list of the sender, it's just a claim: the
     * device list gives a proof that the owner of the curve25519 key used for
     * this event (and returned by #getSenderKey) also owns the ed25519 key by
     * signing the public curve25519 key with the ed25519 key.
     *
     * In general, applications should not use this method directly, but should
     * instead use MatrixClient.getEventSenderDeviceInfo.
     *
     * @return {string}
     */
    getClaimedEd25519Key(): string | null;
    /**
     * Get the curve25519 keys of the devices which were involved in telling us
     * about the claimedEd25519Key and sender curve25519 key.
     *
     * Normally this will be empty, but in the case of a forwarded megolm
     * session, the sender keys are sent to us by another device (the forwarding
     * device), which we need to trust to do this. In that case, the result will
     * be a list consisting of one entry.
     *
     * If the device that sent us the key (A) got it from another device which
     * it wasn't prepared to vouch for (B), the result will be [A, B]. And so on.
     *
     * @return {string[]} base64-encoded curve25519 keys, from oldest to newest.
     */
    getForwardingCurve25519KeyChain(): string[];
    /**
     * Whether the decryption key was obtained from an untrusted source. If so,
     * we cannot verify the authenticity of the message.
     *
     * @return {boolean}
     */
    isKeySourceUntrusted(): boolean;
    getUnsigned(): IUnsigned;
    unmarkLocallyRedacted(): boolean;
    markLocallyRedacted(redactionEvent: MatrixEvent): void;
    /**
     * Update the content of an event in the same way it would be by the server
     * if it were redacted before it was sent to us
     *
     * @param {module:models/event.MatrixEvent} redactionEvent
     *     event causing the redaction
     */
    makeRedacted(redactionEvent: MatrixEvent): void;
    /**
     * Check if this event has been redacted
     *
     * @return {boolean} True if this event has been redacted
     */
    isRedacted(): boolean;
    /**
     * Check if this event is a redaction of another event
     *
     * @return {boolean} True if this event is a redaction
     */
    isRedaction(): boolean;
    /**
     * Get the (decrypted, if necessary) redaction event JSON
     * if event was redacted
     *
     * @returns {object} The redaction event JSON, or an empty object
     */
    getRedactionEvent(): object | null;
    /**
     * Get the push actions, if known, for this event
     *
     * @return {?Object} push actions
     */
    getPushActions(): IActionsObject | null;
    /**
     * Set the push actions for this event.
     *
     * @param {Object} pushActions push actions
     */
    setPushActions(pushActions: IActionsObject): void;
    /**
     * Replace the `event` property and recalculate any properties based on it.
     * @param {Object} event the object to assign to the `event` property
     */
    handleRemoteEcho(event: object): void;
    /**
     * Whether the event is in any phase of sending, send failure, waiting for
     * remote echo, etc.
     *
     * @return {boolean}
     */
    isSending(): boolean;
    /**
     * Update the event's sending status and emit an event as well.
     *
     * @param {String} status The new status
     */
    setStatus(status: EventStatus): void;
    replaceLocalEventId(eventId: string): void;
    /**
     * Get whether the event is a relation event, and of a given type if
     * `relType` is passed in.
     *
     * @param {string?} relType if given, checks that the relation is of the
     * given type
     * @return {boolean}
     */
    isRelation(relType?: string): boolean;
    /**
     * Get relation info for the event, if any.
     *
     * @return {Object}
     */
    getRelation(): IEventRelation | null;
    /**
     * Set an event that replaces the content of this event, through an m.replace relation.
     *
     * @fires module:models/event.MatrixEvent#"Event.replaced"
     *
     * @param {MatrixEvent?} newEvent the event with the replacing content, if any.
     */
    makeReplaced(newEvent?: MatrixEvent): void;
    /**
     * Returns the status of any associated edit or redaction
     * (not for reactions/annotations as their local echo doesn't affect the original event),
     * or else the status of the event.
     *
     * @return {EventStatus}
     */
    getAssociatedStatus(): EventStatus | undefined;
    getServerAggregatedRelation(relType: RelationType): IAggregatedRelation;
    /**
     * Returns the event ID of the event replacing the content of this event, if any.
     *
     * @return {string?}
     */
    replacingEventId(): string | undefined;
    /**
     * Returns the event replacing the content of this event, if any.
     * Replacements are aggregated on the server, so this would only
     * return an event in case it came down the sync, or for local echo of edits.
     *
     * @return {MatrixEvent?}
     */
    replacingEvent(): MatrixEvent | undefined;
    /**
     * Returns the origin_server_ts of the event replacing the content of this event, if any.
     *
     * @return {Date?}
     */
    replacingEventDate(): Date | undefined;
    /**
     * Returns the event that wants to redact this event, but hasn't been sent yet.
     * @return {MatrixEvent} the event
     */
    localRedactionEvent(): MatrixEvent | undefined;
    /**
     * For relations and redactions, returns the event_id this event is referring to.
     *
     * @return {string?}
     */
    getAssociatedId(): string | undefined;
    /**
     * Checks if this event is associated with another event. See `getAssociatedId`.
     *
     * @return {boolean}
     */
    hasAssocation(): boolean;
    /**
     * Update the related id with a new one.
     *
     * Used to replace a local id with remote one before sending
     * an event with a related id.
     *
     * @param {string} eventId the new event id
     */
    updateAssociatedId(eventId: string): void;
    /**
     * Flags an event as cancelled due to future conditions. For example, a verification
     * request event in the same sync transaction may be flagged as cancelled to warn
     * listeners that a cancellation event is coming down the same pipe shortly.
     * @param {boolean} cancelled Whether the event is to be cancelled or not.
     */
    flagCancelled(cancelled?: boolean): void;
    /**
     * Gets whether or not the event is flagged as cancelled. See flagCancelled() for
     * more information.
     * @returns {boolean} True if the event is cancelled, false otherwise.
     */
    isCancelled(): boolean;
    /**
     * Get a copy/snapshot of this event. The returned copy will be loosely linked
     * back to this instance, though will have "frozen" event information. Other
     * properties of this MatrixEvent instance will be copied verbatim, which can
     * mean they are in reference to this instance despite being on the copy too.
     * The reference the snapshot uses does not change, however members aside from
     * the underlying event will not be deeply cloned, thus may be mutated internally.
     * For example, the sender profile will be copied over at snapshot time, and
     * the sender profile internally may mutate without notice to the consumer.
     *
     * This is meant to be used to snapshot the event details themselves, not the
     * features (such as sender) surrounding the event.
     * @returns {MatrixEvent} A snapshot of this event.
     */
    toSnapshot(): MatrixEvent;
    /**
     * Determines if this event is equivalent to the given event. This only checks
     * the event object itself, not the other properties of the event. Intended for
     * use with toSnapshot() to identify events changing.
     * @param {MatrixEvent} otherEvent The other event to check against.
     * @returns {boolean} True if the events are the same, false otherwise.
     */
    isEquivalentTo(otherEvent: MatrixEvent): boolean;
    /**
     * Summarise the event as JSON. This is currently used by React SDK's view
     * event source feature and Seshat's event indexing, so take care when
     * adjusting the output here.
     *
     * If encrypted, include both the decrypted and encrypted view of the event.
     *
     * This is named `toJSON` for use with `JSON.stringify` which checks objects
     * for functions named `toJSON` and will call them to customise the output
     * if they are defined.
     *
     * @return {Object}
     */
    toJSON(): object;
    setVerificationRequest(request: VerificationRequest): void;
    setTxnId(txnId: string): void;
    getTxnId(): string | undefined;
    /**
     * @experimental
     */
    setThread(thread: Thread): void;
    /**
     * @experimental
     */
    getThread(): Thread;
}
export {};
/**
 * Fires when an event is decrypted
 *
 * @event module:models/event.MatrixEvent#"Event.decrypted"
 *
 * @param {module:models/event.MatrixEvent} event
 *    The matrix event which has been decrypted
 * @param {module:crypto/algorithms/base.DecryptionError?} err
 *    The error that occurred during decryption, or `undefined` if no
 *    error occurred.
 */
//# sourceMappingURL=event.d.ts.map