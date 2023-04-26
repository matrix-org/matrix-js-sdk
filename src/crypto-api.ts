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

import type { IMegolmSessionData } from "./@types/crypto";
import { Room } from "./models/room";
import { DeviceMap } from "./models/device";

/**
 * Public interface to the cryptography parts of the js-sdk
 *
 * @remarks Currently, this is a work-in-progress. In time, more methods will be added here.
 */
export interface CryptoApi {
    /**
     * Global override for whether the client should ever send encrypted
     * messages to unverified devices. This provides the default for rooms which
     * do not specify a value.
     *
     * If true, all unverified devices will be blacklisted by default
     */
    globalBlacklistUnverifiedDevices: boolean;

    /**
     * Checks if the user has previously published cross-signing keys
     *
     * This means downloading the devicelist for the user and checking if the list includes
     * the cross-signing pseudo-device.
     *
     * @returns true if the user has previously published cross-signing keys
     */
    userHasCrossSigningKeys(): Promise<boolean>;

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     */
    prepareToEncrypt(room: Room): void;

    /**
     * Discard any existing megolm session for the given room.
     *
     * This will ensure that a new session is created on the next call to {@link prepareToEncrypt},
     * or the next time a message is sent.
     *
     * This should not normally be necessary: it should only be used as a debugging tool if there has been a
     * problem with encryption.
     *
     * @param roomId - the room to discard sessions for
     */
    forceDiscardSession(roomId: string): Promise<void>;

    /**
     * Get a list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @returns a promise which resolves to a list of
     *    session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;

    /**
     * Get the device information for the given list of users.
     *
     * For any users whose device lists are cached (due to sharing an encrypted room with the user), the
     * cached device data is returned.
     *
     * If there are uncached users, and the `downloadUncached` parameter is set to `true`,
     * a `/keys/query` request is made to the server to retrieve these devices.
     *
     * @param userIds - The users to fetch.
     * @param downloadUncached - If true, download the device list for users whose device list we are not
     *    currently tracking. Defaults to false, in which case such users will not appear at all in the result map.
     *
     * @returns A map `{@link DeviceMap}`.
     */
    getUserDeviceInfo(userIds: string[], downloadUncached?: boolean): Promise<DeviceMap>;

    /**
     * Set whether to trust other user's signatures of their devices.
     *
     * If false, devices will only be considered 'verified' if we have
     * verified that device individually (effectively disabling cross-signing).
     *
     * `true` by default.
     *
     * @param val - the new value
     */
    setTrustCrossSignedDevices(val: boolean): void;

    /**
     * Return whether we trust other user's signatures of their devices.
     *
     * @see {@link CryptoApi#setTrustCrossSignedDevices}
     *
     * @returns `true` if we trust cross-signed devices, otherwise `false`.
     */
    getTrustCrossSignedDevices(): boolean;

    /**
     * Get the verification status of a given device.
     *
     * @param userId - The ID of the user whose device is to be checked.
     * @param deviceId - The ID of the device to check
     *
     * @returns Verification status of the device, or `null` if the device is not known
     */
    getDeviceVerificationStatus(userId: string, deviceId: string): Promise<DeviceVerificationStatus | null>;
}

export class DeviceVerificationStatus {
    /**
     * True if this device has been signed by its owner (and that signature verified).
     *
     * This doesn't necessarily mean that we have verified the device, since we may not have verified the
     * owner's cross-signing key.
     */
    public readonly signedByOwner: boolean;

    /**
     * True if this device has been verified via cross signing.
     *
     * This does *not* take into account `trustCrossSignedDevices`.
     */
    public readonly crossSigningVerified: boolean;

    /**
     * TODO: tofu magic wtf does this do?
     */
    public readonly tofu: boolean;

    /**
     * True if the device has been marked as locally verified.
     */
    public readonly localVerified: boolean;

    /**
     * True if the client has been configured to trust cross-signed devices via {@link CryptoApi#setTrustCrossSignedDevices}.
     */
    private readonly trustCrossSignedDevices: boolean;

    public constructor(
        opts: Partial<DeviceVerificationStatus> & {
            /**
             * True if cross-signed devices should be considered verified for {@link DeviceVerificationStatus#isVerified}.
             */
            trustCrossSignedDevices?: boolean;
        },
    ) {
        this.signedByOwner = opts.signedByOwner ?? false;
        this.crossSigningVerified = opts.crossSigningVerified ?? false;
        this.tofu = opts.tofu ?? false;
        this.localVerified = opts.localVerified ?? false;
        this.trustCrossSignedDevices = opts.trustCrossSignedDevices ?? false;
    }

    /**
     * Check if we should consider this device "verified".
     *
     * A device is "verified" if either:
     *  * it has been manually marked as such via {@link MatrixClient#setDeviceVerified}.
     *  * it has been cross-signed with a verified signing key, **and** the client has been configured to trust
     *    cross-signed devices via {@link CryptoApi#setTrustCrossSignedDevices}.
     *
     * @returns true if this device is verified via any means.
     */
    public isVerified(): boolean {
        return this.localVerified || (this.trustCrossSignedDevices && this.crossSigningVerified);
    }
}
