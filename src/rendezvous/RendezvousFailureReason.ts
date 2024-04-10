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
    OtherDeviceNotSignedIn = "other_device_not_signed_in",
    OtherDeviceAlreadySignedIn = "other_device_already_signed_in",
    Unknown = "unknown",
    Expired = "expired",
    UserCancelled = "user_cancelled",
    InvalidCode = "invalid_code",
    UnsupportedAlgorithm = "unsupported_algorithm",
    UnsupportedProtocol = "unsupported_protocol",
    UnsupportedTransport = "unsupported_transport",
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
    Expired = "expired",
    HomeserverLacksSupport = "homeserver_lacks_support",
    InsecureChannelDetected = "insecure_channel_detected",
    InvalidCode = "invalid_code",
    OtherDeviceNotSignedIn = "other_device_not_signed_in",
    OtherDeviceAlreadySignedIn = "other_device_already_signed_in",
    Unknown = "unknown",
    UserDeclined = "user_declined",
}
