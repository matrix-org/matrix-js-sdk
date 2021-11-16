/**
 * Internal module. Defines the base classes of the encryption implementations
 *
 * @module
 */
import { MatrixClient } from "../../client";
import { Room } from "../../models/room";
import { OlmDevice } from "../OlmDevice";
import { MatrixEvent, RoomMember } from "../..";
import { Crypto, IEventDecryptionResult, IMegolmSessionData, IncomingRoomKeyRequest } from "..";
import { DeviceInfo } from "../deviceinfo";
import { IRoomEncryption } from "../RoomList";
/**
 * map of registered encryption algorithm classes. A map from string to {@link
 * module:crypto/algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto/algorithms/base.EncryptionAlgorithm)>}
 */
export declare const ENCRYPTION_CLASSES: Record<string, new (params: IParams) => EncryptionAlgorithm>;
declare type DecryptionClassParams = Omit<IParams, "deviceId" | "config">;
/**
 * map of registered encryption algorithm classes. Map from string to {@link
 * module:crypto/algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto/algorithms/base.DecryptionAlgorithm)>}
 */
export declare const DECRYPTION_CLASSES: Record<string, new (params: DecryptionClassParams) => DecryptionAlgorithm>;
interface IParams {
    userId: string;
    deviceId: string;
    crypto: Crypto;
    olmDevice: OlmDevice;
    baseApis: MatrixClient;
    roomId: string;
    config: IRoomEncryption & object;
}
/**
 * base type for encryption implementations
 *
 * @alias module:crypto/algorithms/base.EncryptionAlgorithm
 *
 * @param {object} params parameters
 * @param {string} params.userId  The UserID for the local user
 * @param {string} params.deviceId The identifier for this device.
 * @param {module:crypto} params.crypto crypto core
 * @param {module:crypto/OlmDevice} params.olmDevice olm.js wrapper
 * @param {MatrixClient} baseApis base matrix api interface
 * @param {string} params.roomId  The ID of the room we will be sending to
 * @param {object} params.config  The body of the m.room.encryption event
 */
export declare abstract class EncryptionAlgorithm {
    protected readonly userId: string;
    protected readonly deviceId: string;
    protected readonly crypto: Crypto;
    protected readonly olmDevice: OlmDevice;
    protected readonly baseApis: MatrixClient;
    protected readonly roomId: string;
    constructor(params: IParams);
    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param {module:models/room} room the room the event is in
     */
    prepareToEncrypt(room: Room): void;
    /**
     * Encrypt a message event
     *
     * @method module:crypto/algorithms/base.EncryptionAlgorithm.encryptMessage
     * @public
     * @abstract
     *
     * @param {module:models/room} room
     * @param {string} eventType
     * @param {object} content event content
     *
     * @return {Promise} Promise which resolves to the new event body
     */
    abstract encryptMessage(room: Room, eventType: string, content: object): Promise<object>;
    /**
     * Called when the membership of a member of the room changes.
     *
     * @param {module:models/event.MatrixEvent} event  event causing the change
     * @param {module:models/room-member} member  user whose membership changed
     * @param {string=} oldMembership  previous membership
     * @public
     * @abstract
     */
    onRoomMembership(event: MatrixEvent, member: RoomMember, oldMembership?: string): void;
    reshareKeyWithDevice?(senderKey: string, sessionId: string, userId: string, device: DeviceInfo): Promise<void>;
    forceDiscardSession?(): void;
}
/**
 * base type for decryption implementations
 *
 * @alias module:crypto/algorithms/base.DecryptionAlgorithm
 * @param {object} params parameters
 * @param {string} params.userId  The UserID for the local user
 * @param {module:crypto} params.crypto crypto core
 * @param {module:crypto/OlmDevice} params.olmDevice olm.js wrapper
 * @param {MatrixClient} baseApis base matrix api interface
 * @param {string=} params.roomId The ID of the room we will be receiving
 *     from. Null for to-device events.
 */
export declare abstract class DecryptionAlgorithm {
    protected readonly userId: string;
    protected readonly crypto: Crypto;
    protected readonly olmDevice: OlmDevice;
    protected readonly baseApis: MatrixClient;
    protected readonly roomId: string;
    constructor(params: DecryptionClassParams);
    /**
     * Decrypt an event
     *
     * @method module:crypto/algorithms/base.DecryptionAlgorithm#decryptEvent
     * @abstract
     *
     * @param {MatrixEvent} event undecrypted event
     *
     * @return {Promise<module:crypto~EventDecryptionResult>} promise which
     * resolves once we have finished decrypting. Rejects with an
     * `algorithms.DecryptionError` if there is a problem decrypting the event.
     */
    abstract decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult>;
    /**
     * Handle a key event
     *
     * @method module:crypto/algorithms/base.DecryptionAlgorithm#onRoomKeyEvent
     *
     * @param {module:models/event.MatrixEvent} params event key event
     */
    onRoomKeyEvent(params: MatrixEvent): void;
    /**
     * Import a room key
     *
     * @param {module:crypto/OlmDevice.MegolmSessionData} session
     * @param {object} opts object
     */
    importRoomKey(session: IMegolmSessionData, opts: object): Promise<void>;
    /**
     * Determine if we have the keys necessary to respond to a room key request
     *
     * @param {module:crypto~IncomingRoomKeyRequest} keyRequest
     * @return {Promise<boolean>} true if we have the keys and could (theoretically) share
     *  them; else false.
     */
    hasKeysForKeyRequest(keyRequest: IncomingRoomKeyRequest): Promise<boolean>;
    /**
     * Send the response to a room key request
     *
     * @param {module:crypto~IncomingRoomKeyRequest} keyRequest
     */
    shareKeysWithDevice(keyRequest: IncomingRoomKeyRequest): void;
    /**
     * Retry decrypting all the events from a sender that haven't been
     * decrypted yet.
     *
     * @param {string} senderKey the sender's key
     */
    retryDecryptionFromSender(senderKey: string): Promise<boolean>;
    onRoomKeyWithheldEvent?(event: MatrixEvent): Promise<void>;
    sendSharedHistoryInboundSessions?(devicesByUser: Record<string, DeviceInfo[]>): Promise<void>;
}
/**
 * Exception thrown when decryption fails
 *
 * @alias module:crypto/algorithms/base.DecryptionError
 * @param {string} msg user-visible message describing the problem
 *
 * @param {Object=} details key/value pairs reported in the logs but not shown
 *   to the user.
 *
 * @extends Error
 */
export declare class DecryptionError extends Error {
    readonly code: string;
    readonly detailedString: string;
    constructor(code: string, msg: string, details?: Record<string, string>);
}
/**
 * Exception thrown specifically when we want to warn the user to consider
 * the security of their conversation before continuing
 *
 * @param {string} msg message describing the problem
 * @param {Object} devices userId -> {deviceId -> object}
 *      set of unknown devices per user we're warning about
 * @extends Error
 */
export declare class UnknownDeviceError extends Error {
    readonly devices: Record<string, Record<string, object>>;
    constructor(msg: string, devices: Record<string, Record<string, object>>);
}
/**
 * Registers an encryption/decryption class for a particular algorithm
 *
 * @param {string} algorithm algorithm tag to register for
 *
 * @param {class} encryptor {@link
 *     module:crypto/algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm}
 *     implementation
 *
 * @param {class} decryptor {@link
 *     module:crypto/algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm}
 *     implementation
 */
export declare function registerAlgorithm(algorithm: string, encryptor: new (params: IParams) => EncryptionAlgorithm, decryptor: new (params: Omit<IParams, "deviceId">) => DecryptionAlgorithm): void;
export {};
//# sourceMappingURL=base.d.ts.map