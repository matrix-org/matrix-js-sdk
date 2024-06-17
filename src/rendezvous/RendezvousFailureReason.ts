/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

export type RendezvousFailureListener = (reason: RendezvousFailureReason) => void;

export type RendezvousFailureReason =
    | LegacyRendezvousFailureReason
    | MSC4108FailureReason
    | ClientRendezvousFailureReason;

export enum LegacyRendezvousFailureReason {
    UserDeclined = "user_declined",
    Unknown = "unknown",
    Expired = "expired",
    UserCancelled = "user_cancelled",
    UnsupportedAlgorithm = "unsupported_algorithm",
    UnsupportedProtocol = "unsupported_protocol",
    HomeserverLacksSupport = "homeserver_lacks_support",
}

export enum MSC4108FailureReason {
    AuthorizationExpired = "authorization_expired",
    DeviceAlreadyExists = "device_already_exists",
    DeviceNotFound = "device_not_found",
    UnexpectedMessageReceived = "unexpected_message_received",
    UnsupportedProtocol = "unsupported_protocol",
    UserCancelled = "user_cancelled",
}

export enum ClientRendezvousFailureReason {
    /** The sign in request has expired */
    Expired = "expired",
    /** The homeserver is lacking support for the required features */
    HomeserverLacksSupport = "homeserver_lacks_support",
    /** The secure channel verification failed meaning that it might be compromised */
    InsecureChannelDetected = "insecure_channel_detected",
    /** An invalid/incompatible QR code was scanned */
    InvalidCode = "invalid_code",
    /** The other device is not signed in */
    OtherDeviceNotSignedIn = "other_device_not_signed_in",
    /** The other device is already signed in */
    OtherDeviceAlreadySignedIn = "other_device_already_signed_in",
    /** Other */
    Unknown = "unknown",
    /** The user declined the sign in request */
    UserDeclined = "user_declined",
    /** The rendezvous request is missing an ETag header */
    ETagMissing = "etag_missing",
}
