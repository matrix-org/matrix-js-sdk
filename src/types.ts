/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

/*
 * This file is a secondary entrypoint for the js-sdk library, for use by Typescript projects.
 * It exposes low-level types and interfaces reflecting structures defined in the Matrix specification.
 *
 * Remember to only export *public* types from this file.
 */

export type * from "./@types/media";
export * from "./@types/membership";
export type * from "./@types/event";
export type * from "./@types/events";
export type * from "./@types/state_events";

/** The different methods for device and user verification */
export enum VerificationMethod {
    /** Short authentication string (emoji or decimals).
     *
     * @see https://spec.matrix.org/v1.9/client-server-api/#short-authentication-string-sas-verification
     */
    Sas = "m.sas.v1",

    /**
     * Verification by showing a QR code which is scanned by the other device.
     *
     * @see https://spec.matrix.org/v1.9/client-server-api/#qr-codes
     */
    ShowQrCode = "m.qr_code.show.v1",

    /**
     * Verification by scanning a QR code that is shown by the other device.
     *
     * @see https://spec.matrix.org/v1.9/client-server-api/#qr-codes
     */
    ScanQrCode = "m.qr_code.scan.v1",

    /**
     * Verification by confirming that we have scanned a QR code.
     *
     * @see https://spec.matrix.org/v1.9/client-server-api/#qr-codes
     */
    Reciprocate = "m.reciprocate.v1",
}
