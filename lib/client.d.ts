/// <reference types="request" />
/// <reference types="node" />
/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */
import { EventEmitter } from "events";
import { ISyncStateData, SyncApi } from "./sync";
import { IContent, IDecryptOptions, IEvent, MatrixEvent } from "./models/event";
import { MatrixCall } from "./webrtc/call";
import { Filter, IFilterDefinition } from "./filter";
import { CallEventHandler } from './webrtc/callEventHandler';
import { Group } from "./models/group";
import { Direction, EventTimeline } from "./models/event-timeline";
import { IActionsObject, PushProcessor } from "./pushprocessor";
import { AutoDiscoveryAction } from "./autodiscovery";
import { IExportedDevice as IOlmDevice } from "./crypto/OlmDevice";
import { ReEmitter } from './ReEmitter';
import { IRoomEncryption, RoomList } from './crypto/RoomList';
import { SERVICE_TYPES } from './service-types';
import { MatrixError, MatrixHttpApi } from "./http-api";
import { Crypto, IBootstrapCrossSigningOpts, ICheckOwnCrossSigningTrustOpts, IMegolmSessionData, VerificationMethod } from './crypto';
import { DeviceInfo, IDevice } from "./crypto/deviceinfo";
import { User } from "./models/user";
import { IDehydratedDevice, IDehydratedDeviceKeyInfo, IDeviceKeys, IOneTimeKey } from "./crypto/dehydration";
import { IKeyBackupInfo, IKeyBackupPrepareOpts, IKeyBackupRestoreOpts, IKeyBackupRestoreResult } from "./crypto/keybackup";
import { IIdentityServerProvider } from "./@types/IIdentityServerProvider";
import { MatrixScheduler } from "./scheduler";
import { ICryptoCallbacks, IMinimalEvent, IRoomEvent, IStateEvent } from "./matrix";
import { CrossSigningKey, IAddSecretStorageKeyOpts, ICreateSecretStorageOpts, IEncryptedEventInfo, IImportRoomKeysOpts, IRecoveryKey, ISecretStorageKeyInfo } from "./crypto/api";
import { SyncState } from "./sync.api";
import { EventTimelineSet } from "./models/event-timeline-set";
import { VerificationRequest } from "./crypto/verification/request/VerificationRequest";
import { VerificationBase as Verification } from "./crypto/verification/Base";
import { CrossSigningInfo, DeviceTrustLevel, ICacheCallbacks, UserTrustLevel } from "./crypto/CrossSigning";
import { Room } from "./models/room";
import { IAddThreePidOnlyBody, IBindThreePidBody, ICreateRoomOpts, IEventSearchOpts, IGuestAccessOpts, IJoinRoomOpts, IPaginateOpts, IPresenceOpts, IRedactOpts, IRoomDirectoryOptions, ISearchOpts, ISendEventResponse, IUploadOpts } from "./@types/requests";
import { EventType, RoomType } from "./@types/event";
import { IAbortablePromise, IdServerUnbindResult, IImageInfo, Preset, Visibility } from "./@types/partials";
import { EventMapper, MapperOpts } from "./event-mapper";
import { ReadStream } from "fs";
import { WebStorageSessionStore } from "./store/session/webstorage";
import { IKeyBackup, IKeyBackupCheck, IPreparedKeyBackupVersion, TrustInfo } from "./crypto/backup";
import { MSC3089TreeSpace } from "./models/MSC3089TreeSpace";
import { ISignatures } from "./@types/signed";
import { IStore } from "./store";
import { ISecretRequest } from "./crypto/SecretStorage";
import { IEventWithRoomId, ISearchRequestBody, ISearchResponse, ISearchResults, IStateEventWithRoomId } from "./@types/search";
import { ISynapseAdminDeactivateResponse, ISynapseAdminWhoisResponse } from "./@types/synapse";
import { IHierarchyRoom, ISpaceSummaryEvent, ISpaceSummaryRoom } from "./@types/spaces";
import { IPusher, IPusherRequest, IPushRules, PushRuleAction, PushRuleKind, RuleId } from "./@types/PushRules";
import { IThreepid } from "./@types/threepids";
import { CryptoStore } from "./crypto/store/base";
import { MediaHandler } from "./webrtc/mediaHandler";
export declare type Store = IStore;
export declare type SessionStore = WebStorageSessionStore;
export declare type Callback = (err: Error | any | null, data?: any) => void;
export declare type ResetTimelineCallback = (roomId: string) => boolean;
export declare const CRYPTO_ENABLED: boolean;
interface IExportedDevice {
    olmDevice: IOlmDevice;
    userId: string;
    deviceId: string;
}
export interface IKeysUploadResponse {
    one_time_key_counts: {
        [algorithm: string]: number;
    };
}
export interface ICreateClientOpts {
    baseUrl: string;
    idBaseUrl?: string;
    /**
     * The data store used for sync data from the homeserver. If not specified,
     * this client will not store any HTTP responses. The `createClient` helper
     * will create a default store if needed.
     */
    store?: Store;
    /**
     * A store to be used for end-to-end crypto session data. If not specified,
     * end-to-end crypto will be disabled. The `createClient` helper will create
     * a default store if needed.
     */
    cryptoStore?: CryptoStore;
    /**
     * The scheduler to use. If not
     * specified, this client will not retry requests on failure. This client
     * will supply its own processing function to
     * {@link module:scheduler~MatrixScheduler#setProcessFunction}.
     */
    scheduler?: MatrixScheduler;
    /**
     * The function to invoke for HTTP
     * requests. The value of this property is typically <code>require("request")
     * </code> as it returns a function which meets the required interface. See
     * {@link requestFunction} for more information.
     */
    request?: Request;
    userId?: string;
    /**
     * A unique identifier for this device; used for tracking things like crypto
     * keys and access tokens. If not specified, end-to-end encryption will be
     * disabled.
     */
    deviceId?: string;
    accessToken?: string;
    /**
     * Identity server provider to retrieve the user's access token when accessing
     * the identity server. See also https://github.com/vector-im/element-web/issues/10615
     * which seeks to replace the previous approach of manual access tokens params
     * with this callback throughout the SDK.
     */
    identityServer?: IIdentityServerProvider;
    /**
     * The default maximum amount of
     * time to wait before timing out HTTP requests. If not specified, there is no timeout.
     */
    localTimeoutMs?: number;
    /**
     * Set to true to use
     * Authorization header instead of query param to send the access token to the server.
     *
     * Default false.
     */
    useAuthorizationHeader?: boolean;
    /**
     * Set to true to enable
     * improved timeline support ({@link module:client~MatrixClient#getEventTimeline getEventTimeline}). It is
     * disabled by default for compatibility with older clients - in particular to
     * maintain support for back-paginating the live timeline after a '/sync'
     * result with a gap.
     */
    timelineSupport?: boolean;
    /**
     * Extra query parameters to append
     * to all requests with this client. Useful for application services which require
     * <code>?user_id=</code>.
     */
    queryParams?: Record<string, unknown>;
    /**
     * Device data exported with
     * "exportDevice" method that must be imported to recreate this device.
     * Should only be useful for devices with end-to-end crypto enabled.
     * If provided, deviceId and userId should **NOT** be provided at the top
     * level (they are present in the exported data).
     */
    deviceToImport?: IExportedDevice;
    /**
     * Key used to pickle olm objects or other sensitive data.
     */
    pickleKey?: string;
    /**
     * A store to be used for end-to-end crypto session data. Most data has been
     * migrated out of here to `cryptoStore` instead. If not specified,
     * end-to-end crypto will be disabled. The `createClient` helper
     * _will not_ create this store at the moment.
     */
    sessionStore?: SessionStore;
    /**
     * Set to true to enable client-side aggregation of event relations
     * via `EventTimelineSet#getRelationsForEvent`.
     * This feature is currently unstable and the API may change without notice.
     */
    unstableClientRelationAggregation?: boolean;
    verificationMethods?: Array<VerificationMethod>;
    /**
     * Whether relaying calls through a TURN server should be forced. Default false.
     */
    forceTURN?: boolean;
    /**
     * Up to this many ICE candidates will be gathered when an incoming call arrives.
     * Gathering does not send data to the caller, but will communicate with the configured TURN
     * server. Default 0.
     */
    iceCandidatePoolSize?: number;
    /**
     * True to advertise support for call transfers to other parties on Matrix calls. Default false.
     */
    supportsCallTransfer?: boolean;
    /**
     * Whether to allow a fallback ICE server should be used for negotiating a
     * WebRTC connection if the homeserver doesn't provide any servers. Defaults to false.
     */
    fallbackICEServerAllowed?: boolean;
    cryptoCallbacks?: ICryptoCallbacks;
}
export interface IMatrixClientCreateOpts extends ICreateClientOpts {
    /**
     * Whether to allow sending messages to encrypted rooms when encryption
     * is not available internally within this SDK. This is useful if you are using an external
     * E2E proxy, for example. Defaults to false.
     */
    usingExternalCrypto?: boolean;
}
export declare enum PendingEventOrdering {
    Chronological = "chronological",
    Detached = "detached"
}
export interface IStartClientOpts {
    /**
     * The event <code>limit=</code> to apply to initial sync. Default: 8.
     */
    initialSyncLimit?: number;
    /**
     * True to put <code>archived=true</code> on the <code>/initialSync</code> request. Default: false.
     */
    includeArchivedRooms?: boolean;
    /**
     * True to do /profile requests on every invite event if the displayname/avatar_url is not known for this user ID. Default: false.
     */
    resolveInvitesToProfiles?: boolean;
    /**
     * Controls where pending messages appear in a room's timeline. If "<b>chronological</b>", messages will
     * appear in the timeline when the call to <code>sendEvent</code> was made. If "<b>detached</b>",
     * pending messages will appear in a separate list, accessbile via {@link module:models/room#getPendingEvents}.
     * Default: "chronological".
     */
    pendingEventOrdering?: PendingEventOrdering;
    /**
     * The number of milliseconds to wait on /sync. Default: 30000 (30 seconds).
     */
    pollTimeout?: number;
    /**
     * The filter to apply to /sync calls. This will override the opts.initialSyncLimit, which would
     * normally result in a timeline limit filter.
     */
    filter?: Filter;
    /**
     * True to perform syncing without automatically updating presence.
     */
    disablePresence?: boolean;
    /**
     * True to not load all membership events during initial sync but fetch them when needed by calling
     * `loadOutOfBandMembers` This will override the filter option at this moment.
     */
    lazyLoadMembers?: boolean;
    /**
     * The number of seconds between polls to /.well-known/matrix/client, undefined to disable.
     * This should be in the order of hours. Default: undefined.
     */
    clientWellKnownPollPeriod?: number;
    /**
     * @experimental
     */
    experimentalThreadSupport?: boolean;
}
export interface IStoredClientOpts extends IStartClientOpts {
    crypto: Crypto;
    canResetEntireTimeline: ResetTimelineCallback;
}
export declare enum RoomVersionStability {
    Stable = "stable",
    Unstable = "unstable"
}
export interface IRoomCapability {
    preferred: string | null;
    support: string[];
}
export interface IRoomVersionsCapability {
    default: string;
    available: Record<string, RoomVersionStability>;
    "org.matrix.msc3244.room_capabilities"?: Record<string, IRoomCapability>;
}
export interface IChangePasswordCapability {
    enabled: boolean;
}
interface ICapabilities {
    [key: string]: any;
    "m.change_password"?: IChangePasswordCapability;
    "m.room_versions"?: IRoomVersionsCapability;
}
export interface ICrossSigningKey {
    keys: {
        [algorithm: string]: string;
    };
    signatures?: ISignatures;
    usage: string[];
    user_id: string;
}
declare enum CrossSigningKeyType {
    MasterKey = "master_key",
    SelfSigningKey = "self_signing_key",
    UserSigningKey = "user_signing_key"
}
export declare type CrossSigningKeys = Record<CrossSigningKeyType, ICrossSigningKey>;
export interface ISignedKey {
    keys: Record<string, string>;
    signatures: ISignatures;
    user_id: string;
    algorithms: string[];
    device_id: string;
}
export declare type KeySignatures = Record<string, Record<string, ICrossSigningKey | ISignedKey>>;
interface IUploadKeySignaturesResponse {
    failures: Record<string, Record<string, {
        errcode: string;
        error: string;
    }>>;
}
export interface IPreviewUrlResponse {
    [key: string]: string | number;
    "og:title": string;
    "og:type": string;
    "og:url": string;
    "og:image"?: string;
    "og:image:type"?: string;
    "og:image:height"?: number;
    "og:image:width"?: number;
    "og:description"?: string;
    "matrix:image:size"?: number;
}
interface ITurnServerResponse {
    uris: string[];
    username: string;
    password: string;
    ttl: number;
}
interface ITurnServer {
    urls: string[];
    username: string;
    credential: string;
}
interface IServerVersions {
    versions: string;
    unstable_features: Record<string, boolean>;
}
export interface IClientWellKnown {
    [key: string]: any;
    "m.homeserver"?: IWellKnownConfig;
    "m.identity_server"?: IWellKnownConfig;
}
export interface IWellKnownConfig {
    raw?: any;
    action?: AutoDiscoveryAction;
    reason?: string;
    error?: Error | string;
    base_url?: string | null;
}
interface IMediaConfig {
    [key: string]: any;
    "m.upload.size"?: number;
}
interface ITagMetadata {
    [key: string]: any;
    order: number;
}
interface IMessagesResponse {
    start: string;
    end: string;
    chunk: IRoomEvent[];
    state: IStateEvent[];
}
export interface IRequestTokenResponse {
    sid: string;
    submit_url?: string;
}
export interface IRequestMsisdnTokenResponse extends IRequestTokenResponse {
    msisdn: string;
    success: boolean;
    intl_fmt: string;
}
interface IUploadKeysRequest {
    device_keys?: Required<IDeviceKeys>;
    one_time_keys?: {
        [userId: string]: {
            [deviceId: string]: number;
        };
    };
    "org.matrix.msc2732.fallback_keys"?: Record<string, IOneTimeKey>;
}
interface IOpenIDToken {
    access_token: string;
    token_type: "Bearer" | string;
    matrix_server_name: string;
    expires_in: number;
}
interface IRoomInitialSyncResponse {
    room_id: string;
    membership: "invite" | "join" | "leave" | "ban";
    messages?: {
        start?: string;
        end?: string;
        chunk: IEventWithRoomId[];
    };
    state?: IStateEventWithRoomId[];
    visibility: Visibility;
    account_data?: IMinimalEvent[];
    presence: Partial<IEvent>;
}
interface IJoinedRoomsResponse {
    joined_rooms: string[];
}
interface IJoinedMembersResponse {
    joined: {
        [userId: string]: {
            display_name: string;
            avatar_url: string;
        };
    };
}
export interface IPublicRoomsChunkRoom {
    room_id: string;
    name?: string;
    avatar_url?: string;
    topic?: string;
    canonical_alias?: string;
    aliases?: string[];
    world_readable: boolean;
    guest_can_join: boolean;
    num_joined_members: number;
}
interface IPublicRoomsResponse {
    chunk: IPublicRoomsChunkRoom[];
    next_batch?: string;
    prev_batch?: string;
    total_room_count_estimate?: number;
}
interface IUserDirectoryResponse {
    results: {
        user_id: string;
        display_name?: string;
        avatar_url?: string;
    }[];
    limited: boolean;
}
export interface IMyDevice {
    device_id: string;
    display_name?: string;
    last_seen_ip?: string;
    last_seen_ts?: number;
}
interface IDownloadKeyResult {
    failures: {
        [serverName: string]: object;
    };
    device_keys: {
        [userId: string]: {
            [deviceId: string]: IDeviceKeys & {
                unsigned?: {
                    device_display_name: string;
                };
            };
        };
    };
}
interface IClaimOTKsResult {
    failures: {
        [serverName: string]: object;
    };
    one_time_keys: {
        [userId: string]: {
            [deviceId: string]: string;
        };
    };
}
export interface IFieldType {
    regexp: string;
    placeholder: string;
}
export interface IInstance {
    desc: string;
    icon?: string;
    fields: object;
    network_id: string;
    instance_id: string;
}
export interface IProtocol {
    user_fields: string[];
    location_fields: string[];
    icon: string;
    field_types: Record<string, IFieldType>;
    instances: IInstance[];
}
interface IThirdPartyLocation {
    alias: string;
    protocol: string;
    fields: object;
}
interface IThirdPartyUser {
    userid: string;
    protocol: string;
    fields: object;
}
interface IRoomSummary extends Omit<IPublicRoomsChunkRoom, "canonical_alias" | "aliases"> {
    room_type?: RoomType;
    membership?: string;
    is_encrypted: boolean;
}
/**
 * Represents a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 */
export declare class MatrixClient extends EventEmitter {
    static readonly RESTORE_BACKUP_ERROR_BAD_KEY = "RESTORE_BACKUP_ERROR_BAD_KEY";
    reEmitter: ReEmitter;
    olmVersion: [number, number, number];
    usingExternalCrypto: boolean;
    store: Store;
    deviceId?: string;
    credentials: {
        userId?: string;
    };
    pickleKey: string;
    scheduler: MatrixScheduler;
    clientRunning: boolean;
    timelineSupport: boolean;
    urlPreviewCache: {
        [key: string]: Promise<IPreviewUrlResponse>;
    };
    unstableClientRelationAggregation: boolean;
    identityServer: IIdentityServerProvider;
    sessionStore: SessionStore;
    http: MatrixHttpApi;
    crypto: Crypto;
    cryptoCallbacks: ICryptoCallbacks;
    callEventHandler: CallEventHandler;
    supportsCallTransfer: boolean;
    forceTURN: boolean;
    iceCandidatePoolSize: number;
    idBaseUrl: string;
    baseUrl: string;
    protected canSupportVoip: boolean;
    protected peekSync: SyncApi;
    protected isGuestAccount: boolean;
    protected ongoingScrollbacks: {
        [roomId: string]: {
            promise?: Promise<Room>;
            errorTs?: number;
        };
    };
    protected notifTimelineSet: EventTimelineSet;
    protected cryptoStore: CryptoStore;
    protected verificationMethods: VerificationMethod[];
    protected fallbackICEServerAllowed: boolean;
    protected roomList: RoomList;
    protected syncApi: SyncApi;
    pushRules: any;
    protected syncLeftRoomsPromise: Promise<Room[]>;
    protected syncedLeftRooms: boolean;
    protected clientOpts: IStoredClientOpts;
    protected clientWellKnownIntervalID: number;
    protected canResetTimelineCallback: ResetTimelineCallback;
    protected pushProcessor: PushProcessor;
    protected serverVersionsPromise: Promise<IServerVersions>;
    protected cachedCapabilities: {
        capabilities: ICapabilities;
        expiration: number;
    };
    protected clientWellKnown: IClientWellKnown;
    protected clientWellKnownPromise: Promise<IClientWellKnown>;
    protected turnServers: ITurnServer[];
    protected turnServersExpiry: number;
    protected checkTurnServersIntervalID: number;
    protected exportedOlmDeviceToImport: IOlmDevice;
    protected txnCtr: number;
    protected mediaHandler: MediaHandler;
    constructor(opts: IMatrixClientCreateOpts);
    /**
     * High level helper method to begin syncing and poll for new events. To listen for these
     * events, add a listener for {@link module:client~MatrixClient#event:"event"}
     * via {@link module:client~MatrixClient#on}. Alternatively, listen for specific
     * state change events.
     * @param {Object=} opts Options to apply when syncing.
     */
    startClient(opts: IStartClientOpts): Promise<void>;
    /**
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    stopClient(): void;
    /**
     * Try to rehydrate a device if available.  The client must have been
     * initialized with a `cryptoCallback.getDehydrationKey` option, and this
     * function must be called before initCrypto and startClient are called.
     *
     * @return {Promise<string>} Resolves to undefined if a device could not be dehydrated, or
     *     to the new device ID if the dehydration was successful.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    rehydrateDevice(): Promise<string>;
    /**
     * Get the current dehydrated device, if any
     * @return {Promise} A promise of an object containing the dehydrated device
     */
    getDehydratedDevice(): Promise<IDehydratedDevice>;
    /**
     * Set the dehydration key.  This will also periodically dehydrate devices to
     * the server.
     *
     * @param {Uint8Array} key the dehydration key
     * @param {IDehydratedDeviceKeyInfo} [keyInfo] Information about the key.  Primarily for
     *     information about how to generate the key from a passphrase.
     * @param {string} [deviceDisplayName] The device display name for the
     *     dehydrated device.
     * @return {Promise} A promise that resolves when the dehydrated device is stored.
     */
    setDehydrationKey(key: Uint8Array, keyInfo: IDehydratedDeviceKeyInfo, deviceDisplayName?: string): Promise<void>;
    /**
     * Creates a new dehydrated device (without queuing periodic dehydration)
     * @param {Uint8Array} key the dehydration key
     * @param {IDehydratedDeviceKeyInfo} [keyInfo] Information about the key.  Primarily for
     *     information about how to generate the key from a passphrase.
     * @param {string} [deviceDisplayName] The device display name for the
     *     dehydrated device.
     * @return {Promise<String>} the device id of the newly created dehydrated device
     */
    createDehydratedDevice(key: Uint8Array, keyInfo: IDehydratedDeviceKeyInfo, deviceDisplayName?: string): Promise<string>;
    exportDevice(): Promise<IExportedDevice>;
    /**
     * Clear any data out of the persistent stores used by the client.
     *
     * @returns {Promise} Promise which resolves when the stores have been cleared.
     */
    clearStores(): Promise<void>;
    /**
     * Get the user-id of the logged-in user
     *
     * @return {?string} MXID for the logged-in user, or null if not logged in
     */
    getUserId(): string;
    /**
     * Get the domain for this client's MXID
     * @return {?string} Domain of this MXID
     */
    getDomain(): string;
    /**
     * Get the local part of the current user ID e.g. "foo" in "@foo:bar".
     * @return {?string} The user ID localpart or null.
     */
    getUserIdLocalpart(): string;
    /**
     * Get the device ID of this client
     * @return {?string} device ID
     */
    getDeviceId(): string;
    /**
     * Check if the runtime environment supports VoIP calling.
     * @return {boolean} True if VoIP is supported.
     */
    supportsVoip(): boolean;
    /**
     * @returns {MediaHandler}
     */
    getMediaHandler(): MediaHandler;
    /**
     * Set whether VoIP calls are forced to use only TURN
     * candidates. This is the same as the forceTURN option
     * when creating the client.
     * @param {boolean} force True to force use of TURN servers
     */
    setForceTURN(force: boolean): void;
    /**
     * Set whether to advertise transfer support to other parties on Matrix calls.
     * @param {boolean} support True to advertise the 'm.call.transferee' capability
     */
    setSupportsCallTransfer(support: boolean): void;
    /**
     * Creates a new call.
     * The place*Call methods on the returned call can be used to actually place a call
     *
     * @param {string} roomId The room the call is to be placed in.
     * @return {MatrixCall} the call or null if the browser doesn't support calling.
     */
    createCall(roomId: string): MatrixCall;
    /**
     * Get the current sync state.
     * @return {?SyncState} the sync state, which may be null.
     * @see module:client~MatrixClient#event:"sync"
     */
    getSyncState(): SyncState;
    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     * @return {?Object}
     */
    getSyncStateData(): ISyncStateData | null;
    /**
     * Whether the initial sync has completed.
     * @return {boolean} True if at least one sync has happened.
     */
    isInitialSyncComplete(): boolean;
    /**
     * Return whether the client is configured for a guest account.
     * @return {boolean} True if this is a guest access_token (or no token is supplied).
     */
    isGuest(): boolean;
    /**
     * Set whether this client is a guest account. <b>This method is experimental
     * and may change without warning.</b>
     * @param {boolean} guest True if this is a guest account.
     */
    setGuest(guest: boolean): void;
    /**
     * Return the provided scheduler, if any.
     * @return {?module:scheduler~MatrixScheduler} The scheduler or null
     */
    getScheduler(): MatrixScheduler;
    /**
     * Retry a backed off syncing request immediately. This should only be used when
     * the user <b>explicitly</b> attempts to retry their lost connection.
     * @return {boolean} True if this resulted in a request being retried.
     */
    retryImmediately(): boolean;
    /**
     * Return the global notification EventTimelineSet, if any
     *
     * @return {EventTimelineSet} the globl notification EventTimelineSet
     */
    getNotifTimelineSet(): EventTimelineSet;
    /**
     * Set the global notification EventTimelineSet
     *
     * @param {EventTimelineSet} set
     */
    setNotifTimelineSet(set: EventTimelineSet): void;
    /**
     * Gets the capabilities of the homeserver. Always returns an object of
     * capability keys and their options, which may be empty.
     * @param {boolean} fresh True to ignore any cached values.
     * @return {Promise} Resolves to the capabilities of the homeserver
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getCapabilities(fresh?: boolean): Promise<ICapabilities>;
    /**
     * Initialise support for end-to-end encryption in this client
     *
     * You should call this method after creating the matrixclient, but *before*
     * calling `startClient`, if you want to support end-to-end encryption.
     *
     * It will return a Promise which will resolve when the crypto layer has been
     * successfully initialised.
     */
    initCrypto(): Promise<void>;
    /**
     * Is end-to-end crypto enabled for this client.
     * @return {boolean} True if end-to-end is enabled.
     */
    isCryptoEnabled(): boolean;
    /**
     * Get the Ed25519 key for this device
     *
     * @return {?string} base64-encoded ed25519 key. Null if crypto is
     *    disabled.
     */
    getDeviceEd25519Key(): string;
    /**
     * Get the Curve25519 key for this device
     *
     * @return {?string} base64-encoded curve25519 key. Null if crypto is
     *    disabled.
     */
    getDeviceCurve25519Key(): string;
    /**
     * Upload the device keys to the homeserver.
     * @return {Promise<void>} A promise that will resolve when the keys are uploaded.
     */
    uploadKeys(): Promise<void>;
    /**
     * Download the keys for a list of users and stores the keys in the session
     * store.
     * @param {Array} userIds The users to fetch.
     * @param {boolean} forceDownload Always download the keys even if cached.
     *
     * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
        * module:crypto~DeviceInfo|DeviceInfo}.
     */
    downloadKeys(userIds: string[], forceDownload?: boolean): Promise<Record<string, Record<string, IDevice>>>;
    /**
     * Get the stored device keys for a user id
     *
     * @param {string} userId the user to list keys for.
     *
     * @return {module:crypto/deviceinfo[]} list of devices
     */
    getStoredDevicesForUser(userId: string): DeviceInfo[];
    /**
     * Get the stored device key for a user id and device id
     *
     * @param {string} userId the user to list keys for.
     * @param {string} deviceId unique identifier for the device
     *
     * @return {module:crypto/deviceinfo} device or null
     */
    getStoredDevice(userId: string, deviceId: string): DeviceInfo;
    /**
     * Mark the given device as verified
     *
     * @param {string} userId owner of the device
     * @param {string} deviceId unique identifier for the device or user's
     * cross-signing public key ID.
     *
     * @param {boolean=} verified whether to mark the device as verified. defaults
     *   to 'true'.
     *
     * @returns {Promise}
     *
     * @fires module:client~event:MatrixClient"deviceVerificationChanged"
     */
    setDeviceVerified(userId: string, deviceId: string, verified?: boolean): Promise<void>;
    /**
     * Mark the given device as blocked/unblocked
     *
     * @param {string} userId owner of the device
     * @param {string} deviceId unique identifier for the device or user's
     * cross-signing public key ID.
     *
     * @param {boolean=} blocked whether to mark the device as blocked. defaults
     *   to 'true'.
     *
     * @returns {Promise}
     *
     * @fires module:client~event:MatrixClient"deviceVerificationChanged"
     */
    setDeviceBlocked(userId: string, deviceId: string, blocked?: boolean): Promise<void>;
    /**
     * Mark the given device as known/unknown
     *
     * @param {string} userId owner of the device
     * @param {string} deviceId unique identifier for the device or user's
     * cross-signing public key ID.
     *
     * @param {boolean=} known whether to mark the device as known. defaults
     *   to 'true'.
     *
     * @returns {Promise}
     *
     * @fires module:client~event:MatrixClient"deviceVerificationChanged"
     */
    setDeviceKnown(userId: string, deviceId: string, known?: boolean): Promise<void>;
    private setDeviceVerification;
    /**
     * Request a key verification from another user, using a DM.
     *
     * @param {string} userId the user to request verification with
     * @param {string} roomId the room to use for verification
     *
     * @returns {Promise<module:crypto/verification/request/VerificationRequest>} resolves to a VerificationRequest
     *    when the request has been sent to the other party.
     */
    requestVerificationDM(userId: string, roomId: string): Promise<VerificationRequest>;
    /**
     * Finds a DM verification request that is already in progress for the given room id
     *
     * @param {string} roomId the room to use for verification
     *
     * @returns {module:crypto/verification/request/VerificationRequest?} the VerificationRequest that is in progress, if any
     */
    findVerificationRequestDMInProgress(roomId: string): VerificationRequest;
    /**
     * Returns all to-device verification requests that are already in progress for the given user id
     *
     * @param {string} userId the ID of the user to query
     *
     * @returns {module:crypto/verification/request/VerificationRequest[]} the VerificationRequests that are in progress
     */
    getVerificationRequestsToDeviceInProgress(userId: string): VerificationRequest[];
    /**
     * Request a key verification from another user.
     *
     * @param {string} userId the user to request verification with
     * @param {Array} devices array of device IDs to send requests to.  Defaults to
     *    all devices owned by the user
     *
     * @returns {Promise<module:crypto/verification/request/VerificationRequest>} resolves to a VerificationRequest
     *    when the request has been sent to the other party.
     */
    requestVerification(userId: string, devices?: string[]): Promise<VerificationRequest>;
    /**
     * Begin a key verification.
     *
     * @param {string} method the verification method to use
     * @param {string} userId the user to verify keys with
     * @param {string} deviceId the device to verify
     *
     * @returns {Verification} a verification object
     * @deprecated Use `requestVerification` instead.
     */
    beginKeyVerification(method: string, userId: string, deviceId: string): Verification;
    checkSecretStorageKey(key: Uint8Array, info: ISecretStorageKeyInfo): Promise<boolean>;
    /**
     * Set the global override for whether the client should ever send encrypted
     * messages to unverified devices.  This provides the default for rooms which
     * do not specify a value.
     *
     * @param {boolean} value whether to blacklist all unverified devices by default
     */
    setGlobalBlacklistUnverifiedDevices(value: boolean): void;
    /**
     * @return {boolean} whether to blacklist all unverified devices by default
     */
    getGlobalBlacklistUnverifiedDevices(): boolean;
    /**
     * Set whether sendMessage in a room with unknown and unverified devices
     * should throw an error and not send them message. This has 'Global' for
     * symmetry with setGlobalBlacklistUnverifiedDevices but there is currently
     * no room-level equivalent for this setting.
     *
     * This API is currently UNSTABLE and may change or be removed without notice.
     *
     * @param {boolean} value whether error on unknown devices
     */
    setGlobalErrorOnUnknownDevices(value: boolean): void;
    /**
     * @return {boolean} whether to error on unknown devices
     *
     * This API is currently UNSTABLE and may change or be removed without notice.
     */
    getGlobalErrorOnUnknownDevices(): boolean;
    /**
     * Get the user's cross-signing key ID.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {CrossSigningKey} [type=master] The type of key to get the ID of.  One of
     *     "master", "self_signing", or "user_signing".  Defaults to "master".
     *
     * @returns {string} the key ID
     */
    getCrossSigningId(type?: CrossSigningKey | string): string;
    /**
     * Get the cross signing information for a given user.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {string} userId the user ID to get the cross-signing info for.
     *
     * @returns {CrossSigningInfo} the cross signing information for the user.
     */
    getStoredCrossSigningForUser(userId: string): CrossSigningInfo;
    /**
     * Check whether a given user is trusted.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {string} userId The ID of the user to check.
     *
     * @returns {UserTrustLevel}
     */
    checkUserTrust(userId: string): UserTrustLevel;
    /**
     * Check whether a given device is trusted.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @function module:client~MatrixClient#checkDeviceTrust
     * @param {string} userId The ID of the user whose devices is to be checked.
     * @param {string} deviceId The ID of the device to check
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceTrust(userId: string, deviceId: string): DeviceTrustLevel;
    /**
     * Check the copy of our cross-signing key that we have in the device list and
     * see if we can get the private key. If so, mark it as trusted.
     * @param {Object} opts ICheckOwnCrossSigningTrustOpts object
     */
    checkOwnCrossSigningTrust(opts?: ICheckOwnCrossSigningTrustOpts): Promise<void>;
    /**
     * Checks that a given cross-signing private key matches a given public key.
     * This can be used by the getCrossSigningKey callback to verify that the
     * private key it is about to supply is the one that was requested.
     * @param {Uint8Array} privateKey The private key
     * @param {string} expectedPublicKey The public key
     * @returns {boolean} true if the key matches, otherwise false
     */
    checkCrossSigningPrivateKey(privateKey: Uint8Array, expectedPublicKey: string): boolean;
    legacyDeviceVerification(userId: string, deviceId: string, method: VerificationMethod): Promise<VerificationRequest>;
    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     * @param {module:models/room} room the room the event is in
     */
    prepareToEncrypt(room: Room): void;
    /**
     * Checks whether cross signing:
     * - is enabled on this account and trusted by this device
     * - has private keys either cached locally or stored in secret storage
     *
     * If this function returns false, bootstrapCrossSigning() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapCrossSigning() completes successfully, this function should
     * return true.
     * @return {boolean} True if cross-signing is ready to be used on this device
     */
    isCrossSigningReady(): Promise<boolean>;
    /**
     * Bootstrap cross-signing by creating keys if needed. If everything is already
     * set up, then no changes are made, so this is safe to run to ensure
     * cross-signing is ready for use.
     *
     * This function:
     * - creates new cross-signing keys if they are not found locally cached nor in
     *   secret storage (if it has been setup)
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {function} opts.authUploadDeviceSigningKeys Function
     * called to await an interactive auth flow when uploading device signing keys.
     * @param {boolean} [opts.setupNewCrossSigning] Optional. Reset even if keys
     * already exist.
     * Args:
     *     {function} A function that makes the request requiring auth. Receives the
     *     auth data as an object. Can be called multiple times, first with an empty
     *     authDict, to obtain the flows.
     */
    bootstrapCrossSigning(opts: IBootstrapCrossSigningOpts): Promise<void>;
    /**
     * Whether to trust a others users signatures of their devices.
     * If false, devices will only be considered 'verified' if we have
     * verified that device individually (effectively disabling cross-signing).
     *
     * Default: true
     *
     * @return {boolean} True if trusting cross-signed devices
     */
    getCryptoTrustCrossSignedDevices(): boolean;
    /**
     * See getCryptoTrustCrossSignedDevices

     * This may be set before initCrypto() is called to ensure no races occur.
     *
     * @param {boolean} val True to trust cross-signed devices
     */
    setCryptoTrustCrossSignedDevices(val: boolean): void;
    /**
     * Counts the number of end to end session keys that are waiting to be backed up
     * @returns {Promise<int>} Resolves to the number of sessions requiring backup
     */
    countSessionsNeedingBackup(): Promise<number>;
    /**
     * Get information about the encryption of an event
     *
     * @param {module:models/event.MatrixEvent} event event to be checked
     * @returns {IEncryptedEventInfo} The event information.
     */
    getEventEncryptionInfo(event: MatrixEvent): IEncryptedEventInfo;
    /**
     * Create a recovery key from a user-supplied passphrase.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} password Passphrase string that can be entered by the user
     *     when restoring the backup as an alternative to entering the recovery key.
     *     Optional.
     * @returns {Promise<Object>} Object with public key metadata, encoded private
     *     recovery key which should be disposed of after displaying to the user,
     *     and raw private key to avoid round tripping if needed.
     */
    createRecoveryKeyFromPassphrase(password?: string): Promise<IRecoveryKey>;
    /**
     * Checks whether secret storage:
     * - is enabled on this account
     * - is storing cross-signing private keys
     * - is storing session backup key (if enabled)
     *
     * If this function returns false, bootstrapSecretStorage() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapSecretStorage() completes successfully, this function should
     * return true.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @return {boolean} True if secret storage is ready to be used on this device
     */
    isSecretStorageReady(): Promise<boolean>;
    /**
     * Bootstrap Secure Secret Storage if needed by creating a default key. If everything is
     * already set up, then no changes are made, so this is safe to run to ensure secret
     * storage is ready for use.
     *
     * This function
     * - creates a new Secure Secret Storage key if no default key exists
     *   - if a key backup exists, it is migrated to store the key in the Secret
     *     Storage
     * - creates a backup if none exists, and one is requested
     * - migrates Secure Secret Storage to use the latest algorithm, if an outdated
     *   algorithm is found
     *
     * @param opts
     */
    bootstrapSecretStorage(opts: ICreateSecretStorageOpts): Promise<void>;
    /**
     * Add a key for encrypting secrets.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} algorithm the algorithm used by the key
     * @param {object} opts the options for the algorithm.  The properties used
     *     depend on the algorithm given.
     * @param {string} [keyName] the name of the key.  If not given, a random name will be generated.
     *
     * @return {object} An object with:
     *     keyId: {string} the ID of the key
     *     keyInfo: {object} details about the key (iv, mac, passphrase)
     */
    addSecretStorageKey(algorithm: string, opts: IAddSecretStorageKeyOpts, keyName?: string): Promise<{
        keyId: string;
        keyInfo: ISecretStorageKeyInfo;
    }>;
    /**
     * Check whether we have a key with a given ID.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @return {boolean} Whether we have the key.
     */
    hasSecretStorageKey(keyId?: string): Promise<boolean>;
    /**
     * Store an encrypted secret on the server.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} name The name of the secret
     * @param {string} secret The secret contents.
     * @param {Array} keys The IDs of the keys to use to encrypt the secret or null/undefined
     *     to use the default (will throw if no default key is set).
     */
    storeSecret(name: string, secret: string, keys?: string[]): Promise<void>;
    /**
     * Get a secret from storage.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} name the name of the secret
     *
     * @return {string} the contents of the secret
     */
    getSecret(name: string): Promise<string>;
    /**
     * Check if a secret is stored on the server.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} name the name of the secret
     * @param {boolean} checkKey check if the secret is encrypted by a trusted
     *     key
     *
     * @return {object?} map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    isSecretStored(name: string, checkKey: boolean): Promise<Record<string, ISecretStorageKeyInfo>>;
    /**
     * Request a secret from another device.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} name the name of the secret to request
     * @param {string[]} devices the devices to request the secret from
     *
     * @return {ISecretRequest} the secret request object
     */
    requestSecret(name: string, devices: string[]): ISecretRequest;
    /**
     * Get the current default key ID for encrypting secrets.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @return {string} The default key ID or null if no default key ID is set
     */
    getDefaultSecretStorageKeyId(): Promise<string>;
    /**
     * Set the current default key ID for encrypting secrets.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {string} keyId The new default key ID
     */
    setDefaultSecretStorageKeyId(keyId: string): Promise<void>;
    /**
     * Checks that a given secret storage private key matches a given public key.
     * This can be used by the getSecretStorageKey callback to verify that the
     * private key it is about to supply is the one that was requested.
     *
     * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
     *
     * @param {Uint8Array} privateKey The private key
     * @param {string} expectedPublicKey The public key
     * @returns {boolean} true if the key matches, otherwise false
     */
    checkSecretStoragePrivateKey(privateKey: Uint8Array, expectedPublicKey: string): boolean;
    /**
     * Get e2e information on the device that sent an event
     *
     * @param {MatrixEvent} event event to be checked
     *
     * @return {Promise<module:crypto/deviceinfo?>}
     */
    getEventSenderDeviceInfo(event: MatrixEvent): Promise<DeviceInfo>;
    /**
     * Check if the sender of an event is verified
     *
     * @param {MatrixEvent} event event to be checked
     *
     * @return {boolean} true if the sender of this event has been verified using
     * {@link module:client~MatrixClient#setDeviceVerified|setDeviceVerified}.
     */
    isEventSenderVerified(event: MatrixEvent): Promise<boolean>;
    /**
     * Cancel a room key request for this event if one is ongoing and resend the
     * request.
     * @param  {MatrixEvent} event event of which to cancel and resend the room
     *                            key request.
     * @return {Promise} A promise that will resolve when the key request is queued
     */
    cancelAndResendEventRoomKeyRequest(event: MatrixEvent): Promise<void>;
    /**
     * Enable end-to-end encryption for a room. This does not modify room state.
     * Any messages sent before the returned promise resolves will be sent unencrypted.
     * @param {string} roomId The room ID to enable encryption in.
     * @param {object} config The encryption config for the room.
     * @return {Promise} A promise that will resolve when encryption is set up.
     */
    setRoomEncryption(roomId: string, config: IRoomEncryption): Promise<void>;
    /**
     * Whether encryption is enabled for a room.
     * @param {string} roomId the room id to query.
     * @return {boolean} whether encryption is enabled.
     */
    isRoomEncrypted(roomId: string): boolean;
    /**
     * Forces the current outbound group session to be discarded such
     * that another one will be created next time an event is sent.
     *
     * @param {string} roomId The ID of the room to discard the session for
     *
     * This should not normally be necessary.
     */
    forceDiscardSession(roomId: string): void;
    /**
     * Get a list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @return {Promise} a promise which resolves to a list of
     *    session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;
    /**
     * Import a list of room keys previously exported by exportRoomKeys
     *
     * @param {Object[]} keys a list of session export objects
     * @param {Object} opts
     * @param {Function} opts.progressCallback called with an object that has a "stage" param
     *
     * @return {Promise} a promise which resolves when the keys
     *    have been imported
     */
    importRoomKeys(keys: IMegolmSessionData[], opts?: IImportRoomKeysOpts): Promise<void>;
    /**
     * Force a re-check of the local key backup status against
     * what's on the server.
     *
     * @returns {Object} Object with backup info (as returned by
     *     getKeyBackupVersion) in backupInfo and
     *     trust information (as returned by isKeyBackupTrusted)
     *     in trustInfo.
     */
    checkKeyBackup(): Promise<IKeyBackupCheck>;
    /**
     * Get information about the current key backup.
     * @returns {Promise} Information object from API or null
     */
    getKeyBackupVersion(): Promise<IKeyBackupInfo>;
    /**
     * @param {object} info key backup info dict from getKeyBackupVersion()
     * @return {object} {
     *     usable: [bool], // is the backup trusted, true iff there is a sig that is valid & from a trusted device
     *     sigs: [
     *         valid: [bool],
     *         device: [DeviceInfo],
     *     ]
     * }
     */
    isKeyBackupTrusted(info: IKeyBackupInfo): Promise<TrustInfo>;
    /**
     * @returns {boolean} true if the client is configured to back up keys to
     *     the server, otherwise false. If we haven't completed a successful check
     *     of key backup status yet, returns null.
     */
    getKeyBackupEnabled(): boolean;
    /**
     * Enable backing up of keys, using data previously returned from
     * getKeyBackupVersion.
     *
     * @param {object} info Backup information object as returned by getKeyBackupVersion
     * @returns {Promise<void>} Resolves when complete.
     */
    enableKeyBackup(info: IKeyBackupInfo): Promise<void>;
    /**
     * Disable backing up of keys.
     */
    disableKeyBackup(): void;
    /**
     * Set up the data required to create a new backup version.  The backup version
     * will not be created and enabled until createKeyBackupVersion is called.
     *
     * @param {string} password Passphrase string that can be entered by the user
     *     when restoring the backup as an alternative to entering the recovery key.
     *     Optional.
     * @param {boolean} [opts.secureSecretStorage = false] Whether to use Secure
     *     Secret Storage to store the key encrypting key backups.
     *     Optional, defaults to false.
     *
     * @returns {Promise<object>} Object that can be passed to createKeyBackupVersion and
     *     additionally has a 'recovery_key' member with the user-facing recovery key string.
     */
    prepareKeyBackupVersion(password?: string, opts?: IKeyBackupPrepareOpts): Promise<Pick<IPreparedKeyBackupVersion, "algorithm" | "auth_data" | "recovery_key">>;
    /**
     * Check whether the key backup private key is stored in secret storage.
     * @return {Promise<object?>} map of key name to key info the secret is
     *     encrypted with, or null if it is not present or not encrypted with a
     *     trusted key
     */
    isKeyBackupKeyStored(): Promise<Record<string, ISecretStorageKeyInfo>>;
    /**
     * Create a new key backup version and enable it, using the information return
     * from prepareKeyBackupVersion.
     *
     * @param {object} info Info object from prepareKeyBackupVersion
     * @returns {Promise<object>} Object with 'version' param indicating the version created
     */
    createKeyBackupVersion(info: IKeyBackupInfo): Promise<IKeyBackupInfo>;
    deleteKeyBackupVersion(version: string): Promise<void>;
    private makeKeyBackupPath;
    /**
     * Back up session keys to the homeserver.
     * @param {string} roomId ID of the room that the keys are for Optional.
     * @param {string} sessionId ID of the session that the keys are for Optional.
     * @param {number} version backup version Optional.
     * @param {object} data Object keys to send
     * @return {Promise} a promise that will resolve when the keys
     * are uploaded
     */
    sendKeyBackup(roomId: string, sessionId: string, version: string, data: IKeyBackup): Promise<void>;
    /**
     * Marks all group sessions as needing to be backed up and schedules them to
     * upload in the background as soon as possible.
     */
    scheduleAllGroupSessionsForBackup(): Promise<void>;
    /**
     * Marks all group sessions as needing to be backed up without scheduling
     * them to upload in the background.
     * @returns {Promise<int>} Resolves to the number of sessions requiring a backup.
     */
    flagAllGroupSessionsForBackup(): Promise<number>;
    isValidRecoveryKey(recoveryKey: string): boolean;
    /**
     * Get the raw key for a key backup from the password
     * Used when migrating key backups into SSSS
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {string} password Passphrase
     * @param {object} backupInfo Backup metadata from `checkKeyBackup`
     * @return {Promise<Uint8Array>} key backup key
     */
    keyBackupKeyFromPassword(password: string, backupInfo: IKeyBackupInfo): Promise<Uint8Array>;
    /**
     * Get the raw key for a key backup from the recovery key
     * Used when migrating key backups into SSSS
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     *
     * @param {string} recoveryKey The recovery key
     * @return {Uint8Array} key backup key
     */
    keyBackupKeyFromRecoveryKey(recoveryKey: string): Uint8Array;
    /**
     * Restore from an existing key backup via a passphrase.
     *
     * @param {string} password Passphrase
     * @param {string} [targetRoomId] Room ID to target a specific room.
     * Restores all rooms if omitted.
     * @param {string} [targetSessionId] Session ID to target a specific session.
     * Restores all sessions if omitted.
     * @param {object} backupInfo Backup metadata from `checkKeyBackup`
     * @param {object} opts Optional params such as callbacks
     * @return {Promise<object>} Status of restoration with `total` and `imported`
     * key counts.
     */
    restoreKeyBackupWithPassword(password: string, targetRoomId: string, targetSessionId: string, backupInfo: IKeyBackupInfo, opts: IKeyBackupRestoreOpts): Promise<IKeyBackupRestoreResult>;
    /**
     * Restore from an existing key backup via a private key stored in secret
     * storage.
     *
     * @param {object} backupInfo Backup metadata from `checkKeyBackup`
     * @param {string} [targetRoomId] Room ID to target a specific room.
     * Restores all rooms if omitted.
     * @param {string} [targetSessionId] Session ID to target a specific session.
     * Restores all sessions if omitted.
     * @param {object} opts Optional params such as callbacks
     * @return {Promise<object>} Status of restoration with `total` and `imported`
     * key counts.
     */
    restoreKeyBackupWithSecretStorage(backupInfo: IKeyBackupInfo, targetRoomId?: string, targetSessionId?: string, opts?: IKeyBackupRestoreOpts): Promise<IKeyBackupRestoreResult>;
    /**
     * Restore from an existing key backup via an encoded recovery key.
     *
     * @param {string} recoveryKey Encoded recovery key
     * @param {string} [targetRoomId] Room ID to target a specific room.
     * Restores all rooms if omitted.
     * @param {string} [targetSessionId] Session ID to target a specific session.
     * Restores all sessions if omitted.
     * @param {object} backupInfo Backup metadata from `checkKeyBackup`
     * @param {object} opts Optional params such as callbacks

     * @return {Promise<object>} Status of restoration with `total` and `imported`
     * key counts.
     */
    restoreKeyBackupWithRecoveryKey(recoveryKey: string, targetRoomId: string, targetSessionId: string, backupInfo: IKeyBackupInfo, opts: IKeyBackupRestoreOpts): Promise<IKeyBackupRestoreResult>;
    restoreKeyBackupWithCache(targetRoomId: string, targetSessionId: string, backupInfo: IKeyBackupInfo, opts?: IKeyBackupRestoreOpts): Promise<IKeyBackupRestoreResult>;
    private restoreKeyBackup;
    deleteKeysFromBackup(roomId: string, sessionId: string, version: string): Promise<void>;
    /**
     * Share shared-history decryption keys with the given users.
     *
     * @param {string} roomId the room for which keys should be shared.
     * @param {array} userIds a list of users to share with.  The keys will be sent to
     *     all of the user's current devices.
     */
    sendSharedHistoryKeys(roomId: string, userIds: string[]): Promise<void>;
    /**
     * Get the group for the given group ID.
     * This function will return a valid group for any group for which a Group event
     * has been emitted.
     * @param {string} groupId The group ID
     * @return {Group} The Group or null if the group is not known or there is no data store.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroup(groupId: string): Group;
    /**
     * Retrieve all known groups.
     * @return {Group[]} A list of groups, or an empty list if there is no data store.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroups(): Group[];
    /**
     * Get the config for the media repository.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves with an object containing the config.
     */
    getMediaConfig(callback?: Callback): Promise<IMediaConfig>;
    /**
     * Get the room for the given room ID.
     * This function will return a valid room for any room for which a Room event
     * has been emitted. Note in particular that other events, eg. RoomState.members
     * will be emitted for a room before this function will return the given room.
     * @param {string} roomId The room ID
     * @return {Room} The Room or null if it doesn't exist or there is no data store.
     */
    getRoom(roomId: string): Room;
    /**
     * Retrieve all known rooms.
     * @return {Room[]} A list of rooms, or an empty list if there is no data store.
     */
    getRooms(): Room[];
    /**
     * Retrieve all rooms that should be displayed to the user
     * This is essentially getRooms() with some rooms filtered out, eg. old versions
     * of rooms that have been replaced or (in future) other rooms that have been
     * marked at the protocol level as not to be displayed to the user.
     * @return {Room[]} A list of rooms, or an empty list if there is no data store.
     */
    getVisibleRooms(): Room[];
    /**
     * Retrieve a user.
     * @param {string} userId The user ID to retrieve.
     * @return {?User} A user or null if there is no data store or the user does
     * not exist.
     */
    getUser(userId: string): User;
    /**
     * Retrieve all known users.
     * @return {User[]} A list of users, or an empty list if there is no data store.
     */
    getUsers(): User[];
    /**
     * Set account data event for the current user.
     * It will retry the request up to 5 times.
     * @param {string} eventType The event type
     * @param {Object} content the contents object for the event
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setAccountData(eventType: EventType | string, content: IContent, callback?: Callback): Promise<{}>;
    /**
     * Get account data event of given type for the current user.
     * @param {string} eventType The event type
     * @return {?object} The contents of the given account data event
     */
    getAccountData(eventType: string): MatrixEvent;
    /**
     * Get account data event of given type for the current user. This variant
     * gets account data directly from the homeserver if the local store is not
     * ready, which can be useful very early in startup before the initial sync.
     * @param {string} eventType The event type
     * @return {Promise} Resolves: The contents of the given account
     * data event.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getAccountDataFromServer(eventType: string): Promise<Record<string, any>>;
    /**
     * Gets the users that are ignored by this client
     * @returns {string[]} The array of users that are ignored (empty if none)
     */
    getIgnoredUsers(): string[];
    /**
     * Sets the users that the current user should ignore.
     * @param {string[]} userIds the user IDs to ignore
     * @param {module:client.callback} [callback] Optional.
     * @return {Promise} Resolves: an empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setIgnoredUsers(userIds: string[], callback?: Callback): Promise<{}>;
    /**
     * Gets whether or not a specific user is being ignored by this client.
     * @param {string} userId the user ID to check
     * @returns {boolean} true if the user is ignored, false otherwise
     */
    isUserIgnored(userId: string): boolean;
    /**
     * Join a room. If you have already joined the room, this will no-op.
     * @param {string} roomIdOrAlias The room ID or room alias to join.
     * @param {Object} opts Options when joining the room.
     * @param {boolean} opts.syncRoom True to do a room initial sync on the resulting
     * room. If false, the <strong>returned Room object will have no current state.
     * </strong> Default: true.
     * @param {boolean} opts.inviteSignUrl If the caller has a keypair 3pid invite, the signing URL is passed in this parameter.
     * @param {string[]} opts.viaServers The server names to try and join through in addition to those that are automatically chosen.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Room object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    joinRoom(roomIdOrAlias: string, opts?: IJoinRoomOpts, callback?: Callback): Promise<Room>;
    /**
     * Resend an event.
     * @param {MatrixEvent} event The event to resend.
     * @param {Room} room Optional. The room the event is in. Will update the
     * timeline entry if provided.
     * @return {Promise} Resolves: to an ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    resendEvent(event: MatrixEvent, room: Room): Promise<ISendEventResponse>;
    /**
     * Cancel a queued or unsent event.
     *
     * @param {MatrixEvent} event   Event to cancel
     * @throws Error if the event is not in QUEUED or NOT_SENT state
     */
    cancelPendingEvent(event: MatrixEvent): void;
    /**
     * @param {string} roomId
     * @param {string} name
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomName(roomId: string, name: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} topic
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomTopic(roomId: string, topic: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getRoomTags(roomId: string, callback?: Callback): Promise<unknown>;
    /**
     * @param {string} roomId
     * @param {string} tagName name of room tag to be set
     * @param {object} metadata associated with that tag to be stored
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomTag(roomId: string, tagName: string, metadata: ITagMetadata, callback?: Callback): Promise<{}>;
    /**
     * @param {string} roomId
     * @param {string} tagName name of room tag to be removed
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteRoomTag(roomId: string, tagName: string, callback?: Callback): Promise<void>;
    /**
     * @param {string} roomId
     * @param {string} eventType event type to be set
     * @param {object} content event content
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomAccountData(roomId: string, eventType: string, content: Record<string, any>, callback?: Callback): Promise<{}>;
    /**
     * Set a user's power level.
     * @param {string} roomId
     * @param {string} userId
     * @param {Number} powerLevel
     * @param {MatrixEvent} event
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPowerLevel(roomId: string, userId: string, powerLevel: number, event: MatrixEvent, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} eventType
     * @param {Object} content
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendEvent(roomId: string, eventType: string, content: IContent, txnId?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {object} eventObject An object with the partial structure of an event, to which event_id, user_id, room_id and origin_server_ts will be added.
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    private sendCompleteEvent;
    /**
     * encrypts the event if necessary; adds the event to the queue, or sends it; marks the event as sent/unsent
     * @param room
     * @param event
     * @param callback
     * @returns {Promise} returns a promise which resolves with the result of the send request
     * @private
     */
    private encryptAndSendEvent;
    private encryptEventIfNeeded;
    /**
     * Returns the eventType that should be used taking encryption into account
     * for a given eventType.
     * @param {MatrixClient} client the client
     * @param {string} roomId the room for the events `eventType` relates to
     * @param {string} eventType the event type
     * @return {string} the event type taking encryption into account
     */
    private getEncryptedIfNeededEventType;
    private updatePendingEventStatus;
    private sendEventHttpRequest;
    /**
     * @param {string} roomId
     * @param {string} eventId
     * @param {string} [txnId]  transaction id. One will be made up if not
     *    supplied.
     * @param {object|module:client.callback} cbOrOpts
     *    Options to pass on, may contain `reason`.
     *    Can be callback for backwards compatibility.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    redactEvent(roomId: string, eventId: string, txnId?: string, cbOrOpts?: Callback | IRedactOpts): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {Object} content
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendMessage(roomId: string, content: IContent, txnId?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendTextMessage(roomId: string, body: string, txnId?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendNotice(roomId: string, body: string, txnId?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} txnId Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendEmoteMessage(roomId: string, body: string, txnId?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} url
     * @param {Object} info
     * @param {string} text
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendImageMessage(roomId: string, url: string, info?: IImageInfo, text?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} url
     * @param {Object} info
     * @param {string} text
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendStickerMessage(roomId: string, url: string, info?: IImageInfo, text?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} htmlBody
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendHtmlMessage(roomId: string, body: string, htmlBody: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} htmlBody
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendHtmlNotice(roomId: string, body: string, htmlBody: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {string} body
     * @param {string} htmlBody
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to a ISendEventResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendHtmlEmote(roomId: string, body: string, htmlBody: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * Send a receipt.
     * @param {Event} event The event being acknowledged
     * @param {string} receiptType The kind of receipt e.g. "m.read"
     * @param {object} body Additional content to send alongside the receipt.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendReceipt(event: MatrixEvent, receiptType: string, body: any, callback?: Callback): Promise<{}>;
    /**
     * Send a read receipt.
     * @param {Event} event The event that has been read.
     * @param {object} opts The options for the read receipt.
     * @param {boolean} opts.hidden True to prevent the receipt from being sent to
     * other users and homeservers. Default false (send to everyone). <b>This
     * property is unstable and may change in the future.</b>
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendReadReceipt(event: MatrixEvent, opts?: {
        hidden?: boolean;
    }, callback?: Callback): Promise<{}>;
    /**
     * Set a marker to indicate the point in a room before which the user has read every
     * event. This can be retrieved from room account data (the event type is `m.fully_read`)
     * and displayed as a horizontal line in the timeline that is visually distinct to the
     * position of the user's own read receipt.
     * @param {string} roomId ID of the room that has been read
     * @param {string} rmEventId ID of the event that has been read
     * @param {MatrixEvent} rrEvent the event tracked by the read receipt. This is here for
     * convenience because the RR and the RM are commonly updated at the same time as each
     * other. The local echo of this receipt will be done if set. Optional.
     * @param {object} opts Options for the read markers
     * @param {object} opts.hidden True to hide the receipt from other users and homeservers.
     * <b>This property is unstable and may change in the future.</b>
     * @return {Promise} Resolves: the empty object, {}.
     */
    setRoomReadMarkers(roomId: string, rmEventId: string, rrEvent: MatrixEvent, opts: {
        hidden?: boolean;
    }): Promise<{}>;
    /**
     * Get a preview of the given URL as of (roughly) the given point in time,
     * described as an object with OpenGraph keys and associated values.
     * Attributes may be synthesized where actual OG metadata is lacking.
     * Caches results to prevent hammering the server.
     * @param {string} url The URL to get preview data for
     * @param {Number} ts The preferred point in time that the preview should
     * describe (ms since epoch).  The preview returned will either be the most
     * recent one preceding this timestamp if available, or failing that the next
     * most recent available preview.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Object of OG metadata.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * May return synthesized attributes if the URL lacked OG meta.
     */
    getUrlPreview(url: string, ts: number, callback?: Callback): Promise<IPreviewUrlResponse>;
    /**
     * @param {string} roomId
     * @param {boolean} isTyping
     * @param {Number} timeoutMs
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendTyping(roomId: string, isTyping: boolean, timeoutMs: number, callback?: Callback): Promise<{}>;
    /**
     * Determines the history of room upgrades for a given room, as far as the
     * client can see. Returns an array of Rooms where the first entry is the
     * oldest and the last entry is the newest (likely current) room. If the
     * provided room is not found, this returns an empty list. This works in
     * both directions, looking for older and newer rooms of the given room.
     * @param {string} roomId The room ID to search from
     * @param {boolean} verifyLinks If true, the function will only return rooms
     * which can be proven to be linked. For example, rooms which have a create
     * event pointing to an old room which the client is not aware of or doesn't
     * have a matching tombstone would not be returned.
     * @return {Room[]} An array of rooms representing the upgrade
     * history.
     */
    getRoomUpgradeHistory(roomId: string, verifyLinks?: boolean): Room[];
    /**
     * @param {string} roomId
     * @param {string} userId
     * @param {module:client.callback} callback Optional.
     * @param {string} reason Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    invite(roomId: string, userId: string, callback?: Callback, reason?: string): Promise<{}>;
    /**
     * Invite a user to a room based on their email address.
     * @param {string} roomId The room to invite the user to.
     * @param {string} email The email address to invite.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    inviteByEmail(roomId: string, email: string, callback?: Callback): Promise<{}>;
    /**
     * Invite a user to a room based on a third-party identifier.
     * @param {string} roomId The room to invite the user to.
     * @param {string} medium The medium to invite the user e.g. "email".
     * @param {string} address The address for the specified medium.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    inviteByThreePid(roomId: string, medium: string, address: string, callback?: Callback): Promise<{}>;
    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    leave(roomId: string, callback?: Callback): Promise<{}>;
    /**
     * Leaves all rooms in the chain of room upgrades based on the given room. By
     * default, this will leave all the previous and upgraded rooms, including the
     * given room. To only leave the given room and any previous rooms, keeping the
     * upgraded (modern) rooms untouched supply `false` to `includeFuture`.
     * @param {string} roomId The room ID to start leaving at
     * @param {boolean} includeFuture If true, the whole chain (past and future) of
     * upgraded rooms will be left.
     * @return {Promise} Resolves when completed with an object keyed
     * by room ID and value of the error encountered when leaving or null.
     */
    leaveRoomChain(roomId: string, includeFuture?: boolean): Promise<{
        [roomId: string]: Error | MatrixError | null;
    }>;
    /**
     * @param {string} roomId
     * @param {string} userId
     * @param {string} reason Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    ban(roomId: string, userId: string, reason?: string, callback?: Callback): Promise<{}>;
    /**
     * @param {string} roomId
     * @param {boolean} deleteRoom True to delete the room from the store on success.
     * Default: true.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    forget(roomId: string, deleteRoom?: boolean, callback?: Callback): Promise<{}>;
    /**
     * @param {string} roomId
     * @param {string} userId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Object (currently empty)
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    unban(roomId: string, userId: string, callback?: Callback): Promise<void>;
    /**
     * @param {string} roomId
     * @param {string} userId
     * @param {string} reason Optional.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    kick(roomId: string, userId: string, reason?: string, callback?: Callback): Promise<{}>;
    /**
     * This is an internal method.
     * @param {MatrixClient} client
     * @param {string} roomId
     * @param {string} userId
     * @param {string} membershipValue
     * @param {string} reason
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    private setMembershipState;
    private membershipChange;
    /**
     * Obtain a dict of actions which should be performed for this event according
     * to the push rules for this user.  Caches the dict on the event.
     * @param {MatrixEvent} event The event to get push actions for.
     * @return {module:pushprocessor~PushAction} A dict of actions to perform.
     */
    getPushActionsForEvent(event: MatrixEvent): IActionsObject;
    /**
     * @param {string} info The kind of info to set (e.g. 'avatar_url')
     * @param {Object} data The JSON object to set.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: to an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setProfileInfo(info: "avatar_url", data: {
        avatar_url: string;
    }, callback?: Callback): Promise<{}>;
    setProfileInfo(info: "displayname", data: {
        displayname: string;
    }, callback?: Callback): Promise<{}>;
    /**
     * @param {string} name
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setDisplayName(name: string, callback?: Callback): Promise<{}>;
    /**
     * @param {string} url
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: {} an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setAvatarUrl(url: string, callback?: Callback): Promise<{}>;
    /**
     * Turn an MXC URL into an HTTP one. <strong>This method is experimental and
     * may change.</strong>
     * @param {string} mxcUrl The MXC URL
     * @param {Number} width The desired width of the thumbnail.
     * @param {Number} height The desired height of the thumbnail.
     * @param {string} resizeMethod The thumbnail resize method to use, either
     * "crop" or "scale".
     * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
     * directly. Fetching such URLs will leak information about the user to
     * anyone they share a room with. If false, will return null for such URLs.
     * @return {?string} the avatar URL or null.
     */
    mxcUrlToHttp(mxcUrl: string, width?: number, height?: number, resizeMethod?: string, allowDirectLinks?: boolean): string | null;
    /**
     * Sets a new status message for the user. The message may be null/falsey
     * to clear the message.
     * @param {string} newMessage The new message to set.
     * @return {Promise} Resolves: to nothing
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    _unstable_setStatusMessage(newMessage: string): Promise<void>;
    /**
     * @param {Object} opts Options to apply
     * @param {string} opts.presence One of "online", "offline" or "unavailable"
     * @param {string} opts.status_msg The status message to attach.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws If 'presence' isn't a valid presence enum value.
     */
    setPresence(opts: IPresenceOpts, callback?: Callback): Promise<void>;
    /**
     * @param {string} userId The user to get presence for
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: The presence state for this user.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPresence(userId: string, callback?: Callback): Promise<unknown>;
    /**
     * Retrieve older messages from the given room and put them in the timeline.
     *
     * If this is called multiple times whilst a request is ongoing, the <i>same</i>
     * Promise will be returned. If there was a problem requesting scrollback, there
     * will be a small delay before another request can be made (to prevent tight-looping
     * when there is no connection).
     *
     * @param {Room} room The room to get older messages in.
     * @param {Integer} limit Optional. The maximum number of previous events to
     * pull in. Default: 30.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Room. If you are at the beginning
     * of the timeline, <code>Room.oldState.paginationToken</code> will be
     * <code>null</code>.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    scrollback(room: Room, limit: number, callback?: Callback): Promise<Room>;
    /**
     * @param {object} [options]
     * @param {boolean} options.preventReEmit don't re-emit events emitted on an event mapped by this mapper on the client
     * @param {boolean} options.decrypt decrypt event proactively
     * @return {Function}
     */
    getEventMapper(options?: MapperOpts): EventMapper;
    /**
     * Get an EventTimeline for the given event
     *
     * <p>If the EventTimelineSet object already has the given event in its store, the
     * corresponding timeline will be returned. Otherwise, a /context request is
     * made, and used to construct an EventTimeline.
     *
     * @param {EventTimelineSet} timelineSet  The timelineSet to look for the event in
     * @param {string} eventId  The ID of the event to look for
     *
     * @return {Promise} Resolves:
     *    {@link module:models/event-timeline~EventTimeline} including the given
     *    event
     */
    getEventTimeline(timelineSet: EventTimelineSet, eventId: string): Promise<EventTimeline>;
    /**
     * Makes a request to /messages with the appropriate lazy loading filter set.
     * XXX: if we do get rid of scrollback (as it's not used at the moment),
     * we could inline this method again in paginateEventTimeline as that would
     * then be the only call-site
     * @param {string} roomId
     * @param {string} fromToken
     * @param {number} limit the maximum amount of events the retrieve
     * @param {string} dir 'f' or 'b'
     * @param {Filter} timelineFilter the timeline filter to pass
     * @return {Promise}
     */
    createMessagesRequest(roomId: string, fromToken: string, limit: number, dir: Direction, timelineFilter?: Filter): Promise<IMessagesResponse>;
    /**
     * Take an EventTimeline, and back/forward-fill results.
     *
     * @param {module:models/event-timeline~EventTimeline} eventTimeline timeline
     *    object to be updated
     * @param {Object}   [opts]
     * @param {boolean}     [opts.backwards = false]  true to fill backwards,
     *    false to go forwards
     * @param {number}   [opts.limit = 30]         number of events to request
     *
     * @return {Promise} Resolves to a boolean: false if there are no
     *    events and we reached either end of the timeline; else true.
     */
    paginateEventTimeline(eventTimeline: EventTimeline, opts: IPaginateOpts): Promise<boolean>;
    /**
     * Reset the notifTimelineSet entirely, paginating in some historical notifs as
     * a starting point for subsequent pagination.
     */
    resetNotifTimelineSet(): void;
    /**
     * Peek into a room and receive updates about the room. This only works if the
     * history visibility for the room is world_readable.
     * @param {String} roomId The room to attempt to peek into.
     * @return {Promise} Resolves: Room object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    peekInRoom(roomId: string): Promise<Room>;
    /**
     * Stop any ongoing room peeking.
     */
    stopPeeking(): void;
    /**
     * Set r/w flags for guest access in a room.
     * @param {string} roomId The room to configure guest access in.
     * @param {Object} opts Options
     * @param {boolean} opts.allowJoin True to allow guests to join this room. This
     * implicitly gives guests write access. If false or not given, guests are
     * explicitly forbidden from joining the room.
     * @param {boolean} opts.allowRead True to set history visibility to
     * be world_readable. This gives guests read access *from this point forward*.
     * If false or not given, history visibility is not modified.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setGuestAccess(roomId: string, opts: IGuestAccessOpts): Promise<void>;
    /**
     * Requests an email verification token for the purposes of registration.
     * This API requests a token from the homeserver.
     * The doesServerRequireIdServerParam() method can be used to determine if
     * the server requires the id_server parameter to be provided.
     *
     * Parameters and return value are as for requestEmailToken

     * @param {string} email As requestEmailToken
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestRegisterEmailToken(email: string, clientSecret: string, sendAttempt: number, nextLink?: string): Promise<IRequestTokenResponse>;
    /**
     * Requests a text message verification token for the purposes of registration.
     * This API requests a token from the homeserver.
     * The doesServerRequireIdServerParam() method can be used to determine if
     * the server requires the id_server parameter to be provided.
     *
     * @param {string} phoneCountry The ISO 3166-1 alpha-2 code for the country in which
     *    phoneNumber should be parsed relative to.
     * @param {string} phoneNumber The phone number, in national or international format
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestRegisterMsisdnToken(phoneCountry: string, phoneNumber: string, clientSecret: string, sendAttempt: number, nextLink?: string): Promise<IRequestMsisdnTokenResponse>;
    /**
     * Requests an email verification token for the purposes of adding a
     * third party identifier to an account.
     * This API requests a token from the homeserver.
     * The doesServerRequireIdServerParam() method can be used to determine if
     * the server requires the id_server parameter to be provided.
     * If an account with the given email address already exists and is
     * associated with an account other than the one the user is authed as,
     * it will either send an email to the address informing them of this
     * or return M_THREEPID_IN_USE (which one is up to the homeserver).
     *
     * @param {string} email As requestEmailToken
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestAdd3pidEmailToken(email: string, clientSecret: string, sendAttempt: number, nextLink?: string): Promise<IRequestTokenResponse>;
    /**
     * Requests a text message verification token for the purposes of adding a
     * third party identifier to an account.
     * This API proxies the identity server /validate/email/requestToken API,
     * adding specific behaviour for the addition of phone numbers to an
     * account, as requestAdd3pidEmailToken.
     *
     * @param {string} phoneCountry As requestRegisterMsisdnToken
     * @param {string} phoneNumber As requestRegisterMsisdnToken
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestAdd3pidMsisdnToken(phoneCountry: string, phoneNumber: string, clientSecret: string, sendAttempt: number, nextLink?: string): Promise<IRequestMsisdnTokenResponse>;
    /**
     * Requests an email verification token for the purposes of resetting
     * the password on an account.
     * This API proxies the identity server /validate/email/requestToken API,
     * adding specific behaviour for the password resetting. Specifically,
     * if no account with the given email address exists, it may either
     * return M_THREEPID_NOT_FOUND or send an email
     * to the address informing them of this (which one is up to the homeserver).
     *
     * requestEmailToken calls the equivalent API directly on the identity server,
     * therefore bypassing the password reset specific logic.
     *
     * @param {string} email As requestEmailToken
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @param {module:client.callback} callback Optional. As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestPasswordEmailToken(email: string, clientSecret: string, sendAttempt: number, nextLink?: string): Promise<IRequestTokenResponse>;
    /**
     * Requests a text message verification token for the purposes of resetting
     * the password on an account.
     * This API proxies the identity server /validate/email/requestToken API,
     * adding specific behaviour for the password resetting, as requestPasswordEmailToken.
     *
     * @param {string} phoneCountry As requestRegisterMsisdnToken
     * @param {string} phoneNumber As requestRegisterMsisdnToken
     * @param {string} clientSecret As requestEmailToken
     * @param {number} sendAttempt As requestEmailToken
     * @param {string} nextLink As requestEmailToken
     * @return {Promise} Resolves: As requestEmailToken
     */
    requestPasswordMsisdnToken(phoneCountry: string, phoneNumber: string, clientSecret: string, sendAttempt: number, nextLink: string): Promise<IRequestMsisdnTokenResponse>;
    /**
     * Internal utility function for requesting validation tokens from usage-specific
     * requestToken endpoints.
     *
     * @param {string} endpoint The endpoint to send the request to
     * @param {object} params Parameters for the POST request
     * @return {Promise} Resolves: As requestEmailToken
     */
    private requestTokenFromEndpoint;
    /**
     * Get the room-kind push rule associated with a room.
     * @param {string} scope "global" or device-specific.
     * @param {string} roomId the id of the room.
     * @return {object} the rule or undefined.
     */
    getRoomPushRule(scope: string, roomId: string): any;
    /**
     * Set a room-kind muting push rule in a room.
     * The operation also updates MatrixClient.pushRules at the end.
     * @param {string} scope "global" or device-specific.
     * @param {string} roomId the id of the room.
     * @param {boolean} mute the mute state.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomMutePushRule(scope: string, roomId: string, mute: boolean): Promise<void> | void;
    searchMessageText(opts: ISearchOpts, callback?: Callback): Promise<ISearchResponse>;
    /**
     * Perform a server-side search for room events.
     *
     * The returned promise resolves to an object containing the fields:
     *
     *  * {number}  count:       estimate of the number of results
     *  * {string}  next_batch:  token for back-pagination; if undefined, there are
     *                           no more results
     *  * {Array}   highlights:  a list of words to highlight from the stemming
     *                           algorithm
     *  * {Array}   results:     a list of results
     *
     * Each entry in the results list is a {module:models/search-result.SearchResult}.
     *
     * @param {Object} opts
     * @param {string} opts.term     the term to search for
     * @param {Object} opts.filter   a JSON filter object to pass in the request
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    searchRoomEvents(opts: IEventSearchOpts): Promise<ISearchResults>;
    /**
     * Take a result from an earlier searchRoomEvents call, and backfill results.
     *
     * @param  {object} searchResults  the results object to be updated
     * @return {Promise} Resolves: updated result object
     * @return {Error} Rejects: with an error response.
     */
    backPaginateRoomEventsSearch<T extends ISearchResults>(searchResults: T): Promise<T>;
    /**
     * helper for searchRoomEvents and backPaginateRoomEventsSearch. Processes the
     * response from the API call and updates the searchResults
     *
     * @param {Object} searchResults
     * @param {Object} response
     * @return {Object} searchResults
     * @private
     */
    processRoomEventsSearch<T extends ISearchResults>(searchResults: T, response: ISearchResponse): T;
    /**
     * Populate the store with rooms the user has left.
     * @return {Promise} Resolves: TODO - Resolved when the rooms have
     * been added to the data store.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    syncLeftRooms(): Promise<Room[]>;
    /**
     * Create a new filter.
     * @param {Object} content The HTTP body for the request
     * @return {Filter} Resolves to a Filter object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createFilter(content: IFilterDefinition): Promise<Filter>;
    /**
     * Retrieve a filter.
     * @param {string} userId The user ID of the filter owner
     * @param {string} filterId The filter ID to retrieve
     * @param {boolean} allowCached True to allow cached filters to be returned.
     * Default: True.
     * @return {Promise} Resolves: a Filter object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getFilter(userId: string, filterId: string, allowCached: boolean): Promise<Filter>;
    /**
     * @param {string} filterName
     * @param {Filter} filter
     * @return {Promise<String>} Filter ID
     */
    getOrCreateFilter(filterName: string, filter: Filter): Promise<string>;
    /**
     * Gets a bearer token from the homeserver that the user can
     * present to a third party in order to prove their ownership
     * of the Matrix account they are logged into.
     * @return {Promise} Resolves: Token object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getOpenIdToken(): Promise<IOpenIDToken>;
    private startCallEventHandler;
    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: ITurnServerResponse object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    turnServer(callback?: Callback): Promise<ITurnServerResponse>;
    /**
     * Get the TURN servers for this homeserver.
     * @return {Array<Object>} The servers or an empty list.
     */
    getTurnServers(): ITurnServer[];
    /**
     * Get the unix timestamp (in seconds) at which the current
     * TURN credentials (from getTurnServers) expire
     * @return {number} The expiry timestamp, in seconds, or null if no credentials
     */
    getTurnServersExpiry(): number | null;
    checkTurnServers(): Promise<boolean>;
    /**
     * Set whether to allow a fallback ICE server should be used for negotiating a
     * WebRTC connection if the homeserver doesn't provide any servers. Defaults to
     * false.
     *
     * @param {boolean} allow
     */
    setFallbackICEServerAllowed(allow: boolean): void;
    /**
     * Get whether to allow a fallback ICE server should be used for negotiating a
     * WebRTC connection if the homeserver doesn't provide any servers. Defaults to
     * false.
     *
     * @returns {boolean}
     */
    isFallbackICEServerAllowed(): boolean;
    /**
     * Determines if the current user is an administrator of the Synapse homeserver.
     * Returns false if untrue or the homeserver does not appear to be a Synapse
     * homeserver. <strong>This function is implementation specific and may change
     * as a result.</strong>
     * @return {boolean} true if the user appears to be a Synapse administrator.
     */
    isSynapseAdministrator(): Promise<boolean>;
    /**
     * Performs a whois lookup on a user using Synapse's administrator API.
     * <strong>This function is implementation specific and may change as a
     * result.</strong>
     * @param {string} userId the User ID to look up.
     * @return {object} the whois response - see Synapse docs for information.
     */
    whoisSynapseUser(userId: string): Promise<ISynapseAdminWhoisResponse>;
    /**
     * Deactivates a user using Synapse's administrator API. <strong>This
     * function is implementation specific and may change as a result.</strong>
     * @param {string} userId the User ID to deactivate.
     * @return {object} the deactivate response - see Synapse docs for information.
     */
    deactivateSynapseUser(userId: string): Promise<ISynapseAdminDeactivateResponse>;
    private fetchClientWellKnown;
    getClientWellKnown(): IClientWellKnown;
    waitForClientWellKnown(): Promise<IClientWellKnown>;
    /**
     * store client options with boolean/string/numeric values
     * to know in the next session what flags the sync data was
     * created with (e.g. lazy loading)
     * @param {object} opts the complete set of client options
     * @return {Promise} for store operation
     */
    storeClientOptions(): Promise<void>;
    /**
     * Gets a set of room IDs in common with another user
     * @param {string} userId The userId to check.
     * @return {Promise<string[]>} Resolves to a set of rooms
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    _unstable_getSharedRooms(userId: string): Promise<string[]>;
    /**
     * Get the API versions supported by the server, along with any
     * unstable APIs it supports
     * @return {Promise<object>} The server /versions response
     */
    getVersions(): Promise<IServerVersions>;
    /**
     * Check if a particular spec version is supported by the server.
     * @param {string} version The spec version (such as "r0.5.0") to check for.
     * @return {Promise<bool>} Whether it is supported
     */
    isVersionSupported(version: string): Promise<boolean>;
    /**
     * Query the server to see if it support members lazy loading
     * @return {Promise<boolean>} true if server supports lazy loading
     */
    doesServerSupportLazyLoading(): Promise<boolean>;
    /**
     * Query the server to see if the `id_server` parameter is required
     * when registering with an 3pid, adding a 3pid or resetting password.
     * @return {Promise<boolean>} true if id_server parameter is required
     */
    doesServerRequireIdServerParam(): Promise<boolean>;
    /**
     * Query the server to see if the `id_access_token` parameter can be safely
     * passed to the homeserver. Some homeservers may trigger errors if they are not
     * prepared for the new parameter.
     * @return {Promise<boolean>} true if id_access_token can be sent
     */
    doesServerAcceptIdentityAccessToken(): Promise<boolean>;
    /**
     * Query the server to see if it supports separate 3PID add and bind functions.
     * This affects the sequence of API calls clients should use for these operations,
     * so it's helpful to be able to check for support.
     * @return {Promise<boolean>} true if separate functions are supported
     */
    doesServerSupportSeparateAddAndBind(): Promise<boolean>;
    /**
     * Query the server to see if it lists support for an unstable feature
     * in the /versions response
     * @param {string} feature the feature name
     * @return {Promise<boolean>} true if the feature is supported
     */
    doesServerSupportUnstableFeature(feature: string): Promise<boolean>;
    /**
     * Query the server to see if it is forcing encryption to be enabled for
     * a given room preset, based on the /versions response.
     * @param {Preset} presetName The name of the preset to check.
     * @returns {Promise<boolean>} true if the server is forcing encryption
     * for the preset.
     */
    doesServerForceEncryptionForPreset(presetName: Preset): Promise<boolean>;
    /**
     * Get if lazy loading members is being used.
     * @return {boolean} Whether or not members are lazy loaded by this client
     */
    hasLazyLoadMembersEnabled(): boolean;
    /**
     * Set a function which is called when /sync returns a 'limited' response.
     * It is called with a room ID and returns a boolean. It should return 'true' if the SDK
     * can SAFELY remove events from this room. It may not be safe to remove events if there
     * are other references to the timelines for this room, e.g because the client is
     * actively viewing events in this room.
     * Default: returns false.
     * @param {Function} cb The callback which will be invoked.
     */
    setCanResetTimelineCallback(cb: ResetTimelineCallback): void;
    /**
     * Get the callback set via `setCanResetTimelineCallback`.
     * @return {?Function} The callback or null
     */
    getCanResetTimelineCallback(): ResetTimelineCallback;
    /**
     * Returns relations for a given event. Handles encryption transparently,
     * with the caveat that the amount of events returned might be 0, even though you get a nextBatch.
     * When the returned promise resolves, all messages should have finished trying to decrypt.
     * @param {string} roomId the room of the event
     * @param {string} eventId the id of the event
     * @param {string} relationType the rel_type of the relations requested
     * @param {string} eventType the event type of the relations requested
     * @param {Object} opts options with optional values for the request.
     * @param {Object} opts.from the pagination token returned from a previous request as `nextBatch` to return following relations.
     * @return {Object} an object with `events` as `MatrixEvent[]` and optionally `nextBatch` if more relations are available.
     */
    relations(roomId: string, eventId: string, relationType: string, eventType: string, opts: {
        from: string;
    }): Promise<{
        originalEvent: MatrixEvent;
        events: MatrixEvent[];
        nextBatch?: string;
    }>;
    /**
     * The app may wish to see if we have a key cached without
     * triggering a user interaction.
     * @return {object}
     */
    getCrossSigningCacheCallbacks(): ICacheCallbacks;
    /**
     * Generates a random string suitable for use as a client secret. <strong>This
     * method is experimental and may change.</strong>
     * @return {string} A new client secret
     */
    generateClientSecret(): string;
    /**
     * Attempts to decrypt an event
     * @param {MatrixEvent} event The event to decrypt
     * @returns {Promise<void>} A decryption promise
     * @param {object} options
     * @param {boolean} options.isRetry True if this is a retry (enables more logging)
     * @param {boolean} options.emit Emits "event.decrypted" if set to true
     */
    decryptEventIfNeeded(event: MatrixEvent, options?: IDecryptOptions): Promise<void>;
    private termsUrlForService;
    /**
     * Get the Homeserver URL of this client
     * @return {string} Homeserver URL of this client
     */
    getHomeserverUrl(): string;
    /**
     * Get the identity server URL of this client
     * @param {boolean} stripProto whether or not to strip the protocol from the URL
     * @return {string} Identity server URL of this client
     */
    getIdentityServerUrl(stripProto?: boolean): string;
    /**
     * Set the identity server URL of this client
     * @param {string} url New identity server URL
     */
    setIdentityServerUrl(url: string): void;
    /**
     * Get the access token associated with this account.
     * @return {?String} The access_token or null
     */
    getAccessToken(): string;
    /**
     * @return {boolean} true if there is a valid access_token for this client.
     */
    isLoggedIn(): boolean;
    /**
     * Make up a new transaction id
     *
     * @return {string} a new, unique, transaction id
     */
    makeTxnId(): string;
    /**
     * Check whether a username is available prior to registration. An error response
     * indicates an invalid/unavailable username.
     * @param {string} username The username to check the availability of.
     * @return {Promise} Resolves: to `true`.
     */
    isUsernameAvailable(username: string): Promise<true>;
    /**
     * @param {string} username
     * @param {string} password
     * @param {string} sessionId
     * @param {Object} auth
     * @param {Object} bindThreepids Set key 'email' to true to bind any email
     *     threepid uses during registration in the identity server. Set 'msisdn' to
     *     true to bind msisdn.
     * @param {string} guestAccessToken
     * @param {string} inhibitLogin
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    register(username: string, password: string, sessionId: string | null, auth: {
        session?: string;
        type: string;
    }, bindThreepids?: boolean | null | {
        email?: boolean;
        msisdn?: boolean;
    }, guestAccessToken?: string, inhibitLogin?: boolean, callback?: Callback): Promise<any>;
    /**
     * Register a guest account.
     * This method returns the auth info needed to create a new authenticated client,
     * Remember to call `setGuest(true)` on the (guest-)authenticated client, e.g:
     * ```javascript
     * const tmpClient = await sdk.createClient(MATRIX_INSTANCE);
     * const { user_id, device_id, access_token } = tmpClient.registerGuest();
     * const client = createClient({
     *   baseUrl: MATRIX_INSTANCE,
     *   accessToken: access_token,
     *   userId: user_id,
     *   deviceId: device_id,
     * })
     * client.setGuest(true);
     * ```
     *
     * @param {Object=} opts Registration options
     * @param {Object} opts.body JSON HTTP body to provide.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: JSON object that contains:
     *                   { user_id, device_id, access_token, home_server }
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerGuest(opts: {
        body?: any;
    }, callback?: Callback): Promise<any>;
    /**
     * @param {Object} data   parameters for registration request
     * @param {string=} kind  type of user to register. may be "guest"
     * @param {module:client.callback=} callback
     * @return {Promise} Resolves: to the /register response
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerRequest(data: any, kind?: string, callback?: Callback): Promise<any>;
    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginFlows(callback?: Callback): Promise<any>;
    /**
     * @param {string} loginType
     * @param {Object} data
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    login(loginType: string, data: any, callback?: Callback): Promise<any>;
    /**
     * @param {string} user
     * @param {string} password
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithPassword(user: string, password: string, callback?: Callback): Promise<any>;
    /**
     * @param {string} relayState URL Callback after SAML2 Authentication
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithSAML2(relayState: string, callback?: Callback): Promise<any>;
    /**
     * @param {string} redirectUrl The URL to redirect to after the HS
     * authenticates with CAS.
     * @return {string} The HS URL to hit to begin the CAS login process.
     */
    getCasLoginUrl(redirectUrl: string): string;
    /**
     * @param {string} redirectUrl The URL to redirect to after the HS
     *     authenticates with the SSO.
     * @param {string} loginType The type of SSO login we are doing (sso or cas).
     *     Defaults to 'sso'.
     * @param {string} idpId The ID of the Identity Provider being targeted, optional.
     * @return {string} The HS URL to hit to begin the SSO login process.
     */
    getSsoLoginUrl(redirectUrl: string, loginType?: string, idpId?: string): string;
    /**
     * @param {string} token Login token previously received from homeserver
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithToken(token: string, callback?: Callback): Promise<any>;
    /**
     * Logs out the current session.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: On success, the empty object
     */
    logout(callback?: Callback): Promise<{}>;
    /**
     * Deactivates the logged-in account.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @param {boolean} erase Optional. If set, send as `erase` attribute in the
     * JSON request body, indicating whether the account should be erased. Defaults
     * to false.
     * @return {Promise} Resolves: On success, the empty object
     */
    deactivateAccount(auth?: any, erase?: boolean): Promise<{}>;
    /**
     * Get the fallback URL to use for unknown interactive-auth stages.
     *
     * @param {string} loginType     the type of stage being attempted
     * @param {string} authSessionId the auth session ID provided by the homeserver
     *
     * @return {string} HS URL to hit to for the fallback interface
     */
    getFallbackAuthUrl(loginType: string, authSessionId: string): string;
    /**
     * Create a new room.
     * @param {Object} options a list of options to pass to the /createRoom API.
     * @param {string} options.room_alias_name The alias localpart to assign to
     * this room.
     * @param {string} options.visibility Either 'public' or 'private'.
     * @param {string[]} options.invite A list of user IDs to invite to this room.
     * @param {string} options.name The name to give this room.
     * @param {string} options.topic The topic to give this room.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: <code>{room_id: {string}}</code>
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createRoom(options: ICreateRoomOpts, callback?: Callback): Promise<{
        room_id: string;
    }>;
    /**
     * Fetches relations for a given event
     * @param {string} roomId the room of the event
     * @param {string} eventId the id of the event
     * @param {string} relationType the rel_type of the relations requested
     * @param {string} eventType the event type of the relations requested
     * @param {Object} opts options with optional values for the request.
     * @param {Object} opts.from the pagination token returned from a previous request as `next_batch` to return following relations.
     * @return {Object} the response, with chunk and next_batch.
     */
    fetchRelations(roomId: string, eventId: string, relationType: string, eventType: string, opts: {
        from: string;
    }): Promise<any>;
    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    roomState(roomId: string, callback?: Callback): Promise<IStateEventWithRoomId[]>;
    /**
     * Get an event in a room by its event id.
     * @param {string} roomId
     * @param {string} eventId
     * @param {module:client.callback} callback Optional.
     *
     * @return {Promise} Resolves to an object containing the event.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    fetchRoomEvent(roomId: string, eventId: string, callback?: Callback): Promise<IMinimalEvent>;
    /**
     * @param {string} roomId
     * @param {string} includeMembership the membership type to include in the response
     * @param {string} excludeMembership the membership type to exclude from the response
     * @param {string} atEventId the id of the event for which moment in the timeline the members should be returned for
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: dictionary of userid to profile information
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    members(roomId: string, includeMembership?: string[], excludeMembership?: string[], atEventId?: string, callback?: Callback): Promise<{
        [userId: string]: IStateEventWithRoomId;
    }>;
    /**
     * Upgrades a room to a new protocol version
     * @param {string} roomId
     * @param {string} newVersion The target version to upgrade to
     * @return {Promise} Resolves: Object with key 'replacement_room'
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    upgradeRoom(roomId: string, newVersion: string): Promise<{
        replacement_room: string;
    }>;
    /**
     * Retrieve a state event.
     * @param {string} roomId
     * @param {string} eventType
     * @param {string} stateKey
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getStateEvent(roomId: string, eventType: string, stateKey: string, callback?: Callback): Promise<IStateEventWithRoomId>;
    /**
     * @param {string} roomId
     * @param {string} eventType
     * @param {Object} content
     * @param {string} stateKey
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendStateEvent(roomId: string, eventType: string, content: any, stateKey?: string, callback?: Callback): Promise<ISendEventResponse>;
    /**
     * @param {string} roomId
     * @param {Number} limit
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    roomInitialSync(roomId: string, limit: number, callback?: Callback): Promise<IRoomInitialSyncResponse>;
    /**
     * Set a marker to indicate the point in a room before which the user has read every
     * event. This can be retrieved from room account data (the event type is `m.fully_read`)
     * and displayed as a horizontal line in the timeline that is visually distinct to the
     * position of the user's own read receipt.
     * @param {string} roomId ID of the room that has been read
     * @param {string} rmEventId ID of the event that has been read
     * @param {string} rrEventId ID of the event tracked by the read receipt. This is here
     * for convenience because the RR and the RM are commonly updated at the same time as
     * each other. Optional.
     * @param {object} opts Options for the read markers.
     * @param {object} opts.hidden True to hide the read receipt from other users. <b>This
     * property is currently unstable and may change in the future.</b>
     * @return {Promise} Resolves: the empty object, {}.
     */
    setRoomReadMarkersHttpRequest(roomId: string, rmEventId: string, rrEventId: string, opts: {
        hidden?: boolean;
    }): Promise<{}>;
    /**
     * @return {Promise} Resolves: A list of the user's current rooms
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getJoinedRooms(): Promise<IJoinedRoomsResponse>;
    /**
     * Retrieve membership info. for a room.
     * @param {string} roomId ID of the room to get membership for
     * @return {Promise} Resolves: A list of currently joined users
     *                                 and their profile data.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getJoinedRoomMembers(roomId: string): Promise<IJoinedMembersResponse>;
    /**
     * @param {Object} options Options for this request
     * @param {string} options.server The remote server to query for the room list.
     *                                Optional. If unspecified, get the local home
     *                                server's public room list.
     * @param {number} options.limit Maximum number of entries to return
     * @param {string} options.since Token to paginate from
     * @param {object} options.filter Filter parameters
     * @param {string} options.filter.generic_search_term String to search for
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    publicRooms(options: IRoomDirectoryOptions, callback?: Callback): Promise<IPublicRoomsResponse>;
    /**
     * Create an alias to room ID mapping.
     * @param {string} alias The room alias to create.
     * @param {string} roomId The room ID to link the alias to.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createAlias(alias: string, roomId: string, callback?: Callback): Promise<{}>;
    /**
     * Delete an alias to room ID mapping.  This alias must be on your local server
     * and you must have sufficient access to do this operation.
     * @param {string} alias The room alias to delete.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an empty object.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteAlias(alias: string, callback?: Callback): Promise<{}>;
    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an object with an `aliases` property, containing an array of local aliases
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    unstableGetLocalAliases(roomId: string, callback?: Callback): Promise<{
        aliases: string[];
    }>;
    /**
     * Get room info for the given alias.
     * @param {string} alias The room alias to resolve.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Object with room_id and servers.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getRoomIdForAlias(alias: string, callback?: Callback): Promise<{
        room_id: string;
        servers: string[];
    }>;
    /**
     * @param {string} roomAlias
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Object with room_id and servers.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    resolveRoomAlias(roomAlias: string, callback?: Callback): Promise<{
        room_id: string;
        servers: string[];
    }>;
    /**
     * Get the visibility of a room in the current HS's room directory
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getRoomDirectoryVisibility(roomId: string, callback?: Callback): Promise<{
        visibility: Visibility;
    }>;
    /**
     * Set the visbility of a room in the current HS's room directory
     * @param {string} roomId
     * @param {string} visibility "public" to make the room visible
     *                 in the public directory, or "private" to make
     *                 it invisible.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomDirectoryVisibility(roomId: string, visibility: Visibility, callback?: Callback): Promise<{}>;
    /**
     * Set the visbility of a room bridged to a 3rd party network in
     * the current HS's room directory.
     * @param {string} networkId the network ID of the 3rd party
     *                 instance under which this room is published under.
     * @param {string} roomId
     * @param {string} visibility "public" to make the room visible
     *                 in the public directory, or "private" to make
     *                 it invisible.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomDirectoryVisibilityAppService(networkId: string, roomId: string, visibility: "public" | "private", callback?: Callback): Promise<any>;
    /**
     * Query the user directory with a term matching user IDs, display names and domains.
     * @param {object} opts options
     * @param {string} opts.term the term with which to search.
     * @param {number} opts.limit the maximum number of results to return. The server will
     *                 apply a limit if unspecified.
     * @return {Promise} Resolves: an array of results.
     */
    searchUserDirectory(opts: {
        term: string;
        limit?: number;
    }): Promise<IUserDirectoryResponse>;
    /**
     * Upload a file to the media repository on the homeserver.
     *
     * @param {object} file The object to upload. On a browser, something that
     *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
     *   a a Buffer, String or ReadStream.
     *
     * @param {object} opts  options object
     *
     * @param {string=} opts.name   Name to give the file on the server. Defaults
     *   to <tt>file.name</tt>.
     *
     * @param {boolean=} opts.includeFilename if false will not send the filename,
     *   e.g for encrypted file uploads where filename leaks are undesirable.
     *   Defaults to true.
     *
     * @param {string=} opts.type   Content-type for the upload. Defaults to
     *   <tt>file.type</tt>, or <tt>applicaton/octet-stream</tt>.
     *
     * @param {boolean=} opts.rawResponse Return the raw body, rather than
     *   parsing the JSON. Defaults to false (except on node.js, where it
     *   defaults to true for backwards compatibility).
     *
     * @param {boolean=} opts.onlyContentUri Just return the content URI,
     *   rather than the whole body. Defaults to false (except on browsers,
     *   where it defaults to true for backwards compatibility). Ignored if
     *   opts.rawResponse is true.
     *
     * @param {Function=} opts.callback Deprecated. Optional. The callback to
     *    invoke on success/failure. See the promise return values for more
     *    information.
     *
     * @param {Function=} opts.progressHandler Optional. Called when a chunk of
     *    data has been uploaded, with an object containing the fields `loaded`
     *    (number of bytes transferred) and `total` (total size, if known).
     *
     * @return {Promise} Resolves to response object, as
     *    determined by this.opts.onlyData, opts.rawResponse, and
     *    opts.onlyContentUri.  Rejects with an error (usually a MatrixError).
     */
    uploadContent(file: File | String | Buffer | ReadStream | Blob, opts?: IUploadOpts): IAbortablePromise<any>;
    /**
     * Cancel a file upload in progress
     * @param {Promise} promise The promise returned from uploadContent
     * @return {boolean} true if canceled, otherwise false
     */
    cancelUpload(promise: IAbortablePromise<any>): boolean;
    /**
     * Get a list of all file uploads in progress
     * @return {array} Array of objects representing current uploads.
     * Currently in progress is element 0. Keys:
     *  - promise: The promise associated with the upload
     *  - loaded: Number of bytes uploaded
     *  - total: Total number of bytes to upload
     */
    getCurrentUploads(): {
        promise: Promise<any>;
        loaded: number;
        total: number;
    }[];
    /**
     * @param {string} userId
     * @param {string} info The kind of info to retrieve (e.g. 'displayname',
     * 'avatar_url').
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getProfileInfo(userId: string, info?: string, callback?: Callback): Promise<{
        avatar_url?: string;
        displayname?: string;
    }>;
    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves to a list of the user's threepids.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getThreePids(callback?: Callback): Promise<{
        threepids: IThreepid[];
    }>;
    /**
     * Add a 3PID to your homeserver account and optionally bind it to an identity
     * server as well. An identity server is required as part of the `creds` object.
     *
     * This API is deprecated, and you should instead use `addThreePidOnly`
     * for homeservers that support it.
     *
     * @param {Object} creds
     * @param {boolean} bind
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addThreePid(creds: any, bind: boolean, callback?: Callback): Promise<any>;
    /**
     * Add a 3PID to your homeserver account. This API does not use an identity
     * server, as the homeserver is expected to handle 3PID ownership validation.
     *
     * You can check whether a homeserver supports this API via
     * `doesServerSupportSeparateAddAndBind`.
     *
     * @param {Object} data A object with 3PID validation data from having called
     * `account/3pid/<medium>/requestToken` on the homeserver.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addThreePidOnly(data: IAddThreePidOnlyBody): Promise<{}>;
    /**
     * Bind a 3PID for discovery onto an identity server via the homeserver. The
     * identity server handles 3PID ownership validation and the homeserver records
     * the new binding to track where all 3PIDs for the account are bound.
     *
     * You can check whether a homeserver supports this API via
     * `doesServerSupportSeparateAddAndBind`.
     *
     * @param {Object} data A object with 3PID validation data from having called
     * `validate/<medium>/requestToken` on the identity server. It should also
     * contain `id_server` and `id_access_token` fields as well.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    bindThreePid(data: IBindThreePidBody): Promise<{}>;
    /**
     * Unbind a 3PID for discovery on an identity server via the homeserver. The
     * homeserver removes its record of the binding to keep an updated record of
     * where all 3PIDs for the account are bound.
     *
     * @param {string} medium The threepid medium (eg. 'email')
     * @param {string} address The threepid address (eg. 'bob@example.com')
     *        this must be as returned by getThreePids.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    unbindThreePid(medium: string, address: string): Promise<{
        id_server_unbind_result: IdServerUnbindResult;
    }>;
    /**
     * @param {string} medium The threepid medium (eg. 'email')
     * @param {string} address The threepid address (eg. 'bob@example.com')
     *        this must be as returned by getThreePids.
     * @return {Promise} Resolves: The server response on success
     *     (generally the empty JSON object)
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteThreePid(medium: string, address: string): Promise<{
        id_server_unbind_result: IdServerUnbindResult;
    }>;
    /**
     * Make a request to change your password.
     * @param {Object} authDict
     * @param {string} newPassword The new desired password.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPassword(authDict: any, newPassword: string, callback?: Callback): Promise<any>;
    /**
     * Gets all devices recorded for the logged-in user
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getDevices(): Promise<{
        devices: IMyDevice[];
    }>;
    /**
     * Gets specific device details for the logged-in user
     * @param {string} deviceId  device to query
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getDevice(deviceId: string): Promise<IMyDevice>;
    /**
     * Update the given device
     *
     * @param {string} deviceId  device to update
     * @param {Object} body       body of request
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setDeviceDetails(deviceId: string, body: {
        display_name: string;
    }): Promise<{}>;
    /**
     * Delete the given device
     *
     * @param {string} deviceId  device to delete
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteDevice(deviceId: string, auth?: any): Promise<any>;
    /**
     * Delete multiple device
     *
     * @param {string[]} devices IDs of the devices to delete
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteMultipleDevices(devices: string[], auth?: any): Promise<any>;
    /**
     * Gets all pushers registered for the logged-in user
     *
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Array of objects representing pushers
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPushers(callback?: Callback): Promise<{
        pushers: IPusher[];
    }>;
    /**
     * Adds a new pusher or updates an existing pusher
     *
     * @param {IPusherRequest} pusher Object representing a pusher
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Empty json object on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPusher(pusher: IPusherRequest, callback?: Callback): Promise<{}>;
    /**
     * Get the push rules for the account from the server.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves to the push rules.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPushRules(callback?: Callback): Promise<IPushRules>;
    /**
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {Object} body
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addPushRule(scope: string, kind: PushRuleKind, ruleId: Exclude<string, RuleId>, body: any, callback?: Callback): Promise<any>;
    /**
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an empty object {}
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deletePushRule(scope: string, kind: PushRuleKind, ruleId: Exclude<string, RuleId>, callback?: Callback): Promise<any>;
    /**
     * Enable or disable a push notification rule.
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {boolean} enabled
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPushRuleEnabled(scope: string, kind: PushRuleKind, ruleId: RuleId | string, enabled: boolean, callback?: Callback): Promise<{}>;
    /**
     * Set the actions for a push notification rule.
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {array} actions
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPushRuleActions(scope: string, kind: PushRuleKind, ruleId: RuleId | string, actions: PushRuleAction[], callback?: Callback): Promise<{}>;
    /**
     * Perform a server-side search.
     * @param {Object} opts
     * @param {string} opts.next_batch the batch token to pass in the query string
     * @param {Object} opts.body the JSON object to pass to the request body.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    search(opts: {
        body: ISearchRequestBody;
        next_batch?: string;
    }, // eslint-disable-line camelcase
    callback?: Callback): Promise<ISearchResponse>;
    /**
     * Upload keys
     *
     * @param {Object} content  body of upload request
     *
     * @param {Object=} opts this method no longer takes any opts,
     *  used to take opts.device_id but this was not removed from the spec as a redundant parameter
     *
     * @param {module:client.callback=} callback
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    uploadKeysRequest(content: IUploadKeysRequest, opts?: void, callback?: Callback): Promise<IKeysUploadResponse>;
    uploadKeySignatures(content: KeySignatures): Promise<IUploadKeySignaturesResponse>;
    /**
     * Download device keys
     *
     * @param {string[]} userIds  list of users to get keys for
     *
     * @param {Object=} opts
     *
     * @param {string=} opts.token   sync token to pass in the query request, to help
     *   the HS give the most recent results
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    downloadKeysForUsers(userIds: string[], opts: {
        token?: string;
    }): Promise<IDownloadKeyResult>;
    /**
     * Claim one-time keys
     *
     * @param {string[]} devices  a list of [userId, deviceId] pairs
     *
     * @param {string} [keyAlgorithm = signed_curve25519]  desired key type
     *
     * @param {number} [timeout] the time (in milliseconds) to wait for keys from remote
     *     servers
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    claimOneTimeKeys(devices: string[], keyAlgorithm?: string, timeout?: number): Promise<IClaimOTKsResult>;
    /**
     * Ask the server for a list of users who have changed their device lists
     * between a pair of sync tokens
     *
     * @param {string} oldToken
     * @param {string} newToken
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    getKeyChanges(oldToken: string, newToken: string): Promise<{
        changed: string[];
        left: string[];
    }>;
    uploadDeviceSigningKeys(auth: any, keys?: CrossSigningKeys): Promise<{}>;
    /**
     * Register with an identity server using the OpenID token from the user's
     * Homeserver, which can be retrieved via
     * {@link module:client~MatrixClient#getOpenIdToken}.
     *
     * Note that the `/account/register` endpoint (as well as IS authentication in
     * general) was added as part of the v2 API version.
     *
     * @param {object} hsOpenIdToken
     * @return {Promise} Resolves: with object containing an Identity
     * Server access token.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerWithIdentityServer(hsOpenIdToken: any): Promise<any>;
    /**
     * Requests an email verification token directly from an identity server.
     *
     * This API is used as part of binding an email for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param {string} email The email address to request a token for
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param {number} sendAttempt If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another email.
     *                 To request another email to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param {string} nextLink Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the identity
     * server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    requestEmailToken(email: string, clientSecret: string, sendAttempt: number, nextLink: string, callback?: Callback, identityAccessToken?: string): Promise<any>;
    /**
     * Requests a MSISDN verification token directly from an identity server.
     *
     * This API is used as part of binding a MSISDN for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param {string} phoneCountry The ISO 3166-1 alpha-2 code for the country in
     *                 which phoneNumber should be parsed relative to.
     * @param {string} phoneNumber The phone number, in national or international
     *                 format
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param {number} sendAttempt If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another SMS.
     *                 To request another SMS to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param {string} nextLink Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    requestMsisdnToken(phoneCountry: string, phoneNumber: string, clientSecret: string, sendAttempt: number, nextLink: string, callback?: Callback, identityAccessToken?: string): Promise<any>;
    /**
     * Submits a MSISDN token to the identity server
     *
     * This is used when submitting the code sent by SMS to a phone number.
     * The identity server has an equivalent API for email but the js-sdk does
     * not expose this, since email is normally validated by the user clicking
     * a link rather than entering a code.
     *
     * @param {string} sid The sid given in the response to requestToken
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param {string} msisdnToken The MSISDN token, as enetered by the user.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: Object, currently with no parameters.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if No identity server is set
     */
    submitMsisdnToken(sid: string, clientSecret: string, msisdnToken: string, identityAccessToken: string): Promise<any>;
    /**
     * Submits a MSISDN token to an arbitrary URL.
     *
     * This is used when submitting the code sent by SMS to a phone number in the
     * newer 3PID flow where the homeserver validates 3PID ownership (as part of
     * `requestAdd3pidMsisdnToken`). The homeserver response may include a
     * `submit_url` to specify where the token should be sent, and this helper can
     * be used to pass the token to this URL.
     *
     * @param {string} url The URL to submit the token to
     * @param {string} sid The sid given in the response to requestToken
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param {string} msisdnToken The MSISDN token, as enetered by the user.
     *
     * @return {Promise} Resolves: Object, currently with no parameters.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    submitMsisdnTokenOtherUrl(url: string, sid: string, clientSecret: string, msisdnToken: string): Promise<any>;
    /**
     * Gets the V2 hashing information from the identity server. Primarily useful for
     * lookups.
     * @param {string} identityAccessToken The access token for the identity server.
     * @returns {Promise<object>} The hashing information for the identity server.
     */
    getIdentityHashDetails(identityAccessToken: string): Promise<any>;
    /**
     * Performs a hashed lookup of addresses against the identity server. This is
     * only supported on identity servers which have at least the version 2 API.
     * @param {Array<Array<string,string>>} addressPairs An array of 2 element arrays.
     * The first element of each pair is the address, the second is the 3PID medium.
     * Eg: ["email@example.org", "email"]
     * @param {string} identityAccessToken The access token for the identity server.
     * @returns {Promise<Array<{address, mxid}>>} A collection of address mappings to
     * found MXIDs. Results where no user could be found will not be listed.
     */
    identityHashedLookup(addressPairs: [string, string][], identityAccessToken: string): Promise<{
        address: string;
        mxid: string;
    }[]>;
    /**
     * Looks up the public Matrix ID mapping for a given 3rd party
     * identifier from the identity server
     *
     * @param {string} medium The medium of the threepid, eg. 'email'
     * @param {string} address The textual address of the threepid
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: A threepid mapping
     *                                 object or the empty object if no mapping
     *                                 exists
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    lookupThreePid(medium: string, address: string, callback?: Callback, identityAccessToken?: string): Promise<any>;
    /**
     * Looks up the public Matrix ID mappings for multiple 3PIDs.
     *
     * @param {Array.<Array.<string>>} query Array of arrays containing
     * [medium, address]
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: Lookup results from IS.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    bulkLookupThreePids(query: [string, string][], identityAccessToken: string): Promise<any>;
    /**
     * Get account info from the identity server. This is useful as a neutral check
     * to verify that other APIs are likely to approve access by testing that the
     * token is valid, terms have been agreed, etc.
     *
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: an object with account info.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getIdentityAccount(identityAccessToken: string): Promise<any>;
    /**
     * Send an event to a specific list of devices
     *
     * @param {string} eventType  type of event to send
     * @param {Object.<string, Object<string, Object>>} contentMap
     *    content to send. Map from user_id to device_id to content object.
     * @param {string=} txnId     transaction id. One will be made up if not
     *    supplied.
     * @return {Promise} Resolves to the result object
     */
    sendToDevice(eventType: string, contentMap: {
        [userId: string]: {
            [deviceId: string]: Record<string, any>;
        };
    }, txnId?: string): Promise<{}>;
    /**
     * Get the third party protocols that can be reached using
     * this HS
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyProtocols(): Promise<{
        [protocol: string]: IProtocol;
    }>;
    /**
     * Get information on how a specific place on a third party protocol
     * may be reached.
     * @param {string} protocol The protocol given in getThirdpartyProtocols()
     * @param {object} params Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyLocation(protocol: string, params: {
        searchFields?: string[];
    }): Promise<IThirdPartyLocation[]>;
    /**
     * Get information on how a specific user on a third party protocol
     * may be reached.
     * @param {string} protocol The protocol given in getThirdpartyProtocols()
     * @param {object} params Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyUser(protocol: string, params: any): Promise<IThirdPartyUser[]>;
    getTerms(serviceType: SERVICE_TYPES, baseUrl: string): Promise<any>;
    agreeToTerms(serviceType: SERVICE_TYPES, baseUrl: string, accessToken: string, termsUrls: string[]): Promise<any>;
    /**
     * Reports an event as inappropriate to the server, which may then notify the appropriate people.
     * @param {string} roomId The room in which the event being reported is located.
     * @param {string} eventId The event to report.
     * @param {number} score The score to rate this content as where -100 is most offensive and 0 is inoffensive.
     * @param {string} reason The reason the content is being reported. May be blank.
     * @returns {Promise} Resolves to an empty object if successful
     */
    reportEvent(roomId: string, eventId: string, score: number, reason: string): Promise<{}>;
    /**
     * Fetches or paginates a summary of a space as defined by an initial version of MSC2946
     * @param {string} roomId The ID of the space-room to use as the root of the summary.
     * @param {number?} maxRoomsPerSpace The maximum number of rooms to return per subspace.
     * @param {boolean?} suggestedOnly Whether to only return rooms with suggested=true.
     * @param {boolean?} autoJoinOnly Whether to only return rooms with auto_join=true.
     * @param {number?} limit The maximum number of rooms to return in total.
     * @param {string?} batch The opaque token to paginate a previous summary request.
     * @returns {Promise} the response, with next_token, rooms fields.
     * @deprecated in favour of `getRoomHierarchy` due to the MSC changing paths.
     */
    getSpaceSummary(roomId: string, maxRoomsPerSpace?: number, suggestedOnly?: boolean, autoJoinOnly?: boolean, limit?: number, batch?: string): Promise<{
        rooms: ISpaceSummaryRoom[];
        events: ISpaceSummaryEvent[];
    }>;
    /**
     * Fetches or paginates a room hierarchy as defined by MSC2946.
     * Falls back gracefully to sourcing its data from `getSpaceSummary` if this API is not yet supported by the server.
     * @param {string} roomId The ID of the space-room to use as the root of the summary.
     * @param {number?} limit The maximum number of rooms to return per page.
     * @param {number?} maxDepth The maximum depth in the tree from the root room to return.
     * @param {boolean?} suggestedOnly Whether to only return rooms with suggested=true.
     * @param {string?} fromToken The opaque token to paginate a previous request.
     * @returns {Promise} the response, with next_batch & rooms fields.
     */
    getRoomHierarchy(roomId: string, limit?: number, maxDepth?: number, suggestedOnly?: boolean, fromToken?: string): Promise<{
        rooms: IHierarchyRoom[];
        next_batch?: string;
    }>;
    /**
     * Creates a new file tree space with the given name. The client will pick
     * defaults for how it expects to be able to support the remaining API offered
     * by the returned class.
     *
     * Note that this is UNSTABLE and may have breaking changes without notice.
     * @param {string} name The name of the tree space.
     * @returns {Promise<MSC3089TreeSpace>} Resolves to the created space.
     */
    unstableCreateFileTree(name: string): Promise<MSC3089TreeSpace>;
    /**
     * Gets a reference to a tree space, if the room ID given is a tree space. If the room
     * does not appear to be a tree space then null is returned.
     *
     * Note that this is UNSTABLE and may have breaking changes without notice.
     * @param {string} roomId The room ID to get a tree space reference for.
     * @returns {MSC3089TreeSpace} The tree space, or null if not a tree space.
     */
    unstableGetFileTreeSpace(roomId: string): MSC3089TreeSpace;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group summary object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroupSummary(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group profile object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroupProfile(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {Object} profile The group profile object
     * @param {string=} profile.name Name of the group
     * @param {string=} profile.avatar_url MXC avatar URL
     * @param {string=} profile.short_description A short description of the room
     * @param {string=} profile.long_description A longer HTML description of the room
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    setGroupProfile(groupId: string, profile: any): Promise<any>;
    /**
     * @param {string} groupId
     * @param {object} policy The join policy for the group. Must include at
     *     least a 'type' field which is 'open' if anyone can join the group
     *     the group without prior approval, or 'invite' if an invite is
     *     required to join.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    setGroupJoinPolicy(groupId: string, policy: any): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group users list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroupUsers(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group users list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroupInvitedUsers(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group rooms list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getGroupRooms(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    inviteUserToGroup(groupId: string, userId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    removeUserFromGroup(groupId: string, userId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} userId
     * @param {string} roleId Optional.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    addUserToGroupSummary(groupId: string, userId: string, roleId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    removeUserFromGroupSummary(groupId: string, userId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} roomId
     * @param {string} categoryId Optional.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    addRoomToGroupSummary(groupId: string, roomId: string, categoryId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} roomId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    removeRoomFromGroupSummary(groupId: string, roomId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} roomId
     * @param {boolean} isPublic Whether the room-group association is visible to non-members
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    addRoomToGroup(groupId: string, roomId: string, isPublic: boolean): Promise<any>;
    /**
     * Configure the visibility of a room-group association.
     * @param {string} groupId
     * @param {string} roomId
     * @param {boolean} isPublic Whether the room-group association is visible to non-members
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    updateGroupRoomVisibility(groupId: string, roomId: string, isPublic: boolean): Promise<any>;
    /**
     * @param {string} groupId
     * @param {string} roomId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    removeRoomFromGroup(groupId: string, roomId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @param {Object} opts Additional options to send alongside the acceptance.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    acceptGroupInvite(groupId: string, opts?: any): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    joinGroup(groupId: string): Promise<any>;
    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    leaveGroup(groupId: string): Promise<any>;
    /**
     * @return {Promise} Resolves: The groups to which the user is joined
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getJoinedGroups(): Promise<any>;
    /**
     * @param {Object} content Request content
     * @param {string} content.localpart The local part of the desired group ID
     * @param {Object} content.profile Group profile object
     * @return {Promise} Resolves: Object with key group_id: id of the created group
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    createGroup(content: any): Promise<any>;
    /**
     * @param {string[]} userIds List of user IDs
     * @return {Promise} Resolves: Object as exmaple below
     *
     *     {
     *         "users": {
     *             "@bob:example.com": {
     *                 "+example:example.com"
     *             }
     *         }
     *     }
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    getPublicisedGroups(userIds: string[]): Promise<any>;
    /**
     * @param {string} groupId
     * @param {boolean} isPublic Whether the user's membership of this group is made public
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
     */
    setGroupPublicity(groupId: string, isPublic: boolean): Promise<any>;
    /**
     * @experimental
     */
    supportsExperimentalThreads(): boolean;
    /**
     * Fetches the summary of a room as defined by an initial version of MSC3266 and implemented in Synapse
     * Proposed at https://github.com/matrix-org/matrix-doc/pull/3266
     * @param {string} roomIdOrAlias The ID or alias of the room to get the summary of.
     * @param {string[]?} via The list of servers which know about the room if only an ID was provided.
     */
    getRoomSummary(roomIdOrAlias: string, via?: string[]): Promise<IRoomSummary>;
}
export {};
/**
 * Fires whenever the SDK receives a new event.
 * <p>
 * This is only fired for live events received via /sync - it is not fired for
 * events received over context, search, or pagination APIs.
 *
 * @event module:client~MatrixClient#"event"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("event", function(event){
 *   var sender = event.getSender();
 * });
 */
/**
 * Fires whenever the SDK receives a new to-device event.
 * @event module:client~MatrixClient#"toDeviceEvent"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("toDeviceEvent", function(event){
 *   var sender = event.getSender();
 * });
 */
/**
 * Fires whenever the SDK's syncing state is updated. The state can be one of:
 * <ul>
 *
 * <li>PREPARED: The client has synced with the server at least once and is
 * ready for methods to be called on it. This will be immediately followed by
 * a state of SYNCING. <i>This is the equivalent of "syncComplete" in the
 * previous API.</i></li>
 *
 * <li>CATCHUP: The client has detected the connection to the server might be
 * available again and will now try to do a sync again. As this sync might take
 * a long time (depending how long ago was last synced, and general server
 * performance) the client is put in this mode so the UI can reflect trying
 * to catch up with the server after losing connection.</li>
 *
 * <li>SYNCING : The client is currently polling for new events from the server.
 * This will be called <i>after</i> processing latest events from a sync.</li>
 *
 * <li>ERROR : The client has had a problem syncing with the server. If this is
 * called <i>before</i> PREPARED then there was a problem performing the initial
 * sync. If this is called <i>after</i> PREPARED then there was a problem polling
 * the server for updates. This may be called multiple times even if the state is
 * already ERROR. <i>This is the equivalent of "syncError" in the previous
 * API.</i></li>
 *
 * <li>RECONNECTING: The sync connection has dropped, but not (yet) in a way that
 * should be considered erroneous.
 * </li>
 *
 * <li>STOPPED: The client has stopped syncing with server due to stopClient
 * being called.
 * </li>
 * </ul>
 * State transition diagram:
 * <pre>
 *                                          +---->STOPPED
 *                                          |
 *              +----->PREPARED -------> SYNCING <--+
 *              |                        ^  |  ^    |
 *              |      CATCHUP ----------+  |  |    |
 *              |        ^                  V  |    |
 *   null ------+        |  +------- RECONNECTING   |
 *              |        V  V                       |
 *              +------->ERROR ---------------------+
 *
 * NB: 'null' will never be emitted by this event.
 *
 * </pre>
 * Transitions:
 * <ul>
 *
 * <li><code>null -> PREPARED</code> : Occurs when the initial sync is completed
 * first time. This involves setting up filters and obtaining push rules.
 *
 * <li><code>null -> ERROR</code> : Occurs when the initial sync failed first time.
 *
 * <li><code>ERROR -> PREPARED</code> : Occurs when the initial sync succeeds
 * after previously failing.
 *
 * <li><code>PREPARED -> SYNCING</code> : Occurs immediately after transitioning
 * to PREPARED. Starts listening for live updates rather than catching up.
 *
 * <li><code>SYNCING -> RECONNECTING</code> : Occurs when the live update fails.
 *
 * <li><code>RECONNECTING -> RECONNECTING</code> : Can occur if the update calls
 * continue to fail, but the keepalive calls (to /versions) succeed.
 *
 * <li><code>RECONNECTING -> ERROR</code> : Occurs when the keepalive call also fails
 *
 * <li><code>ERROR -> SYNCING</code> : Occurs when the client has performed a
 * live update after having previously failed.
 *
 * <li><code>ERROR -> ERROR</code> : Occurs when the client has failed to keepalive
 * for a second time or more.</li>
 *
 * <li><code>SYNCING -> SYNCING</code> : Occurs when the client has performed a live
 * update. This is called <i>after</i> processing.</li>
 *
 * <li><code>* -> STOPPED</code> : Occurs once the client has stopped syncing or
 * trying to sync after stopClient has been called.</li>
 * </ul>
 *
 * @event module:client~MatrixClient#"sync"
 *
 * @param {string} state An enum representing the syncing state. One of "PREPARED",
 * "SYNCING", "ERROR", "STOPPED".
 *
 * @param {?string} prevState An enum representing the previous syncing state.
 * One of "PREPARED", "SYNCING", "ERROR", "STOPPED" <b>or null</b>.
 *
 * @param {?Object} data Data about this transition.
 *
 * @param {MatrixError} data.error The matrix error if <code>state=ERROR</code>.
 *
 * @param {String} data.oldSyncToken The 'since' token passed to /sync.
 *    <code>null</code> for the first successful sync since this client was
 *    started. Only present if <code>state=PREPARED</code> or
 *    <code>state=SYNCING</code>.
 *
 * @param {String} data.nextSyncToken The 'next_batch' result from /sync, which
 *    will become the 'since' token for the next call to /sync. Only present if
 *    <code>state=PREPARED</code> or <code>state=SYNCING</code>.
 *
 * @param {boolean} data.catchingUp True if we are working our way through a
 *    backlog of events after connecting. Only present if <code>state=SYNCING</code>.
 *
 * @example
 * matrixClient.on("sync", function(state, prevState, data) {
 *   switch (state) {
 *     case "ERROR":
 *       // update UI to say "Connection Lost"
 *       break;
 *     case "SYNCING":
 *       // update UI to remove any "Connection Lost" message
 *       break;
 *     case "PREPARED":
 *       // the client instance is ready to be queried.
 *       var rooms = matrixClient.getRooms();
 *       break;
 *   }
 * });
 */
/**
 * Fires whenever the sdk learns about a new group. <strong>This event
 * is experimental and may change.</strong>
 * @event module:client~MatrixClient#"Group"
 * @param {Group} group The newly created, fully populated group.
 * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
 * @example
 * matrixClient.on("Group", function(group){
 *   var groupId = group.groupId;
 * });
 */
/**
 * Fires whenever a new Room is added. This will fire when you are invited to a
 * room, as well as when you join a room. <strong>This event is experimental and
 * may change.</strong>
 * @event module:client~MatrixClient#"Room"
 * @param {Room} room The newly created, fully populated room.
 * @example
 * matrixClient.on("Room", function(room){
 *   var roomId = room.roomId;
 * });
 */
/**
 * Fires whenever a Room is removed. This will fire when you forget a room.
 * <strong>This event is experimental and may change.</strong>
 * @event module:client~MatrixClient#"deleteRoom"
 * @param {string} roomId The deleted room ID.
 * @example
 * matrixClient.on("deleteRoom", function(roomId){
 *   // update UI from getRooms()
 * });
 */
/**
 * Fires whenever an incoming call arrives.
 * @event module:client~MatrixClient#"Call.incoming"
 * @param {module:webrtc/call~MatrixCall} call The incoming call.
 * @example
 * matrixClient.on("Call.incoming", function(call){
 *   call.answer(); // auto-answer
 * });
 */
/**
 * Fires whenever the login session the JS SDK is using is no
 * longer valid and the user must log in again.
 * NB. This only fires when action is required from the user, not
 * when then login session can be renewed by using a refresh token.
 * @event module:client~MatrixClient#"Session.logged_out"
 * @example
 * matrixClient.on("Session.logged_out", function(errorObj){
 *   // show the login screen
 * });
 */
/**
 * Fires when the JS SDK receives a M_CONSENT_NOT_GIVEN error in response
 * to a HTTP request.
 * @event module:client~MatrixClient#"no_consent"
 * @example
 * matrixClient.on("no_consent", function(message, contentUri) {
 *     console.info(message + ' Go to ' + contentUri);
 * });
 */
/**
 * Fires when a device is marked as verified/unverified/blocked/unblocked by
 * {@link module:client~MatrixClient#setDeviceVerified|MatrixClient.setDeviceVerified} or
 * {@link module:client~MatrixClient#setDeviceBlocked|MatrixClient.setDeviceBlocked}.
 *
 * @event module:client~MatrixClient#"deviceVerificationChanged"
 * @param {string} userId the owner of the verified device
 * @param {string} deviceId the id of the verified device
 * @param {module:crypto/deviceinfo} deviceInfo updated device information
 */
/**
 * Fires when the trust status of a user changes
 * If userId is the userId of the logged in user, this indicated a change
 * in the trust status of the cross-signing data on the account.
 *
 * The cross-signing API is currently UNSTABLE and may change without notice.
 *
 * @event module:client~MatrixClient#"userTrustStatusChanged"
 * @param {string} userId the userId of the user in question
 * @param {UserTrustLevel} trustLevel The new trust level of the user
 */
/**
 * Fires when the user's cross-signing keys have changed or cross-signing
 * has been enabled/disabled. The client can use getStoredCrossSigningForUser
 * with the user ID of the logged in user to check if cross-signing is
 * enabled on the account. If enabled, it can test whether the current key
 * is trusted using with checkUserTrust with the user ID of the logged
 * in user. The checkOwnCrossSigningTrust function may be used to reconcile
 * the trust in the account key.
 *
 * The cross-signing API is currently UNSTABLE and may change without notice.
 *
 * @event module:client~MatrixClient#"crossSigning.keysChanged"
 */
/**
 * Fires whenever new user-scoped account_data is added.
 * @event module:client~MatrixClient#"accountData"
 * @param {MatrixEvent} event The event describing the account_data just added
 * @param {MatrixEvent} event The previous account data, if known.
 * @example
 * matrixClient.on("accountData", function(event, oldEvent){
 *   myAccountData[event.type] = event.content;
 * });
 */
/**
 * Fires whenever the stored devices for a user have changed
 * @event module:client~MatrixClient#"crypto.devicesUpdated"
 * @param {String[]} users A list of user IDs that were updated
 * @param {boolean} initialFetch If true, the store was empty (apart
 *     from our own device) and has been seeded.
 */
/**
 * Fires whenever the stored devices for a user will be updated
 * @event module:client~MatrixClient#"crypto.willUpdateDevices"
 * @param {String[]} users A list of user IDs that will be updated
 * @param {boolean} initialFetch If true, the store is empty (apart
 *     from our own device) and is being seeded.
 */
/**
 * Fires whenever the status of e2e key backup changes, as returned by getKeyBackupEnabled()
 * @event module:client~MatrixClient#"crypto.keyBackupStatus"
 * @param {boolean} enabled true if key backup has been enabled, otherwise false
 * @example
 * matrixClient.on("crypto.keyBackupStatus", function(enabled){
 *   if (enabled) {
 *     [...]
 *   }
 * });
 */
/**
 * Fires when we want to suggest to the user that they restore their megolm keys
 * from backup or by cross-signing the device.
 *
 * @event module:client~MatrixClient#"crypto.suggestKeyRestore"
 */
/**
 * Fires when a key verification is requested.
 * @event module:client~MatrixClient#"crypto.verification.request"
 * @param {object} data
 * @param {MatrixEvent} data.event the original verification request message
 * @param {Array} data.methods the verification methods that can be used
 * @param {Number} data.timeout the amount of milliseconds that should be waited
 *                 before cancelling the request automatically.
 * @param {Function} data.beginKeyVerification a function to call if a key
 *     verification should be performed.  The function takes one argument: the
 *     name of the key verification method (taken from data.methods) to use.
 * @param {Function} data.cancel a function to call if the key verification is
 *     rejected.
 */
/**
 * Fires when a key verification is requested with an unknown method.
 * @event module:client~MatrixClient#"crypto.verification.request.unknown"
 * @param {string} userId the user ID who requested the key verification
 * @param {Function} cancel a function that will send a cancellation message to
 *     reject the key verification.
 */
/**
 * Fires when a secret request has been cancelled.  If the client is prompting
 * the user to ask whether they want to share a secret, the prompt can be
 * dismissed.
 *
 * The Secure Secret Storage API is currently UNSTABLE and may change without notice.
 *
 * @event module:client~MatrixClient#"crypto.secrets.requestCancelled"
 * @param {object} data
 * @param {string} data.user_id The user ID of the client that had requested the secret.
 * @param {string} data.device_id The device ID of the client that had requested the
 *     secret.
 * @param {string} data.request_id The ID of the original request.
 */
/**
 * Fires when the client .well-known info is fetched.
 *
 * @event module:client~MatrixClient#"WellKnown.client"
 * @param {object} data The JSON object returned by the server
 */
//# sourceMappingURL=client.d.ts.map