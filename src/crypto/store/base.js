/**
 * Internal module. Defintions for storage for the crypto module
 *
 * @module
 */

/**
 * Abstraction of things that can store data required for end-to-end encryption
 *
 * @interface CryptoStore
 */

/**
 * Represents an outgoing room key request
 *
 * @typedef {Object} OutgoingRoomKeyRequest
 *
 * @property {string} requestId    unique id for this request. Used for both
 *    an id within the request for later pairing with a cancellation, and for
 *    the transaction id when sending the to_device messages to our local
 *    server.
 *
 * @property {string?} cancellationTxnId
 *    transaction id for the cancellation, if any
 *
 * @property {Array<{userId: string, deviceId: string}>} recipients
 *    list of recipients for the request
 *
 * @property {module:crypto~RoomKeyRequestBody} requestBody
 *    parameters for the request.
 *
 * @property {Number} state   current state of this request (states are defined
 *    in {@link module:crypto/OutgoingRoomKeyRequestManager~ROOM_KEY_REQUEST_STATES})
 */
