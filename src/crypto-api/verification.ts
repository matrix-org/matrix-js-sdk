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
