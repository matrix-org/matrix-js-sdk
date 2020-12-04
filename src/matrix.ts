/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

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

import type Request from "request";

import {MemoryCryptoStore} from "./crypto/store/memory-crypto-store";
import {LocalStorageCryptoStore} from "./crypto/store/localStorage-crypto-store";
import {IndexedDBCryptoStore} from "./crypto/store/indexeddb-crypto-store";
import {MemoryStore} from "./store/memory";
import {StubStore} from "./store/stub";
import {LocalIndexedDBStoreBackend} from "./store/indexeddb-local-backend";
import {RemoteIndexedDBStoreBackend} from "./store/indexeddb-remote-backend";
import {MatrixScheduler} from "./scheduler";
import {MatrixClient} from "./client";
import { Filter } from "./filter";

export * from "./client";
export * from "./http-api";
export * from "./autodiscovery";
export * from "./sync-accumulator";
export * from "./errors";
export * from "./models/event";
export * from "./models/room";
export * from "./models/group";
export * from "./models/event-timeline";
export * from "./models/event-timeline-set";
export * from "./models/room-member";
export * from "./models/room-state";
export * from "./models/user";
export * from "./scheduler";
export * from "./filter";
export * from "./timeline-window";
export * from "./interactive-auth";
export * from "./service-types";
export * from "./store/memory";
export * from "./store/indexeddb";
export * from "./store/session/webstorage";
export * from "./crypto/store/memory-crypto-store";
export * from "./crypto/store/indexeddb-crypto-store";
export * from "./content-repo";
export const ContentHelpers = import("./content-helpers");
export {
    createNewMatrixCall,
    setAudioOutput as setMatrixCallAudioOutput,
    setAudioInput as setMatrixCallAudioInput,
    setVideoInput as setMatrixCallVideoInput,
} from "./webrtc/call";


// expose the underlying request object so different environments can use
// different request libs (e.g. request or browser-request)
let requestInstance;

/**
 * The function used to perform HTTP requests. Only use this if you want to
 * use a different HTTP library, e.g. Angular's <code>$http</code>. This should
 * be set prior to calling {@link createClient}.
 * @param {requestFunction} r The request function to use.
 */
export function request(r) {
    requestInstance = r;
}

/**
 * Return the currently-set request function.
 * @return {requestFunction} The current request function.
 */
export function getRequest() {
    return requestInstance;
}

/**
 * Apply wrapping code around the request function. The wrapper function is
 * installed as the new request handler, and when invoked it is passed the
 * previous value, along with the options and callback arguments.
 * @param {requestWrapperFunction} wrapper The wrapping function.
 */
export function wrapRequest(wrapper) {
    const origRequest = requestInstance;
    requestInstance = function(options, callback) {
        return wrapper(origRequest, options, callback);
    };
}

type Store =
    StubStore | MemoryStore | LocalIndexedDBStoreBackend | RemoteIndexedDBStoreBackend;

type CryptoStore = MemoryCryptoStore | LocalStorageCryptoStore | IndexedDBCryptoStore;

let cryptoStoreFactory = () => new MemoryCryptoStore;

/**
 * Configure a different factory to be used for creating crypto stores
 *
 * @param {Function} fac  a function which will return a new
 *    {@link module:crypto.store.base~CryptoStore}.
 */
export function setCryptoStoreFactory(fac) {
    cryptoStoreFactory = fac;
}

export interface ICreateClientOpts {
    baseUrl: string;
    idBaseUrl?: string;
    store?: Store;
    cryptoStore?: CryptoStore;
    scheduler?: MatrixScheduler;
    request?: Request;
    userId?: string;
    deviceId?: string;
    accessToken?: string;
    identityServer?: any;
    localTimeoutMs?: number;
    useAuthorizationHeader?: boolean;
    timelineSupport?: boolean;
    queryParams?: Record<string, unknown>;
    deviceToImport?: {
        olmDevice: {
            pickledAccount: string;
            sessions: Array<Record<string, any>>;
            pickleKey: string;
        };
        userId: string;
        deviceId: string;
    };
    pickleKey?: string;
    sessionStore?: any;
    unstableClientRelationAggregation?: boolean;
    verificationMethods?: Array<any>;
    forceTURN?: boolean;
    fallbackICEServerAllowed?: boolean;
    cryptoCallbacks?: ICryptoCallbacks;
}

export interface ICryptoCallbacks {
    getCrossSigningKey?: (keyType: string, pubKey: Uint8Array) => Promise<Uint8Array>;
    saveCrossSigningKeys?: (keys: Record<string, Uint8Array>) => void;
    shouldUpgradeDeviceVerifications?: (
        users: Record<string, any>
    ) => Promise<string[]>;
    getSecretStorageKey?: (
        keys: {keys: Record<string, ISecretStorageKeyInfo>}, name: string
    ) => Promise<[string, Uint8Array] | null>;
    cacheSecretStorageKey?: (
        keyId: string, keyInfo: ISecretStorageKeyInfo, key: Uint8Array
    ) => void;
    onSecretRequested?: (
        userId: string, deviceId: string,
        requestId: string, secretName: string, deviceTrust: IDeviceTrustLevel
    ) => Promise<string>;
    getDehydrationKey?: (
        keyInfo: ISecretStorageKeyInfo,
        checkFunc: (Uint8Array) => void,
    ) => Promise<Uint8Array>;
}

// TODO: Move this to `SecretStorage` once converted
export interface ISecretStorageKeyInfo {
    passphrase?: {
        algorithm: "m.pbkdf2";
        iterations: number;
        salt: string;
    };
    iv?: string;
    mac?: string;
}

// TODO: Move this to `CrossSigning` once converted
export interface IDeviceTrustLevel {
    isVerified(): boolean;
    isCrossSigningVerified(): boolean;
    isLocallyVerified(): boolean;
    isTofu(): boolean;
}

/**
 * Construct a Matrix Client. Similar to {@link module:client.MatrixClient}
 * except that the 'request', 'store' and 'scheduler' dependencies are satisfied.
 * @param {(Object|string)} opts The configuration options for this client. If
 * this is a string, it is assumed to be the base URL. These configuration
 * options will be passed directly to {@link module:client.MatrixClient}.
 * @param {Object} opts.store If not set, defaults to
 * {@link module:store/memory.MemoryStore}.
 * @param {Object} opts.scheduler If not set, defaults to
 * {@link module:scheduler~MatrixScheduler}.
 * @param {requestFunction} opts.request If not set, defaults to the function
 * supplied to {@link request} which defaults to the request module from NPM.
 *
 * @param {module:crypto.store.base~CryptoStore=} opts.cryptoStore
 *    crypto store implementation. Calls the factory supplied to
 *    {@link setCryptoStoreFactory} if unspecified; or if no factory has been
 *    specified, uses a default implementation (indexeddb in the browser,
 *    in-memory otherwise).
 *
 * @return {MatrixClient} A new matrix client.
 * @see {@link module:client.MatrixClient} for the full list of options for
 * <code>opts</code>.
 */
export function createClient(opts: ICreateClientOpts | string) {
    if (typeof opts === "string") {
        opts = {
            "baseUrl": opts as string,
        };
    }
    opts.request = opts.request || requestInstance;
    opts.store = opts.store || new MemoryStore({
      localStorage: global.localStorage,
    });
    opts.scheduler = opts.scheduler || new MatrixScheduler();
    opts.cryptoStore = opts.cryptoStore || cryptoStoreFactory();
    return new MatrixClient(opts);
}

/**
 * The request function interface for performing HTTP requests. This matches the
 * API for the {@link https://github.com/request/request#requestoptions-callback|
 * request NPM module}. The SDK will attempt to call this function in order to
 * perform an HTTP request.
 * @callback requestFunction
 * @param {Object} opts The options for this HTTP request.
 * @param {string} opts.uri The complete URI.
 * @param {string} opts.method The HTTP method.
 * @param {Object} opts.qs The query parameters to append to the URI.
 * @param {Object} opts.body The JSON-serializable object.
 * @param {boolean} opts.json True if this is a JSON request.
 * @param {Object} opts._matrix_opts The underlying options set for
 * {@link MatrixHttpApi}.
 * @param {requestCallback} callback The request callback.
 */

/**
 * A wrapper for the request function interface.
 * @callback requestWrapperFunction
 * @param {requestFunction} origRequest The underlying request function being
 * wrapped
 * @param {Object} opts The options for this HTTP request, given in the same
 * form as {@link requestFunction}.
 * @param {requestCallback} callback The request callback.
 */

/**
  * The request callback interface for performing HTTP requests. This matches the
  * API for the {@link https://github.com/request/request#requestoptions-callback|
  * request NPM module}. The SDK will implement a callback which meets this
  * interface in order to handle the HTTP response.
  * @callback requestCallback
  * @param {Error} err The error if one occurred, else falsey.
  * @param {Object} response The HTTP response which consists of
  * <code>{statusCode: {Number}, headers: {Object}}</code>
  * @param {Object} body The parsed HTTP response body.
  */

export interface Relations {
    events: MatrixEvent[];
    nextBatch?: UNKNOWN_TYPE_FILL_ME_IN_LATER;
}

export interface IClientStartOpts {
    /**
     * The event <code>limit=</code> to apply
     * to initial sync. Default: 8.
     */
    initialSyncLimit?: number;

    /**
     * True to put <code>archived=true</code>
     * on the <code>/initialSync</code> request. Default: false.
     */
    includeArchivedRooms?: boolean;

    /**
     * True to do /profile requests
     * on every invite event if the displayname/avatar_url is not known for this user ID.
     * Default: false.
     */
    resolveInvitesToProfiles?: boolean;

    /**
     * Controls where pending messages
     * appear in a room's timeline. If "<b>chronological</b>", messages will appear
     * in the timeline when the call to <code>sendEvent</code> was made. If
     * "<b>detached</b>", pending messages will appear in a separate list,
     * accessbile via {@link module:models/room#getPendingEvents}. Default:
     * "chronological".
     */
    pendingEventOrdering?: string;

    /**
     * The number of milliseconds to wait on /sync.
     * Default: 30000 (30 seconds).
     */
    pollTimeout?: number;

    /**
     * The filter to apply to /sync calls. This will override
     * the opts.initialSyncLimit, which would normally result in a timeline limit filter.
     */
    filter?: Filter;

    /** True to perform syncing without automatically updating presence. */
    disablePresence?: boolean;

    /**
     * True to not load all membership events during
     * initial sync but fetch them when needed by calling `loadOutOfBandMembers`
     * This will override the filter option at this moment.
     */
    lazyLoadMembers?: boolean;

    /**
     * The number of seconds between polls
     * to /.well-known/matrix/client, undefined to disable. This should be in the order of hours.
     * Default: undefined.
     */
    clientWellKnownPollPeriod?: number;
}

/**
 * The standard MatrixClient callback interface. Functions which accept this will
 * specify 2 return arguments. These arguments map to the 2 parameters specified in this callback.
 */
export type Callback<TData = unknown, TError = unknown> =
    (err: TError, data: TData) => void;

