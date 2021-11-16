/// <reference types="node" />
/**
 * @module crypto/DeviceList
 *
 * Manages the list of other users' devices
 */
import { EventEmitter } from 'events';
import { DeviceInfo, IDevice } from './deviceinfo';
import { CrossSigningInfo, ICrossSigningInfo } from './CrossSigning';
import { MatrixClient } from "../client";
import { OlmDevice } from "./OlmDevice";
import { CryptoStore } from "./store/base";
export declare enum TrackingStatus {
    NotTracked = 0,
    PendingDownload = 1,
    DownloadInProgress = 2,
    UpToDate = 3
}
export declare type DeviceInfoMap = Record<string, Record<string, DeviceInfo>>;
/**
 * @alias module:crypto/DeviceList
 */
export declare class DeviceList extends EventEmitter {
    private readonly cryptoStore;
    readonly keyDownloadChunkSize: number;
    private devices;
    crossSigningInfo: {
        [userId: string]: ICrossSigningInfo;
    };
    private userByIdentityKey;
    private deviceTrackingStatus;
    private syncToken;
    private keyDownloadsInProgressByUser;
    private dirty;
    private savePromise;
    private resolveSavePromise;
    private savePromiseTime;
    private saveTimer;
    private hasFetched;
    private readonly serialiser;
    constructor(baseApis: MatrixClient, cryptoStore: CryptoStore, olmDevice: OlmDevice, keyDownloadChunkSize?: number);
    /**
     * Load the device tracking state from storage
     */
    load(): Promise<void>;
    stop(): void;
    /**
     * Save the device tracking state to storage, if any changes are
     * pending other than updating the sync token
     *
     * The actual save will be delayed by a short amount of time to
     * aggregate multiple writes to the database.
     *
     * @param {number} delay Time in ms before which the save actually happens.
     *     By default, the save is delayed for a short period in order to batch
     *     multiple writes, but this behaviour can be disabled by passing 0.
     *
     * @return {Promise<boolean>} true if the data was saved, false if
     *     it was not (eg. because no changes were pending). The promise
     *     will only resolve once the data is saved, so may take some time
     *     to resolve.
     */
    saveIfDirty(delay?: number): Promise<boolean>;
    /**
     * Gets the sync token last set with setSyncToken
     *
     * @return {string} The sync token
     */
    getSyncToken(): string;
    /**
     * Sets the sync token that the app will pass as the 'since' to the /sync
     * endpoint next time it syncs.
     * The sync token must always be set after any changes made as a result of
     * data in that sync since setting the sync token to a newer one will mean
     * those changed will not be synced from the server if a new client starts
     * up with that data.
     *
     * @param {string} st The sync token
     */
    setSyncToken(st: string): void;
    /**
     * Ensures up to date keys for a list of users are stored in the session store,
     * downloading and storing them if they're not (or if forceDownload is
     * true).
     * @param {Array} userIds The users to fetch.
     * @param {boolean} forceDownload Always download the keys even if cached.
     *
     * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
     * module:crypto/deviceinfo|DeviceInfo}.
     */
    downloadKeys(userIds: string[], forceDownload: boolean): Promise<DeviceInfoMap>;
    /**
     * Get the stored device keys for a list of user ids
     *
     * @param {string[]} userIds the list of users to list keys for.
     *
     * @return {Object} userId->deviceId->{@link module:crypto/deviceinfo|DeviceInfo}.
     */
    private getDevicesFromStore;
    /**
     * Returns a list of all user IDs the DeviceList knows about
     *
     * @return {array} All known user IDs
     */
    getKnownUserIds(): string[];
    /**
     * Get the stored device keys for a user id
     *
     * @param {string} userId the user to list keys for.
     *
     * @return {module:crypto/deviceinfo[]|null} list of devices, or null if we haven't
     * managed to get a list of devices for this user yet.
     */
    getStoredDevicesForUser(userId: string): DeviceInfo[] | null;
    /**
     * Get the stored device data for a user, in raw object form
     *
     * @param {string} userId the user to get data for
     *
     * @return {Object} deviceId->{object} devices, or undefined if
     * there is no data for this user.
     */
    getRawStoredDevicesForUser(userId: string): Record<string, IDevice>;
    getStoredCrossSigningForUser(userId: string): CrossSigningInfo;
    storeCrossSigningForUser(userId: string, info: ICrossSigningInfo): void;
    /**
     * Get the stored keys for a single device
     *
     * @param {string} userId
     * @param {string} deviceId
     *
     * @return {module:crypto/deviceinfo?} device, or undefined
     * if we don't know about this device
     */
    getStoredDevice(userId: string, deviceId: string): DeviceInfo;
    /**
     * Get a user ID by one of their device's curve25519 identity key
     *
     * @param {string} algorithm  encryption algorithm
     * @param {string} senderKey  curve25519 key to match
     *
     * @return {string} user ID
     */
    getUserByIdentityKey(algorithm: string, senderKey: string): string;
    /**
     * Find a device by curve25519 identity key
     *
     * @param {string} algorithm  encryption algorithm
     * @param {string} senderKey  curve25519 key to match
     *
     * @return {module:crypto/deviceinfo?}
     */
    getDeviceByIdentityKey(algorithm: string, senderKey: string): DeviceInfo | null;
    /**
     * Replaces the list of devices for a user with the given device list
     *
     * @param {string} userId The user ID
     * @param {Object} devices New device info for user
     */
    storeDevicesForUser(userId: string, devices: Record<string, IDevice>): void;
    /**
     * flag the given user for device-list tracking, if they are not already.
     *
     * This will mean that a subsequent call to refreshOutdatedDeviceLists()
     * will download the device list for the user, and that subsequent calls to
     * invalidateUserDeviceList will trigger more updates.
     *
     * @param {String} userId
     */
    startTrackingDeviceList(userId: string): void;
    /**
     * Mark the given user as no longer being tracked for device-list updates.
     *
     * This won't affect any in-progress downloads, which will still go on to
     * complete; it will just mean that we don't think that we have an up-to-date
     * list for future calls to downloadKeys.
     *
     * @param {String} userId
     */
    stopTrackingDeviceList(userId: string): void;
    /**
     * Set all users we're currently tracking to untracked
     *
     * This will flag each user whose devices we are tracking as in need of an
     * update.
     */
    stopTrackingAllDeviceLists(): void;
    /**
     * Mark the cached device list for the given user outdated.
     *
     * If we are not tracking this user's devices, we'll do nothing. Otherwise
     * we flag the user as needing an update.
     *
     * This doesn't actually set off an update, so that several users can be
     * batched together. Call refreshOutdatedDeviceLists() for that.
     *
     * @param {String} userId
     */
    invalidateUserDeviceList(userId: string): void;
    /**
     * If we have users who have outdated device lists, start key downloads for them
     *
     * @returns {Promise} which completes when the download completes; normally there
     *    is no need to wait for this (it's mostly for the unit tests).
     */
    refreshOutdatedDeviceLists(): Promise<void>;
    /**
     * Set the stored device data for a user, in raw object form
     * Used only by internal class DeviceListUpdateSerialiser
     *
     * @param {string} userId the user to get data for
     *
     * @param {Object} devices deviceId->{object} the new devices
     */
    setRawStoredDevicesForUser(userId: string, devices: Record<string, IDevice>): void;
    setRawStoredCrossSigningForUser(userId: string, info: ICrossSigningInfo): void;
    /**
     * Fire off download update requests for the given users, and update the
     * device list tracking status for them, and the
     * keyDownloadsInProgressByUser map for them.
     *
     * @param {String[]} users  list of userIds
     *
     * @return {Promise} resolves when all the users listed have
     *     been updated. rejects if there was a problem updating any of the
     *     users.
     */
    private doKeyDownload;
}
//# sourceMappingURL=DeviceList.d.ts.map