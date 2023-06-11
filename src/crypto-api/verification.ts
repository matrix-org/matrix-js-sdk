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

import { MatrixEvent } from "../models/event";
import { TypedEventEmitter } from "../models/typed-event-emitter";

/**
 * A `Verifier` is responsible for performing the verification using a particular method, such as via QR code or SAS
 * (emojis).
 *
 * A verifier object can be created by calling `VerificationRequest.beginVerification`; one is also created
 * automatically when a `m.key.verification.start` event is received for an existing VerificationRequest.
 *
 * Once a verifier object is created, the verification can be started by calling the {@link Verifier#verify} method.
 */
export interface Verifier extends TypedEventEmitter<VerifierEvent, VerifierEventHandlerMap> {
    /**
     * Returns true if the verification has been cancelled, either by us or the other side.
     */
    get hasBeenCancelled(): boolean;

    /**
     * The ID of the other user in the verification process.
     */
    get userId(): string;

    /**
     * Start the key verification, if it has not already been started.
     *
     * This means sending a `m.key.verification.start` if we are the first responder, or a `m.key.verification.accept`
     * if the other side has already sent a start event.
     *
     * @returns Promise which resolves when the verification has completed, or rejects if the verification is cancelled
     *    or times out.
     */
    verify(): Promise<void>;

    /**
     * Cancel a verification.
     *
     * We will send an `m.key.verification.cancel` if the verification is still in flight. The verification promise
     * will reject, and a {@link Crypto.VerifierEvent#Cancel} will be emitted.
     *
     * @param e - the reason for the cancellation.
     */
    cancel(e: Error): void;

    /**
     * Get the details for an SAS verification, if one is in progress
     *
     * Returns `null`, unless this verifier is for a SAS-based verification and we are waiting for the user to confirm
     * the SAS matches.
     */
    getShowSasCallbacks(): ShowSasCallbacks | null;

    /**
     * Get the details for reciprocating QR code verification, if one is in progress
     *
     * Returns `null`, unless this verifier is for reciprocating a QR-code-based verification (ie, the other user has
     * already scanned our QR code), and we are waiting for the user to confirm.
     */
    getReciprocateQrCodeCallbacks(): ShowQrCodeCallbacks | null;
}

/** Events emitted by {@link Verifier} */
export enum VerifierEvent {
    /**
     * The verification has been cancelled, by us or the other side.
     *
     * The payload is either an {@link Error}, or an (incoming or outgoing) {@link MatrixEvent}, depending on
     * unspecified reasons.
     */
    Cancel = "cancel",

    /**
     * SAS data has been exchanged and should be displayed to the user.
     *
     * The payload is the {@link ShowSasCallbacks} object.
     */
    ShowSas = "show_sas",

    /**
     * QR code data should be displayed to the user.
     *
     * The payload is the {@link ShowQrCodeCallbacks} object.
     */
    ShowReciprocateQr = "show_reciprocate_qr",
}

/** Listener type map for {@link VerifierEvent}s. */
export type VerifierEventHandlerMap = {
    [VerifierEvent.Cancel]: (e: Error | MatrixEvent) => void;
    [VerifierEvent.ShowSas]: (sas: ShowSasCallbacks) => void;
    [VerifierEvent.ShowReciprocateQr]: (qr: ShowQrCodeCallbacks) => void;
};

/**
 * Callbacks for user actions while a QR code is displayed.
 *
 * This is exposed as the payload of a `VerifierEvent.ShowReciprocateQr` event, or can be retrieved directly from the
 * verifier as `reciprocateQREvent`.
 */
export interface ShowQrCodeCallbacks {
    /** The user confirms that the verification data matches */
    confirm(): void;

    /** Cancel the verification flow */
    cancel(): void;
}

/**
 * Callbacks for user actions while a SAS is displayed.
 *
 * This is exposed as the payload of a `VerifierEvent.ShowSas` event, or directly from the verifier as `sasEvent`.
 */
export interface ShowSasCallbacks {
    /** The generated SAS to be shown to the user */
    sas: GeneratedSas;

    /** Function to call if the user confirms that the SAS matches.
     *
     * @returns A Promise that completes once the m.key.verification.mac is queued.
     */
    confirm(): Promise<void>;

    /**
     * Function to call if the user finds the SAS does not match.
     *
     * Sends an `m.key.verification.cancel` event with a `m.mismatched_sas` error code.
     */
    mismatch(): void;

    /** Cancel the verification flow */
    cancel(): void;
}

/** A generated SAS to be shown to the user, in alternative formats */
export interface GeneratedSas {
    /**
     * The SAS as three numbers between 0 and 8191.
     *
     * Only populated if the `decimal` SAS method was negotiated.
     */
    decimal?: [number, number, number];

    /**
     * The SAS as seven emojis.
     *
     * Only populated if the `emoji` SAS method was negotiated.
     */
    emoji?: EmojiMapping[];
}

/**
 * An emoji for the generated SAS. A tuple `[emoji, name]` where `emoji` is the emoji itself and `name` is the
 * English name.
 */
export type EmojiMapping = [emoji: string, name: string];
