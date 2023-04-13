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

import { DeviceVerification, IDevice } from "../crypto/deviceinfo";
import { DeviceKeys } from "../client";

/**
 * Convert a {@link RustSdkCryptoJs.Device} to a {@link IDevice}
 * @param device - Rust Sdk device
 */
export function rustDeviceToJsDevice(device: RustSdkCryptoJs.Device): IDevice {
    const keys: Record<string, string> = Object.create(null);
    for (const [keyId, key] of device.keys.entries()) {
        keys[keyId.toString()] = key.toBase64();
    }

    let verified: DeviceVerification = DeviceVerification.Unverified;
    if (device.isBlacklisted()) {
        verified = DeviceVerification.Blocked;
    } else if (device.isVerified()) {
        verified = DeviceVerification.Verified;
    }

    return {
        algorithms: [], // TODO
        keys: keys,
        known: false, // TODO
        signatures: undefined, // TODO
        verified,
    };
}

/**
 * Convert {@link DeviceKeys}  from `/keys/query` request to a `Map<string, IDevice>`
 * @param deviceKeys - Device keys object to convert
 */
export function deviceKeysToIDeviceMap(deviceKeys: DeviceKeys): Map<string, IDevice> {
    return new Map(
        Object.entries(deviceKeys).map(([deviceId, device]) => [deviceId, downloadDeviceToJsDevice(device)]),
    );
}

// Device from `/keys/query` request
type QueryDevice = DeviceKeys[keyof DeviceKeys];

/**
 * Convert `/keys/query` {@link QueryDevice} device to {@link IDevice}
 * @param device - Device from `/keys/query` request
 */
export function downloadDeviceToJsDevice(device: QueryDevice): IDevice {
    return {
        algorithms: device.algorithms,
        keys: device.keys,
        known: false,
        signatures: device.signatures,
        verified: DeviceVerification.Unverified,
        unsigned: device.unsigned,
    };
}
