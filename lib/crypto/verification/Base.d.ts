/// <reference types="node" />
/**
 * Base class for verification methods.
 * @module crypto/verification/Base
 */
import { MatrixEvent } from '../../models/event';
import { EventEmitter } from 'events';
import { DeviceInfo } from '../deviceinfo';
import { KeysDuringVerification } from "../CrossSigning";
import { IVerificationChannel } from "./request/Channel";
import { MatrixClient } from "../../client";
import { VerificationRequest } from "./request/VerificationRequest";
export declare class SwitchStartEventError extends Error {
    readonly startEvent: MatrixEvent;
    constructor(startEvent: MatrixEvent);
}
export declare type KeyVerifier = (keyId: string, device: DeviceInfo, keyInfo: string) => void;
export declare class VerificationBase extends EventEmitter {
    readonly channel: IVerificationChannel;
    readonly baseApis: MatrixClient;
    readonly userId: string;
    readonly deviceId: string;
    startEvent: MatrixEvent;
    readonly request: VerificationRequest;
    private cancelled;
    private _done;
    private promise;
    private transactionTimeoutTimer;
    protected expectedEvent: string;
    private resolve;
    private reject;
    private resolveEvent;
    private rejectEvent;
    private started;
    /**
     * Base class for verification methods.
     *
     * <p>Once a verifier object is created, the verification can be started by
     * calling the verify() method, which will return a promise that will
     * resolve when the verification is completed, or reject if it could not
     * complete.</p>
     *
     * <p>Subclasses must have a NAME class property.</p>
     *
     * @class
     *
     * @param {Object} channel the verification channel to send verification messages over.
     * TODO: Channel types
     *
     * @param {MatrixClient} baseApis base matrix api interface
     *
     * @param {string} userId the user ID that is being verified
     *
     * @param {string} deviceId the device ID that is being verified
     *
     * @param {object} [startEvent] the m.key.verification.start event that
     * initiated this verification, if any
     *
     * @param {object} [request] the key verification request object related to
     * this verification, if any
     */
    constructor(channel: IVerificationChannel, baseApis: MatrixClient, userId: string, deviceId: string, startEvent: MatrixEvent, request: VerificationRequest);
    get initiatedByMe(): boolean;
    get hasBeenCancelled(): boolean;
    private resetTimer;
    private endTimer;
    protected send(type: string, uncompletedContent: Record<string, any>): Promise<void>;
    protected waitForEvent(type: string): Promise<MatrixEvent>;
    canSwitchStartEvent(event: MatrixEvent): boolean;
    switchStartEvent(event: MatrixEvent): void;
    handleEvent(e: MatrixEvent): void;
    done(): Promise<KeysDuringVerification | void>;
    cancel(e: Error | MatrixEvent): void;
    /**
     * Begin the key verification
     *
     * @returns {Promise} Promise which resolves when the verification has
     *     completed.
     */
    verify(): Promise<void>;
    protected doVerification?: () => Promise<void>;
    protected verifyKeys(userId: string, keys: Record<string, string>, verifier: KeyVerifier): Promise<void>;
    get events(): string[] | undefined;
}
//# sourceMappingURL=Base.d.ts.map