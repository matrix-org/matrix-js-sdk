/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";
import { Emoji } from "@matrix-org/matrix-sdk-crypto-js";

import {
    ShowQrCodeCallbacks,
    ShowSasCallbacks,
    VerificationPhase,
    VerificationRequest,
    VerificationRequestEvent,
    VerificationRequestEventHandlerMap,
    Verifier,
    VerifierEvent,
    VerifierEventHandlerMap,
} from "../crypto-api/verification";
import { TypedEventEmitter } from "../models/typed-event-emitter";
import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";

/**
 * An incoming, or outgoing, request to verify a user or a device via cross-signing.
 */
export class RustVerificationRequest
    extends TypedEventEmitter<VerificationRequestEvent, VerificationRequestEventHandlerMap>
    implements VerificationRequest
{
    /** Are we in the process of sending an `m.key.verification.ready` event? */
    private _accepting = false;

    /** Are we in the process of sending an `m.key.verification.cancellation` event? */
    private _cancelling = false;

    private _verifier: Verifier | undefined;

    /**
     * Construct a new RustVerificationRequest to wrap the rust-level `VerificationRequest`.
     *
     * @param inner - VerificationRequest from the Rust SDK
     * @param outgoingRequestProcessor - `OutgoingRequestProcessor` to use for making outgoing HTTP requests
     * @param supportedVerificationMethods - Verification methods to use when `accept()` is called
     */
    public constructor(
        private readonly inner: RustSdkCryptoJs.VerificationRequest,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
        private readonly supportedVerificationMethods: string[] | undefined,
    ) {
        super();

        const onChange = async (): Promise<void> => {
            // if we now have a `Verification` where we lacked one before, wrap it.
            // TODO: QR support
            if (this._verifier === undefined) {
                const verification: RustSdkCryptoJs.Qr | RustSdkCryptoJs.Sas | undefined = this.inner.getVerification();
                if (verification instanceof RustSdkCryptoJs.Sas) {
                    this._verifier = new RustSASVerifier(verification, this, outgoingRequestProcessor);
                }
            }

            this.emit(VerificationRequestEvent.Change);
        };
        inner.registerChangesCallback(onChange);
    }

    /**
     * Unique ID for this verification request.
     *
     * An ID isn't assigned until the first message is sent, so this may be `undefined` in the early phases.
     */
    public get transactionId(): string | undefined {
        return this.inner.flowId;
    }

    /**
     * For an in-room verification, the ID of the room.
     *
     * For to-device verifications, `undefined`.
     */
    public get roomId(): string | undefined {
        return this.inner.roomId?.toString();
    }

    /**
     * True if this request was initiated by the local client.
     *
     * For in-room verifications, the initiator is who sent the `m.key.verification.request` event.
     * For to-device verifications, the initiator is who sent the `m.key.verification.start` event.
     */
    public get initiatedByMe(): boolean {
        return this.inner.weStarted();
    }

    /** The user id of the other party in this request */
    public get otherUserId(): string {
        return this.inner.otherUserId.toString();
    }

    /** For verifications via to-device messages: the ID of the other device. Otherwise, undefined. */
    public get otherDeviceId(): string | undefined {
        return this.inner.otherDeviceId?.toString();
    }

    /** True if the other party in this request is one of this user's own devices. */
    public get isSelfVerification(): boolean {
        return this.inner.isSelfVerification();
    }

    /** current phase of the request. */
    public get phase(): VerificationPhase {
        const phase = this.inner.phase();

        switch (phase) {
            case RustSdkCryptoJs.VerificationRequestPhase.Created:
            case RustSdkCryptoJs.VerificationRequestPhase.Requested:
                return VerificationPhase.Requested;
            case RustSdkCryptoJs.VerificationRequestPhase.Ready:
                // if we're still sending the `m.key.verification.ready`, that counts as "Requested" in the js-sdk's
                // parlance.
                return this._accepting ? VerificationPhase.Requested : VerificationPhase.Ready;
            case RustSdkCryptoJs.VerificationRequestPhase.Transitioned:
                return VerificationPhase.Started;
            case RustSdkCryptoJs.VerificationRequestPhase.Done:
                return VerificationPhase.Done;
            case RustSdkCryptoJs.VerificationRequestPhase.Cancelled:
                return VerificationPhase.Cancelled;
        }

        throw new Error(`Unknown verification phase ${phase}`);
    }

    /** True if the request has sent its initial event and needs more events to complete
     * (ie it is in phase `Requested`, `Ready` or `Started`).
     */
    public get pending(): boolean {
        if (this.inner.isPassive()) return false;
        const phase = this.phase;
        return phase !== VerificationPhase.Done && phase !== VerificationPhase.Cancelled;
    }

    /**
     * True if we have started the process of sending an `m.key.verification.ready` (but have not necessarily received
     * the remote echo which causes a transition to {@link VerificationPhase.Ready}.
     */
    public get accepting(): boolean {
        return this._accepting;
    }

    /**
     * True if we have started the process of sending an `m.key.verification.cancel` (but have not necessarily received
     * the remote echo which causes a transition to {@link VerificationPhase.Cancelled}).
     */
    public get declining(): boolean {
        return this._cancelling;
    }

    /**
     * The remaining number of ms before the request will be automatically cancelled.
     *
     * `null` indicates that there is no timeout
     */
    public get timeout(): number | null {
        return this.inner.timeRemainingMillis();
    }

    /** once the phase is Started (and !initiatedByMe) or Ready: common methods supported by both sides */
    public get methods(): string[] {
        throw new Error("not implemented");
    }

    /** the method picked in the .start event */
    public get chosenMethod(): string | null {
        const verification: RustSdkCryptoJs.Qr | RustSdkCryptoJs.Sas | undefined = this.inner.getVerification();
        // TODO: this isn't quite right. The existence of a Verification doesn't prove that we have .started.
        if (verification instanceof RustSdkCryptoJs.Sas) {
            return "m.sas.v1";
        } else {
            return null;
        }
    }

    /**
     * Checks whether the other party supports a given verification method.
     * This is useful when setting up the QR code UI, as it is somewhat asymmetrical:
     * if the other party supports SCAN_QR, we should show a QR code in the UI, and vice versa.
     * For methods that need to be supported by both ends, use the `methods` property.
     *
     * @param method - the method to check
     * @returns true if the other party said they supported the method
     */
    public otherPartySupportsMethod(method: string): boolean {
        const theirMethods: RustSdkCryptoJs.VerificationMethod[] | undefined = this.inner.theirSupportedMethods;
        if (theirMethods === undefined) {
            // no message from the other side yet
            return false;
        }

        const requiredMethod = verificationMethodsByIdentifier[method];
        return theirMethods.some((m) => m === requiredMethod);
    }

    /**
     * Accepts the request, sending a .ready event to the other party
     *
     * @returns Promise which resolves when the event has been sent.
     */
    public async accept(): Promise<void> {
        if (this.inner.phase() !== RustSdkCryptoJs.VerificationRequestPhase.Requested || this._accepting) {
            throw new Error(`Cannot accept a verification request in phase ${this.phase}`);
        }

        this._accepting = true;
        try {
            const req: undefined | OutgoingRequest =
                this.supportedVerificationMethods === undefined
                    ? this.inner.accept()
                    : this.inner.acceptWithMethods(
                          this.supportedVerificationMethods.map(verificationMethodIdentifierToMethod),
                      );
            if (req) {
                await this.outgoingRequestProcessor.makeOutgoingRequest(req);
            }
        } finally {
            this._accepting = false;
        }

        // phase may have changed, so emit a 'change' event
        this.emit(VerificationRequestEvent.Change);
    }

    /**
     * Cancels the request, sending a cancellation to the other party
     *
     * @param params - Details for the cancellation, including `reason` (defaults to "User declined"), and `code`
     *    (defaults to `m.user`).
     *
     * @returns Promise which resolves when the event has been sent.
     */
    public async cancel(params?: { reason?: string; code?: string }): Promise<void> {
        if (this._cancelling) {
            // already cancelling; do nothing
            return;
        }

        this._cancelling = true;
        try {
            const req: undefined | OutgoingRequest = this.inner.cancel();
            if (req) {
                await this.outgoingRequestProcessor.makeOutgoingRequest(req);
            }
        } finally {
            this._cancelling = false;
        }
    }

    /**
     * Create a {@link Verifier} to do this verification via a particular method.
     *
     * If a verifier has already been created for this request, returns that verifier.
     *
     * This does *not* send the `m.key.verification.start` event - to do so, call {@link Verifier#verifier} on the
     * returned verifier.
     *
     * If no previous events have been sent, pass in `targetDevice` to set who to direct this request to.
     *
     * @param method - the name of the verification method to use.
     * @param targetDevice - details of where to send the request to.
     *
     * @returns The verifier which will do the actual verification.
     */
    public beginKeyVerification(method: string, targetDevice?: { userId?: string; deviceId?: string }): Verifier {
        throw new Error("not implemented");
    }

    /**
     * Send an `m.key.verification.start` event to start verification via a particular method.
     *
     * Implementation of {@link Crypto.VerificationRequest#startVerification}.
     *
     * @param method - the name of the verification method to use.
     */
    public async startVerification(method: string): Promise<Verifier> {
        if (method !== "m.sas.v1") {
            throw new Error(`Unsupported verification method ${method}`);
        }

        const res:
            | [RustSdkCryptoJs.Sas, RustSdkCryptoJs.RoomMessageRequest | RustSdkCryptoJs.ToDeviceRequest]
            | undefined = await this.inner.startSas();

        if (res) {
            const [, req] = res;
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }

        // this should have triggered the onChange callback, and we should now have a verifier
        if (!this._verifier) {
            throw new Error("Still no verifier after startSas() call");
        }

        return this._verifier;
    }

    /**
     * The verifier which is doing the actual verification, once the method has been established.
     * Only defined when the `phase` is Started.
     */
    public get verifier(): Verifier | undefined {
        return this._verifier;
    }

    /**
     * Stub implementation of {@link Crypto.VerificationRequest#getQRCodeBytes}.
     */
    public getQRCodeBytes(): Buffer | undefined {
        // TODO
        return undefined;
    }

    /**
     * Generate the data for a QR code allowing the other device to verify this one, if it supports it.
     *
     * Implementation of {@link Crypto.VerificationRequest#generateQRCode}.
     */
    public async generateQRCode(): Promise<Buffer | undefined> {
        // TODO
        return undefined;
    }

    /**
     * If this request has been cancelled, the cancellation code (e.g `m.user`) which is responsible for cancelling
     * this verification.
     */
    public get cancellationCode(): string | null {
        throw new Error("not implemented");
    }

    /**
     * The id of the user that cancelled the request.
     *
     * Only defined when phase is Cancelled
     */
    public get cancellingUserId(): string | undefined {
        throw new Error("not implemented");
    }
}

export class RustSASVerifier extends TypedEventEmitter<VerifierEvent, VerifierEventHandlerMap> implements Verifier {
    /** A promise which completes when the verification completes (or rejects when it is cancelled/fails) */
    private readonly completionPromise: Promise<void>;

    private callbacks: ShowSasCallbacks | null = null;

    public constructor(
        private readonly inner: RustSdkCryptoJs.Sas,
        _verificationRequest: RustVerificationRequest,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {
        super();

        this.completionPromise = new Promise<void>((resolve, reject) => {
            const onChange = async (): Promise<void> => {
                this.updateCallbacks();

                if (this.inner.isDone()) {
                    resolve(undefined);
                } else if (this.inner.isCancelled()) {
                    const cancelInfo = this.inner.cancelInfo()!;
                    reject(
                        new Error(
                            `Verification cancelled by ${
                                cancelInfo.cancelledbyUs() ? "us" : "them"
                            } with code ${cancelInfo.cancelCode()}: ${cancelInfo.reason()}`,
                        ),
                    );
                }
            };
            inner.registerChangesCallback(onChange);
        });
        // stop the runtime complaining if nobody catches a failure
        this.completionPromise.catch(() => null);
    }

    /** if we can now show the callbacks, do so */
    private updateCallbacks(): void {
        if (this.callbacks === null) {
            const emoji: Array<Emoji> | undefined = this.inner.emoji();
            const decimal = this.inner.decimals() as [number, number, number] | undefined;

            if (emoji === undefined && decimal === undefined) {
                return;
            }

            this.callbacks = {
                sas: {
                    decimal: decimal,
                    emoji: emoji?.map((e) => [e.symbol, e.description]),
                },
                confirm: async (): Promise<void> => {
                    const requests: Array<OutgoingRequest> = await this.inner.confirm();
                    for (const m of requests) {
                        await this.outgoingRequestProcessor.makeOutgoingRequest(m);
                    }
                },
                mismatch: (): void => {
                    throw new Error("impl");
                },
                cancel: (): void => {
                    throw new Error("impl");
                },
            };
            this.emit(VerifierEvent.ShowSas, this.callbacks);
        }
    }

    /**
     * Returns true if the verification has been cancelled, either by us or the other side.
     */
    public get hasBeenCancelled(): boolean {
        return this.inner.isCancelled();
    }

    /**
     * The ID of the other user in the verification process.
     */
    public get userId(): string {
        return this.inner.otherUserId.toString();
    }

    /**
     * Start the key verification, if it has not already been started.
     *
     * This means sending a `m.key.verification.start` if we are the first responder, or a `m.key.verification.accept`
     * if the other side has already sent a start event.
     *
     * @returns Promise which resolves when the verification has completed, or rejects if the verification is cancelled
     *    or times out.
     */
    public async verify(): Promise<void> {
        const req: undefined | OutgoingRequest = this.inner.accept();
        if (req) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }
        await this.completionPromise;
    }

    /**
     * Cancel a verification.
     *
     * We will send an `m.key.verification.cancel` if the verification is still in flight. The verification promise
     * will reject, and a {@link Crypto.VerifierEvent#Cancel} will be emitted.
     *
     * @param e - the reason for the cancellation.
     */
    public cancel(e: Error): void {
        // TODO: something with `e`
        const req: undefined | OutgoingRequest = this.inner.cancel();
        if (req) {
            this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }
    }

    /**
     * Get the details for an SAS verification, if one is in progress
     *
     * Returns `null`, unless this verifier is for a SAS-based verification and we are waiting for the user to confirm
     * the SAS matches.
     */
    public getShowSasCallbacks(): ShowSasCallbacks | null {
        return this.callbacks;
    }

    /**
     * Get the details for reciprocating QR code verification, if one is in progress
     *
     * Returns `null`, unless this verifier is for reciprocating a QR-code-based verification (ie, the other user has
     * already scanned our QR code), and we are waiting for the user to confirm.
     */
    public getReciprocateQrCodeCallbacks(): ShowQrCodeCallbacks | null {
        return null;
    }
}

/** For each specced verification method, the rust-side `VerificationMethod` corresponding to it */
const verificationMethodsByIdentifier: Record<string, RustSdkCryptoJs.VerificationMethod> = {
    "m.sas.v1": RustSdkCryptoJs.VerificationMethod.SasV1,
    "m.qr_code.scan.v1": RustSdkCryptoJs.VerificationMethod.QrCodeScanV1,
    "m.qr_code.show.v1": RustSdkCryptoJs.VerificationMethod.QrCodeShowV1,
    "m.reciprocate.v1": RustSdkCryptoJs.VerificationMethod.ReciprocateV1,
};

/**
 * Convert a specced verification method identifier into a rust-side `VerificationMethod`.
 *
 * @param method - specced method identifier, for example `m.sas.v1`.
 * @returns Rust-side `VerificationMethod` corresponding to `method`.
 * @throws An error if the method is unknown.
 */
export function verificationMethodIdentifierToMethod(method: string): RustSdkCryptoJs.VerificationMethod {
    const meth = verificationMethodsByIdentifier[method];
    if (meth === undefined) {
        throw new Error(`Unknown verification method ${method}`);
    }
    return meth;
}
