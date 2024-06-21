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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { QrState } from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    GeneratedSas,
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
import { TypedReEmitter } from "../ReEmitter";
import { MatrixEvent } from "../models/event";
import { EventType, MsgType } from "../@types/event";
import { defer, IDeferred } from "../utils";
import { VerificationMethod } from "../types";

/**
 * An incoming, or outgoing, request to verify a user or a device via cross-signing.
 *
 * @internal
 */
export class RustVerificationRequest
    extends TypedEventEmitter<VerificationRequestEvent, VerificationRequestEventHandlerMap>
    implements VerificationRequest
{
    /** a reëmitter which relays VerificationRequestEvent.Changed events emitted by the verifier */
    private readonly reEmitter: TypedReEmitter<VerificationRequestEvent, VerificationRequestEventHandlerMap>;

    /** Are we in the process of sending an `m.key.verification.ready` event? */
    private _accepting = false;

    /** Are we in the process of sending an `m.key.verification.cancellation` event? */
    private _cancelling = false;

    private _verifier: undefined | RustSASVerifier | RustQrCodeVerifier;

    /**
     * Construct a new RustVerificationRequest to wrap the rust-level `VerificationRequest`.
     *
     * @param olmMachine - The `OlmMachine` from the underlying rust crypto sdk.
     * @param inner - VerificationRequest from the Rust SDK.
     * @param outgoingRequestProcessor - `OutgoingRequestProcessor` to use for making outgoing HTTP requests.
     * @param supportedVerificationMethods - Verification methods to use when `accept()` is called.
     */
    public constructor(
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        private readonly inner: RustSdkCryptoJs.VerificationRequest,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
        private readonly supportedVerificationMethods: string[],
    ) {
        super();
        this.reEmitter = new TypedReEmitter(this);

        // Obviously, the Rust object maintains a reference to the callback function. If the callback function maintains
        // a reference to the Rust object, then we have a reference cycle which means that `RustVerificationRequest`
        // will never be garbage-collected, and hence the underlying rust object will never be freed.
        //
        // To avoid this reference cycle, use a weak reference in the callback function. If the `RustVerificationRequest`
        // gets garbage-collected, then there is nothing to update!
        const weakThis = new WeakRef(this);
        inner.registerChangesCallback(async () => weakThis.deref()?.onChange());
    }

    /**
     * Hook which is called when the underlying rust class notifies us that there has been a change.
     */
    private onChange(): void {
        const verification: RustSdkCryptoJs.Qr | RustSdkCryptoJs.Sas | undefined = this.inner.getVerification();

        // Set the _verifier object (wrapping the rust `Verification` as a js-sdk Verifier) if:
        // - we now have a `Verification` where we lacked one before
        // - we have transitioned from QR to SAS
        // - we are verifying with SAS, but we need to replace our verifier with a new one because both parties
        //   tried to start verification at the same time, and we lost the tie breaking
        if (verification instanceof RustSdkCryptoJs.Sas) {
            if (this._verifier === undefined || this._verifier instanceof RustQrCodeVerifier) {
                this.setVerifier(new RustSASVerifier(verification, this, this.outgoingRequestProcessor));
            } else if (this._verifier instanceof RustSASVerifier) {
                this._verifier.replaceInner(verification);
            }
        } else if (verification instanceof RustSdkCryptoJs.Qr && this._verifier === undefined) {
            this.setVerifier(new RustQrCodeVerifier(verification, this.outgoingRequestProcessor));
        }

        this.emit(VerificationRequestEvent.Change);
    }

    private setVerifier(verifier: RustSASVerifier | RustQrCodeVerifier): void {
        // if we already have a verifier, unsubscribe from its events
        if (this._verifier) {
            this.reEmitter.stopReEmitting(this._verifier, [VerificationRequestEvent.Change]);
        }
        this._verifier = verifier;
        this.reEmitter.reEmit(this._verifier, [VerificationRequestEvent.Change]);
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

    /** Get the other device involved in the verification, if it is known */
    private async getOtherDevice(): Promise<undefined | RustSdkCryptoJs.Device> {
        const otherDeviceId = this.inner.otherDeviceId;
        if (!otherDeviceId) {
            return undefined;
        }
        return await this.olmMachine.getDevice(this.inner.otherUserId, otherDeviceId, 5);
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
                if (!this._verifier) {
                    // this shouldn't happen, because the onChange handler should have created a _verifier.
                    throw new Error("VerificationRequest: inner phase == Transitioned but no verifier!");
                }
                return this._verifier.verificationPhase;
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
        if (this.phase !== VerificationPhase.Started) return null;

        const verification: RustSdkCryptoJs.Qr | RustSdkCryptoJs.Sas | undefined = this.inner.getVerification();
        if (verification instanceof RustSdkCryptoJs.Sas) {
            return VerificationMethod.Sas;
        } else if (verification instanceof RustSdkCryptoJs.Qr) {
            return VerificationMethod.Reciprocate;
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
            const req: undefined | OutgoingRequest = this.inner.acceptWithMethods(
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
        if (method !== VerificationMethod.Sas) {
            throw new Error(`Unsupported verification method ${method}`);
        }

        // make sure that we have a list of the other user's devices (workaround https://github.com/matrix-org/matrix-rust-sdk/issues/2896)
        if (!(await this.getOtherDevice())) {
            throw new Error("startVerification(): other device is unknown");
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
     * Start a QR code verification by providing a scanned QR code for this verification flow.
     *
     * Implementation of {@link Crypto.VerificationRequest#scanQRCode}.
     *
     * @param qrCodeData - the decoded QR code.
     * @returns A verifier; call `.verify()` on it to wait for the other side to complete the verification flow.
     */
    public async scanQRCode(uint8Array: Uint8Array): Promise<Verifier> {
        const scan = RustSdkCryptoJs.QrCodeScan.fromBytes(new Uint8ClampedArray(uint8Array));
        const verifier: RustSdkCryptoJs.Qr = await this.inner.scanQrCode(scan);

        // this should have triggered the onChange callback, and we should now have a verifier
        if (!this._verifier) {
            throw new Error("Still no verifier after scanQrCode() call");
        }

        // we can immediately trigger the reciprocate request
        const req: undefined | OutgoingRequest = verifier.reciprocate();
        if (req) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }

        return this._verifier;
    }

    /**
     * The verifier which is doing the actual verification, once the method has been established.
     * Only defined when the `phase` is Started.
     */
    public get verifier(): Verifier | undefined {
        // It's possible for us to have a Verifier before a method has been chosen (in particular,
        // if we are showing a QR code which the other device has not yet scanned. At that point, we could
        // still switch to SAS).
        //
        // In that case, we should not return it to the application yet, since the application will not expect the
        // Verifier to be replaced during the lifetime of the VerificationRequest.
        return this.phase === VerificationPhase.Started ? this._verifier : undefined;
    }

    /**
     * Stub implementation of {@link Crypto.VerificationRequest#getQRCodeBytes}.
     */
    public getQRCodeBytes(): Buffer | undefined {
        throw new Error("getQRCodeBytes() unsupported in Rust Crypto; use generateQRCode() instead.");
    }

    /**
     * Generate the data for a QR code allowing the other device to verify this one, if it supports it.
     *
     * Implementation of {@link Crypto.VerificationRequest#generateQRCode}.
     */
    public async generateQRCode(): Promise<Buffer | undefined> {
        // make sure that we have a list of the other user's devices (workaround https://github.com/matrix-org/matrix-rust-sdk/issues/2896)
        if (!(await this.getOtherDevice())) {
            throw new Error("generateQRCode(): other device is unknown");
        }

        const innerVerifier: RustSdkCryptoJs.Qr | undefined = await this.inner.generateQrCode();
        // If we are unable to generate a QRCode, we return undefined
        if (!innerVerifier) return;

        return Buffer.from(innerVerifier.toBytes());
    }

    /**
     * If this request has been cancelled, the cancellation code (e.g `m.user`) which is responsible for cancelling
     * this verification.
     */
    public get cancellationCode(): string | null {
        return this.inner.cancelInfo?.cancelCode() ?? null;
    }

    /**
     * The id of the user that cancelled the request.
     *
     * Only defined when phase is Cancelled
     */
    public get cancellingUserId(): string | undefined {
        const cancelInfo = this.inner.cancelInfo;
        if (!cancelInfo) {
            return undefined;
        } else if (cancelInfo.cancelledbyUs()) {
            return this.olmMachine.userId.toString();
        } else {
            return this.inner.otherUserId.toString();
        }
    }
}

/** Common base class for `Verifier` implementations which wrap rust classes.
 *
 * The generic parameter `InnerType` is the type of the rust Verification class which we wrap.
 *
 * @internal
 */
abstract class BaseRustVerifer<InnerType extends RustSdkCryptoJs.Qr | RustSdkCryptoJs.Sas> extends TypedEventEmitter<
    VerifierEvent | VerificationRequestEvent,
    VerifierEventHandlerMap & VerificationRequestEventHandlerMap
> {
    /** A deferred which completes when the verification completes (or rejects when it is cancelled/fails) */
    protected readonly completionDeferred: IDeferred<void>;

    public constructor(
        protected inner: InnerType,
        protected readonly outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {
        super();

        this.completionDeferred = defer();

        // As with RustVerificationRequest, we need to avoid a reference cycle.
        // See the comments in RustVerificationRequest.
        const weakThis = new WeakRef(this);
        inner.registerChangesCallback(async () => weakThis.deref()?.onChange());

        // stop the runtime complaining if nobody catches a failure
        this.completionDeferred.promise.catch(() => null);
    }

    /**
     * Hook which is called when the underlying rust class notifies us that there has been a change.
     *
     * Can be overridden by subclasses to see if we can notify the application about an update. The overriding method
     * must call `super.onChange()`.
     */
    protected onChange(): void {
        if (this.inner.isDone()) {
            this.completionDeferred.resolve(undefined);
        } else if (this.inner.isCancelled()) {
            const cancelInfo = this.inner.cancelInfo()!;
            this.completionDeferred.reject(
                new Error(
                    `Verification cancelled by ${
                        cancelInfo.cancelledbyUs() ? "us" : "them"
                    } with code ${cancelInfo.cancelCode()}: ${cancelInfo.reason()}`,
                ),
            );
        }

        this.emit(VerificationRequestEvent.Change);
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
     * Cancel a verification.
     *
     * We will send an `m.key.verification.cancel` if the verification is still in flight. The verification promise
     * will reject, and a {@link Crypto.VerifierEvent#Cancel} will be emitted.
     *
     * @param e - the reason for the cancellation.
     */
    public cancel(e?: Error): void {
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
        return null;
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

/** A Verifier instance which is used to show and/or scan a QR code. */
export class RustQrCodeVerifier extends BaseRustVerifer<RustSdkCryptoJs.Qr> implements Verifier {
    private callbacks: ShowQrCodeCallbacks | null = null;

    public constructor(inner: RustSdkCryptoJs.Qr, outgoingRequestProcessor: OutgoingRequestProcessor) {
        super(inner, outgoingRequestProcessor);
    }

    protected onChange(): void {
        // if the other side has scanned our QR code and sent us a "reciprocate" message, it is now time for the
        // application to prompt the user to confirm their side.
        if (this.callbacks === null && this.inner.hasBeenScanned()) {
            this.callbacks = {
                confirm: (): void => {
                    this.confirmScanning();
                },
                cancel: (): void => this.cancel(),
            };
        }

        super.onChange();
    }

    /**
     * Start the key verification, if it has not already been started.
     *
     * @returns Promise which resolves when the verification has completed, or rejects if the verification is cancelled
     *    or times out.
     */
    public async verify(): Promise<void> {
        // Some applications (hello, matrix-react-sdk) may not check if there is a `ShowQrCodeCallbacks` and instead
        // register a `ShowReciprocateQr` listener which they expect to be called once `.verify` is called.
        if (this.callbacks !== null) {
            this.emit(VerifierEvent.ShowReciprocateQr, this.callbacks);
        }
        // Nothing to do here but wait.
        await this.completionDeferred.promise;
    }

    /**
     * Calculate an appropriate VerificationPhase for a VerificationRequest where this is the verifier.
     *
     * This is abnormally complicated because a rust-side QR Code verifier can span several verification phases.
     */
    public get verificationPhase(): VerificationPhase {
        switch (this.inner.state()) {
            case QrState.Created:
                // we have created a QR for display; neither side has yet sent an `m.key.verification.start`.
                return VerificationPhase.Ready;
            case QrState.Scanned:
                // other side has scanned our QR and sent an `m.key.verification.start` with `m.reciprocate.v1`
                return VerificationPhase.Started;
            case QrState.Confirmed:
                // we have confirmed the other side's scan and sent an `m.key.verification.done`.
                //
                // However, the verification is not yet "Done", because we have to wait until we have received the
                // `m.key.verification.done` from the other side (in particular, we don't mark the device/identity as
                // verified until that happens). If we return "Done" too soon, we risk the user cancelling the flow.
                return VerificationPhase.Started;
            case QrState.Reciprocated:
                // although the rust SDK doesn't immediately send the `m.key.verification.start` on transition into this
                // state, `RustVerificationRequest.scanQrCode` immediately calls `reciprocate()` and does so, so in practice
                // we can treat the two the same.
                return VerificationPhase.Started;
            case QrState.Done:
                return VerificationPhase.Done;
            case QrState.Cancelled:
                return VerificationPhase.Cancelled;
            default:
                throw new Error(`Unknown qr code state ${this.inner.state()}`);
        }
    }

    /**
     * Get the details for reciprocating QR code verification, if one is in progress
     *
     * Returns `null`, unless this verifier is for reciprocating a QR-code-based verification (ie, the other user has
     * already scanned our QR code), and we are waiting for the user to confirm.
     */
    public getReciprocateQrCodeCallbacks(): ShowQrCodeCallbacks | null {
        return this.callbacks;
    }

    private async confirmScanning(): Promise<void> {
        const req: undefined | OutgoingRequest = this.inner.confirmScanning();
        if (req) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }
    }
}

/** A Verifier instance which is used if we are exchanging emojis */
export class RustSASVerifier extends BaseRustVerifer<RustSdkCryptoJs.Sas> implements Verifier {
    private callbacks: ShowSasCallbacks | null = null;

    public constructor(
        inner: RustSdkCryptoJs.Sas,
        _verificationRequest: RustVerificationRequest,
        outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {
        super(inner, outgoingRequestProcessor);
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
        await this.sendAccept();
        await this.completionDeferred.promise;
    }

    /**
     * Send the accept or start event, if it hasn't already been sent
     */
    private async sendAccept(): Promise<void> {
        const req: undefined | OutgoingRequest = this.inner.accept();
        if (req) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req);
        }
    }

    /** if we can now show the callbacks, do so */
    protected onChange(): void {
        super.onChange();

        if (this.callbacks === null) {
            const emoji = this.inner.emoji();
            const decimal = this.inner.decimals();

            if (emoji === undefined && decimal === undefined) {
                return;
            }

            const sas: GeneratedSas = {};
            if (emoji) {
                sas.emoji = emoji.map((e) => [e.symbol, e.description]);
            }
            if (decimal) {
                sas.decimal = [decimal[0], decimal[1], decimal[2]];
            }

            this.callbacks = {
                sas,
                confirm: async (): Promise<void> => {
                    const requests: Array<OutgoingRequest> = await this.inner.confirm();
                    for (const m of requests) {
                        await this.outgoingRequestProcessor.makeOutgoingRequest(m);
                    }
                },
                mismatch: (): void => {
                    const request = this.inner.cancelWithCode("m.mismatched_sas");
                    if (request) {
                        this.outgoingRequestProcessor.makeOutgoingRequest(request);
                    }
                },
                cancel: (): void => {
                    const request = this.inner.cancelWithCode("m.user");
                    if (request) {
                        this.outgoingRequestProcessor.makeOutgoingRequest(request);
                    }
                },
            };
            this.emit(VerifierEvent.ShowSas, this.callbacks);
        }
    }

    /**
     * Calculate an appropriate VerificationPhase for a VerificationRequest where this is the verifier.
     */
    public get verificationPhase(): VerificationPhase {
        return VerificationPhase.Started;
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
     * Replace the inner Rust verifier with a different one.
     *
     * @param inner - the new Rust verifier
     * @internal
     */
    public replaceInner(inner: RustSdkCryptoJs.Sas): void {
        if (this.inner != inner) {
            this.inner = inner;

            // As with RustVerificationRequest, we need to avoid a reference cycle.
            // See the comments in RustVerificationRequest.
            const weakThis = new WeakRef(this);
            inner.registerChangesCallback(async () => weakThis.deref()?.onChange());

            // replaceInner will only get called if we started the verification at the same time as the other side, and we lost
            // the tie breaker.  So we need to re-accept their verification.
            this.sendAccept();
            this.onChange();
        }
    }
}

/** For each specced verification method, the rust-side `VerificationMethod` corresponding to it */
const verificationMethodsByIdentifier: Record<string, RustSdkCryptoJs.VerificationMethod> = {
    [VerificationMethod.Sas]: RustSdkCryptoJs.VerificationMethod.SasV1,
    [VerificationMethod.ScanQrCode]: RustSdkCryptoJs.VerificationMethod.QrCodeScanV1,
    [VerificationMethod.ShowQrCode]: RustSdkCryptoJs.VerificationMethod.QrCodeShowV1,
    [VerificationMethod.Reciprocate]: RustSdkCryptoJs.VerificationMethod.ReciprocateV1,
};

/**
 * Convert a specced verification method identifier into a rust-side `VerificationMethod`.
 *
 * @param method - specced method identifier, for example `m.sas.v1`.
 * @returns Rust-side `VerificationMethod` corresponding to `method`.
 * @throws An error if the method is unknown.
 *
 * @internal
 */
export function verificationMethodIdentifierToMethod(method: string): RustSdkCryptoJs.VerificationMethod {
    const meth = verificationMethodsByIdentifier[method];
    if (meth === undefined) {
        throw new Error(`Unknown verification method ${method}`);
    }
    return meth;
}

/**
 * Return true if the event's type matches that of an in-room verification event
 *
 * @param event - MatrixEvent
 * @returns
 *
 * @internal
 */
export function isVerificationEvent(event: MatrixEvent): boolean {
    switch (event.getType()) {
        case EventType.KeyVerificationCancel:
        case EventType.KeyVerificationDone:
        case EventType.KeyVerificationMac:
        case EventType.KeyVerificationStart:
        case EventType.KeyVerificationKey:
        case EventType.KeyVerificationReady:
        case EventType.KeyVerificationAccept:
            return true;
        case EventType.RoomMessage:
            return event.getContent().msgtype === MsgType.KeyVerificationRequest;
        default:
            return false;
    }
}
