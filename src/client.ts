/*
Copyright 2015-2023 The Matrix.org Foundation C.I.C.

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
 * This is an internal module. See {@link MatrixClient} for the public class.
 */

import type { IDeviceKeys, IOneTimeKey } from "./@types/crypto.ts";
import { type ISyncStateData, type SetPresence, SyncApi, type SyncApiOptions, SyncState } from "./sync.ts";
import {
    EventStatus,
    type IContent,
    type IDecryptOptions,
    type IEvent,
    MatrixEvent,
    MatrixEventEvent,
    type MatrixEventHandlerMap,
    type PushDetails,
} from "./models/event.ts";
import { StubStore } from "./store/stub.ts";
import {
    type CallEvent,
    type CallEventHandlerMap,
    createNewMatrixCall,
    type MatrixCall,
    supportsMatrixCall,
} from "./webrtc/call.ts";
import { Filter, type IFilterDefinition, type IRoomEventFilter } from "./filter.ts";
import {
    CallEventHandler,
    type CallEventHandlerEvent,
    type CallEventHandlerEventHandlerMap,
} from "./webrtc/callEventHandler.ts";
import {
    GroupCallEventHandler,
    type GroupCallEventHandlerEvent,
    type GroupCallEventHandlerEventHandlerMap,
} from "./webrtc/groupCallEventHandler.ts";
import * as utils from "./utils.ts";
import { deepCompare, noUnsafeEventProps, type QueryDict, replaceParam, safeSet, sleep } from "./utils.ts";
import { Direction, EventTimeline } from "./models/event-timeline.ts";
import { type IActionsObject, PushProcessor } from "./pushprocessor.ts";
import { AutoDiscovery, type AutoDiscoveryAction } from "./autodiscovery.ts";
import { encodeUnpaddedBase64Url } from "./base64.ts";
import { TypedReEmitter } from "./ReEmitter.ts";
import { logger, type Logger } from "./logger.ts";
import { SERVICE_TYPES } from "./service-types.ts";
import {
    type Body,
    ClientPrefix,
    type FileType,
    type HttpApiEvent,
    type HttpApiEventHandlerMap,
    type HTTPError,
    IdentityPrefix,
    type IHttpOpts,
    type IRequestOpts,
    MatrixError,
    MatrixHttpApi,
    MediaPrefix,
    Method,
    retryNetworkOperation,
    type TokenRefreshFunction,
    type Upload,
    type UploadOpts,
    type UploadResponse,
} from "./http-api/index.ts";
import { User, UserEvent, type UserEventHandlerMap } from "./models/user.ts";
import { getHttpUriForMxc } from "./content-repo.ts";
import { SearchResult } from "./models/search-result.ts";
import { type IIdentityServerProvider } from "./@types/IIdentityServerProvider.ts";
import { type MatrixScheduler } from "./scheduler.ts";
import { type BeaconEvent, type BeaconEventHandlerMap } from "./models/beacon.ts";
import { type AuthDict } from "./interactive-auth.ts";
import {
    type IMinimalEvent,
    type IRoomEvent,
    type IStateEvent,
    type ReceivedToDeviceMessage,
} from "./sync-accumulator.ts";
import type { EventTimelineSet } from "./models/event-timeline-set.ts";
import * as ContentHelpers from "./content-helpers.ts";
import {
    NotificationCountType,
    type Room,
    type RoomEvent,
    type RoomEventHandlerMap,
    type RoomNameState,
} from "./models/room.ts";
import { RoomMemberEvent, type RoomMemberEventHandlerMap } from "./models/room-member.ts";
import { type IPowerLevelsContent, type RoomStateEvent, type RoomStateEventHandlerMap } from "./models/room-state.ts";
import {
    isSendDelayedEventRequestOpts,
    UpdateDelayedEventAction,
    type DelayedEventInfo,
    type IAddThreePidOnlyBody,
    type IBindThreePidBody,
    type IContextResponse,
    type ICreateRoomOpts,
    type IEventSearchOpts,
    type IFilterResponse,
    type IGuestAccessOpts,
    type IJoinRoomOpts,
    type INotificationsResponse,
    type InviteOpts,
    type IPaginateOpts,
    type IPresenceOpts,
    type IRedactOpts,
    type IRelationsRequestOpts,
    type IRelationsResponse,
    type IRoomDirectoryOptions,
    type ISearchOpts,
    type ISendEventResponse,
    type IStatusResponse,
    type ITagsResponse,
    type KnockRoomOpts,
    type SendDelayedEventRequestOpts,
    type SendDelayedEventResponse,
} from "./@types/requests.ts";
import {
    type AccountDataEvents,
    EventType,
    LOCAL_NOTIFICATION_SETTINGS_PREFIX,
    MSC3912_RELATION_BASED_REDACTIONS_PROP,
    MsgType,
    PUSHER_ENABLED,
    RelationType,
    RoomCreateTypeField,
    RoomType,
    type StateEvents,
    type TimelineEvents,
    UNSTABLE_MSC3088_ENABLED,
    UNSTABLE_MSC3088_PURPOSE,
    UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "./@types/event.ts";
import {
    GuestAccess,
    HistoryVisibility,
    type IdServerUnbindResult,
    type JoinRule,
    Preset,
    type Terms,
    type Visibility,
} from "./@types/partials.ts";
import { type EventMapper, eventMapperFor, type MapperOpts } from "./event-mapper.ts";
import { secureRandomString } from "./randomstring.ts";
import { DEFAULT_TREE_POWER_LEVELS_TEMPLATE, MSC3089TreeSpace } from "./models/MSC3089TreeSpace.ts";
import { type ISignatures } from "./@types/signed.ts";
import { type IStore } from "./store/index.ts";
import {
    type IEventWithRoomId,
    type ISearchRequestBody,
    type ISearchResponse,
    type ISearchResults,
    type IStateEventWithRoomId,
    SearchOrderBy,
} from "./@types/search.ts";
import { type ISynapseAdminDeactivateResponse, type ISynapseAdminWhoisResponse } from "./@types/synapse.ts";
import { type IHierarchyRoom } from "./@types/spaces.ts";
import {
    type IPusher,
    type IPusherRequest,
    type IPushRule,
    type IPushRules,
    type PushRuleAction,
    PushRuleActionName,
    PushRuleKind,
    type RuleId,
} from "./@types/PushRules.ts";
import { type IThreepid } from "./@types/threepids.ts";
import { type CryptoStore } from "./crypto/store/base.ts";
import {
    GroupCall,
    type GroupCallIntent,
    type GroupCallType,
    type IGroupCallDataChannelOptions,
} from "./webrtc/groupCall.ts";
import { MediaHandler } from "./webrtc/mediaHandler.ts";
import {
    type ILoginFlowsResponse,
    type IRefreshTokenResponse,
    type LoginRequest,
    type LoginResponse,
    type LoginTokenPostResponse,
    type SSOAction,
} from "./@types/auth.ts";
import { TypedEventEmitter } from "./models/typed-event-emitter.ts";
import { MAIN_ROOM_TIMELINE, ReceiptType } from "./@types/read_receipts.ts";
import { type MSC3575SlidingSyncRequest, type MSC3575SlidingSyncResponse, type SlidingSync } from "./sliding-sync.ts";
import { SlidingSyncSdk } from "./sliding-sync-sdk.ts";
import {
    determineFeatureSupport,
    FeatureSupport,
    Thread,
    THREAD_RELATION_TYPE,
    ThreadFilterType,
    threadFilterTypeToFilter,
} from "./models/thread.ts";
import { M_BEACON_INFO, type MBeaconInfoEventContent } from "./@types/beacon.ts";
import { NamespacedValue, UnstableValue } from "./NamespacedValue.ts";
import { ToDeviceMessageQueue } from "./ToDeviceMessageQueue.ts";
import { type ToDeviceBatch, type ToDevicePayload } from "./models/ToDeviceMessage.ts";
import { IgnoredInvites } from "./models/invites-ignorer.ts";
import { type UIARequest } from "./@types/uia.ts";
import { type LocalNotificationSettings } from "./@types/local_notifications.ts";
import { buildFeatureSupportMap, Feature, ServerSupport } from "./feature.ts";
import { type CryptoBackend } from "./common-crypto/CryptoBackend.ts";
import { RUST_SDK_STORE_PREFIX } from "./rust-crypto/constants.ts";
import {
    type CrossSigningKeyInfo,
    type CryptoApi,
    type CryptoCallbacks,
    CryptoEvent,
    type CryptoEventHandlerMap,
} from "./crypto-api/index.ts";
import {
    type SecretStorageKeyDescription,
    type ServerSideSecretStorage,
    ServerSideSecretStorageImpl,
} from "./secret-storage.ts";
import { type RegisterRequest, type RegisterResponse } from "./@types/registration.ts";
import { MatrixRTCSessionManager } from "./matrixrtc/MatrixRTCSessionManager.ts";
import { getRelationsThreadFilter } from "./thread-utils.ts";
import { KnownMembership, type Membership } from "./@types/membership.ts";
import { type RoomMessageEventContent, type StickerEventContent } from "./@types/events.ts";
import { type ImageInfo } from "./@types/media.ts";
import { type Capabilities, ServerCapabilities } from "./serverCapabilities.ts";
import { sha256 } from "./digest.ts";
import {
    discoverAndValidateOIDCIssuerWellKnown,
    type OidcClientConfig,
    validateAuthMetadataAndKeys,
} from "./oidc/index.ts";
import { type EmptyObject } from "./@types/common.ts";
import { UnsupportedDelayedEventsEndpointError, UnsupportedStickyEventsEndpointError } from "./errors.ts";

export type Store = IStore;

export type ResetTimelineCallback = (roomId: string) => boolean;

const SCROLLBACK_DELAY_MS = 3000;

const TURN_CHECK_INTERVAL = 10 * 60 * 1000; // poll for turn credentials every 10 minutes

export const UNSTABLE_MSC3852_LAST_SEEN_UA = new UnstableValue(
    "last_seen_user_agent",
    "org.matrix.msc3852.last_seen_user_agent",
);

export interface IKeysUploadResponse {
    one_time_key_counts: {
        // eslint-disable-line camelcase
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
     * A store to be used for end-to-end crypto session data.
     * The `createClient` helper will create a default store if needed. Calls the factory supplied to
     * {@link setCryptoStoreFactory} if unspecified; or if no factory has been
     * specified, uses a default implementation (indexeddb in the browser,
     * in-memory otherwise).
     *
     * This is only used for the legacy crypto implementation,
     * but if you use the rust crypto implementation ({@link MatrixClient#initRustCrypto}) and the device
     * previously used legacy crypto (so must be migrated), then this must still be provided, so that the
     * data can be migrated from the legacy store.
     */
    cryptoStore?: CryptoStore;

    /**
     * The scheduler to use. If not
     * specified, this client will not retry requests on failure. This client
     * will supply its own processing function to
     * {@link MatrixScheduler#setProcessFunction}.
     */
    scheduler?: MatrixScheduler;

    /**
     * The function to invoke for HTTP requests.
     * Most supported environments have a global `fetch` registered to which this will fall back.
     */
    fetchFn?: typeof globalThis.fetch;

    userId?: string;

    /**
     * A unique identifier for this device; used for tracking things like crypto
     * keys and access tokens. If not specified, end-to-end encryption will be
     * disabled.
     */
    deviceId?: string;

    accessToken?: string;
    refreshToken?: string;

    /**
     * Function used to attempt refreshing access and refresh tokens
     * Called by http-api when a possibly expired token is encountered
     * and a refreshToken is found
     */
    tokenRefreshFunction?: TokenRefreshFunction;

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
     * Set to false to send the access token to the server via a query parameter rather
     * than the Authorization HTTP header.
     *
     * Note that as of v1.11 of the Matrix spec, sending the access token via a query
     * is deprecated.
     *
     * Default true.
     */
    useAuthorizationHeader?: boolean;

    /**
     * Set to true to enable
     * improved timeline support, see {@link MatrixClient#getEventTimeline}.
     * It is disabled by default for compatibility with older clients - in particular to
     * maintain support for back-paginating the live timeline after a '/sync'
     * result with a gap.
     */
    timelineSupport?: boolean;

    /**
     * Extra query parameters to append
     * to all requests with this client. Useful for application services which require
     * `?user_id=`.
     */
    queryParams?: QueryDict;

    /**
     * Encryption key used for encrypting sensitive data (such as e2ee keys) in {@link ICreateClientOpts#cryptoStore}.
     *
     * This must be set to the same value every time the client is initialised for the same device.
     *
     * This is only used for the legacy crypto implementation,
     * but if you use the rust crypto implementation ({@link MatrixClient#initRustCrypto}) and the device
     * previously used legacy crypto (so must be migrated), then this must still be provided, so that the
     * data can be migrated from the legacy store.
     */
    pickleKey?: string;

    /**
     * Verification methods we should offer to the other side when performing an interactive verification.
     * If unset, we will offer all known methods. Currently these are: showing a QR code, scanning a QR code, and SAS
     * (aka "emojis").
     *
     * See {@link types.VerificationMethod} for a set of useful constants for this parameter.
     */
    verificationMethods?: Array<string>;

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

    /**
     * If true, to-device signalling for group calls will be encrypted
     * with Olm. Default: true.
     */
    useE2eForGroupCall?: boolean;

    livekitServiceURL?: string;

    /**
     * Crypto callbacks provided by the application
     */
    cryptoCallbacks?: CryptoCallbacks;

    /**
     * Enable encrypted state events.
     */
    enableEncryptedStateEvents?: boolean;

    /**
     * Method to generate room names for empty rooms and rooms names based on membership.
     * Defaults to a built-in English handler with basic pluralisation.
     */
    roomNameGenerator?: (roomId: string, state: RoomNameState) => string | null;

    /**
     * If true, participant can join group call without video and audio this has to be allowed. By default, a local
     * media stream is needed to establish a group call.
     * Default: false.
     */
    isVoipWithNoMediaAllowed?: boolean;

    /**
     * Disable VoIP support (prevents fetching TURN servers, etc.)
     * Default: false (VoIP enabled)
     */
    disableVoip?: boolean;

    /**
     * If true, group calls will not establish media connectivity and only create the signaling events,
     * so that livekit media can be used in the application layer (js-sdk contains no livekit code).
     */
    useLivekitForGroupCalls?: boolean;

    /**
     * A logger to associate with this MatrixClient.
     * Defaults to the built-in global logger; see {@link DebugLogger} for an alternative.
     */
    logger?: Logger;
}

export interface IMatrixClientCreateOpts extends ICreateClientOpts {
    /**
     * Whether to allow sending messages to encrypted rooms when encryption
     * is not available internally within this SDK. This is useful if you are using an external
     * E2E proxy, for example. Defaults to false.
     */
    usingExternalCrypto?: boolean;
}

export enum PendingEventOrdering {
    Chronological = "chronological",
    Detached = "detached",
}

export interface IStartClientOpts {
    /**
     * The event `limit=` to apply to initial sync. Default: 8.
     */
    initialSyncLimit?: number;

    /**
     * True to put `archived=true</code> on the <code>/initialSync` request. Default: false.
     */
    includeArchivedRooms?: boolean;

    /**
     * True to do /profile requests on every invite event if the displayname/avatar_url is not known for this user ID. Default: false.
     */
    resolveInvitesToProfiles?: boolean;

    /**
     * Controls where pending messages appear in a room's timeline. If "<b>chronological</b>", messages will
     * appear in the timeline when the call to `sendEvent` was made. If "<b>detached</b>",
     * pending messages will appear in a separate list, accessible via {@link Room#getPendingEvents}.
     * Default: "chronological".
     */
    pendingEventOrdering?: PendingEventOrdering;

    /**
     * The number of milliseconds to wait on /sync. Default: 30000 (30 seconds).
     */
    pollTimeout?: number;

    /**
     * The filter to apply to /sync calls.
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
     * Will organises events in threaded conversations when
     * a thread relation is encountered
     */
    threadSupport?: boolean;

    /**
     * @experimental
     */
    slidingSync?: SlidingSync;
}

export interface IStoredClientOpts extends IStartClientOpts {}

export const GET_LOGIN_TOKEN_CAPABILITY = new NamespacedValue(
    "m.get_login_token",
    "org.matrix.msc3882.get_login_token",
);

export const UNSTABLE_MSC2666_SHARED_ROOMS = "uk.half-shot.msc2666";
export const UNSTABLE_MSC2666_MUTUAL_ROOMS = "uk.half-shot.msc2666.mutual_rooms";
export const UNSTABLE_MSC2666_QUERY_MUTUAL_ROOMS = "uk.half-shot.msc2666.query_mutual_rooms";

export const UNSTABLE_MSC4140_DELAYED_EVENTS = "org.matrix.msc4140";
export const UNSTABLE_MSC4354_STICKY_EVENTS = "org.matrix.msc4354";

export const UNSTABLE_MSC4133_EXTENDED_PROFILES = "uk.tcpip.msc4133";
export const STABLE_MSC4133_EXTENDED_PROFILES = "uk.tcpip.msc4133.stable";

enum CrossSigningKeyType {
    MasterKey = "master_key",
    SelfSigningKey = "self_signing_key",
    UserSigningKey = "user_signing_key",
}

export type CrossSigningKeys = Record<CrossSigningKeyType, CrossSigningKeyInfo>;

export type SendToDeviceContentMap = Map<string, Map<string, Record<string, any>>>;

export interface ISignedKey {
    keys: Record<string, string>;
    signatures: ISignatures;
    user_id: string;
    algorithms: string[];
    device_id: string;
}

export type KeySignatures = Record<string, Record<string, CrossSigningKeyInfo | ISignedKey>>;
export interface IUploadKeySignaturesResponse {
    failures: Record<
        string,
        Record<
            string,
            {
                errcode: string;
                error: string;
            }
        >
    >;
}

export interface IPreviewUrlResponse {
    [key: string]: undefined | string | number;
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

export interface ITurnServerResponse {
    uris: string[];
    username: string;
    password: string;
    ttl: number;
}

export interface ITurnServer {
    urls: string[];
    username: string;
    credential: string;
}

export interface IServerVersions {
    versions: string[];
    unstable_features: Record<string, boolean>;
}

export interface IClientWellKnown {
    [key: string]: any;
    "m.homeserver"?: IWellKnownConfig;
    "m.identity_server"?: IWellKnownConfig;
}

export interface IWellKnownConfig<T = IClientWellKnown> {
    raw?: T;
    action?: AutoDiscoveryAction;
    reason?: string;
    error?: Error | string;
    // eslint-disable-next-line
    base_url?: string | null;
    // XXX: this is undocumented
    server_name?: string;
}

interface IKeyBackupPath {
    path: string;
    queryData?: {
        version: string;
    };
}

interface IMediaConfig {
    [key: string]: any; // extensible
    "m.upload.size"?: number;
}

interface IThirdPartySigned {
    sender: string;
    mxid: string;
    token: string;
    signatures: ISignatures;
}

interface IJoinRequestBody {
    third_party_signed?: IThirdPartySigned;
}

interface ITagMetadata {
    [key: string]: any;
    order?: number;
}

interface IMessagesResponse {
    start?: string;
    end?: string;
    chunk: IRoomEvent[];
    state?: IStateEvent[];
}

interface IThreadedMessagesResponse {
    prev_batch: string;
    next_batch: string;
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

export interface IUploadKeysRequest {
    "device_keys"?: Required<IDeviceKeys>;
    "one_time_keys"?: Record<string, IOneTimeKey>;
    "org.matrix.msc2732.fallback_keys"?: Record<string, IOneTimeKey>;
}

export interface IQueryKeysRequest {
    device_keys: { [userId: string]: string[] };
    timeout?: number;
    token?: string;
}

export interface IClaimKeysRequest {
    one_time_keys: { [userId: string]: { [deviceId: string]: string } };
    timeout?: number;
}

export interface IOpenIDToken {
    access_token: string;
    token_type: "Bearer" | string;
    matrix_server_name: string;
    expires_in: number;
}

interface IRoomInitialSyncResponse {
    room_id: string;
    membership: Membership;
    messages?: {
        start?: string;
        end?: string;
        chunk: IEventWithRoomId[];
    };
    state?: IStateEventWithRoomId[];
    visibility: Visibility;
    account_data?: IMinimalEvent[];
    presence: Partial<IEvent>; // legacy and undocumented, api is deprecated so this won't get attention
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

// Re-export for backwards compatibility
export type IRegisterRequestParams = RegisterRequest;

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
    room_type?: RoomType | string; // Added by MSC3827
    join_rule?: JoinRule.Knock | JoinRule.Public; // Added by MSC2403
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
    "device_id": string;
    "display_name"?: string;
    "last_seen_ip"?: string;
    "last_seen_ts"?: number;
    // UNSTABLE_MSC3852_LAST_SEEN_UA
    "last_seen_user_agent"?: string;
    "org.matrix.msc3852.last_seen_user_agent"?: string;
}

export interface Keys {
    keys: { [keyId: string]: string };
    usage: string[];
    user_id: string;
}

export interface SigningKeys extends Keys {
    signatures: ISignatures;
}

export interface DeviceKeys {
    [deviceId: string]: IDeviceKeys & {
        unsigned?: {
            device_display_name: string;
        };
    };
}

export interface IDownloadKeyResult {
    failures: { [serverName: string]: object };
    device_keys: { [userId: string]: DeviceKeys };
    // the following three fields were added in 1.1
    master_keys?: { [userId: string]: Keys };
    self_signing_keys?: { [userId: string]: SigningKeys };
    user_signing_keys?: { [userId: string]: SigningKeys };
}

export interface IClaimOTKsResult {
    failures: { [serverName: string]: object };
    one_time_keys: {
        [userId: string]: {
            [deviceId: string]: {
                [keyId: string]: {
                    key: string;
                    signatures: ISignatures;
                };
            };
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
    // XXX: this is undocumented but we rely on it: https://github.com/matrix-org/matrix-doc/issues/3203
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

/**
 * The summary of a room as defined by an initial version of MSC3266 and implemented in Synapse
 * Proposed at https://github.com/matrix-org/matrix-doc/pull/3266
 */
export interface RoomSummary extends Omit<IPublicRoomsChunkRoom, "canonical_alias" | "aliases"> {
    /**
     * The current membership of this user in the room.
     * Usually "leave" if the room is fetched over federation.
     */
    "membership"?: Membership;
    /**
     * Version of the room.
     */
    "im.nheko.summary.room_version"?: string;
    /**
     * The encryption algorithm used for this room, if the room is encrypted.
     */
    "im.nheko.summary.encryption"?: string;
}

interface IRoomHierarchy {
    rooms: IHierarchyRoom[];
    next_batch?: string;
}

export interface TimestampToEventResponse {
    event_id: string;
    origin_server_ts: number;
}

interface IWhoamiResponse {
    user_id: string;
    device_id?: string;
    is_guest?: boolean;
}
/* eslint-enable camelcase */

// We're using this constant for methods overloading and inspect whether a variable
// contains an eventId or not. This was required to ensure backwards compatibility
// of methods for threads
// Probably not the most graceful solution but does a good enough job for now
const EVENT_ID_PREFIX = "$";

export enum ClientEvent {
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
     * ```
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
     * ```
     * Transitions:
     * <ul>
     *
     * <li>`null -> PREPARED` : Occurs when the initial sync is completed
     * first time. This involves setting up filters and obtaining push rules.
     *
     * <li>`null -> ERROR` : Occurs when the initial sync failed first time.
     *
     * <li>`ERROR -> PREPARED` : Occurs when the initial sync succeeds
     * after previously failing.
     *
     * <li>`PREPARED -> SYNCING` : Occurs immediately after transitioning
     * to PREPARED. Starts listening for live updates rather than catching up.
     *
     * <li>`SYNCING -> RECONNECTING` : Occurs when the live update fails.
     *
     * <li>`RECONNECTING -> RECONNECTING` : Can occur if the update calls
     * continue to fail, but the keepalive calls (to /versions) succeed.
     *
     * <li>`RECONNECTING -> ERROR` : Occurs when the keepalive call also fails
     *
     * <li>`ERROR -> SYNCING` : Occurs when the client has performed a
     * live update after having previously failed.
     *
     * <li>`ERROR -> ERROR` : Occurs when the client has failed to keepalive
     * for a second time or more.</li>
     *
     * <li>`SYNCING -> SYNCING` : Occurs when the client has performed a live
     * update. This is called <i>after</i> processing.</li>
     *
     * <li>`* -> STOPPED` : Occurs once the client has stopped syncing or
     * trying to sync after stopClient has been called.</li>
     * </ul>
     *
     * The payloads consits of the following 3 parameters:
     *
     * - state - An enum representing the syncing state. One of "PREPARED",
     * "SYNCING", "ERROR", "STOPPED".
     *
     * - prevState - An enum representing the previous syncing state.
     * One of "PREPARED", "SYNCING", "ERROR", "STOPPED" <b>or null</b>.
     *
     * - data - Data about this transition.
     *
     * @example
     * ```
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
     * ```
     */
    Sync = "sync",
    /**
     * Fires whenever the SDK receives a new event.
     * <p>
     * This is only fired for live events received via /sync - it is not fired for
     * events received over context, search, or pagination APIs.
     *
     * The payload is the matrix event which caused this event to fire.
     * @example
     * ```
     * matrixClient.on("event", function(event){
     *   var sender = event.getSender();
     * });
     * ```
     */
    Event = "event",
    /** @deprecated Use {@link ReceivedToDeviceMessage}.
     * Fires whenever the SDK receives a new to-device event.
     * The payload is the matrix event ({@link MatrixEvent}) which caused this event to fire.
     * @example
     * ```
     * matrixClient.on("toDeviceEvent", function(event){
     *   var sender = event.getSender();
     * });
     * ```
     */
    ToDeviceEvent = "toDeviceEvent",
    /**
     * Fires whenever the SDK receives a new (potentially decrypted) to-device message.
     * The payload is the to-device message and the encryption info for that message ({@link ReceivedToDeviceMessage}).
     * @example
     * ```
     * matrixClient.on("receivedToDeviceMessage", function(payload){
     *   const { message, encryptionInfo } = payload;
     *   var claimed_sender = encryptionInfo ? encryptionInfo.sender : message.sender;
     *   var isVerified = encryptionInfo ? encryptionInfo.verified : false;
     *   var type = message.type;
     * });
     */
    ReceivedToDeviceMessage = "receivedToDeviceMessage",
    /**
     * Fires whenever new user-scoped account_data is added.
     * The payload is a pair of event ({@link MatrixEvent}) describing the account_data just added, and the previous event, if known:
     *  - event: The event describing the account_data just added
     *  - oldEvent: The previous account data, if known.
     * @example
     * ```
     * matrixClient.on("accountData", function(event, oldEvent){
     *   myAccountData[event.type] = event.content;
     * });
     * ```
     */
    AccountData = "accountData",
    /**
     * Fires whenever a new Room is added. This will fire when you are invited to a
     * room, as well as when you join a room. <strong>This event is experimental and
     * may change.</strong>
     *
     * The payload is the newly created room, fully populated.
     * @example
     * ```
     * matrixClient.on("Room", function(room){
     *   var roomId = room.roomId;
     * });
     * ```
     */
    Room = "Room",
    /**
     * Fires whenever a Room is removed. This will fire when you forget a room.
     * <strong>This event is experimental and may change.</strong>
     * The payload is the roomId of the deleted room.
     * @example
     * ```
     * matrixClient.on("deleteRoom", function(roomId){
     *   // update UI from getRooms()
     * });
     * ```
     */
    DeleteRoom = "deleteRoom",
    SyncUnexpectedError = "sync.unexpectedError",
    /**
     * Fires when the client .well-known info is fetched.
     * The payload is the JSON object (see {@link IClientWellKnown}) returned by the server
     */
    ClientWellKnown = "WellKnown.client",
    ReceivedVoipEvent = "received_voip_event",
    TurnServers = "turnServers",
    TurnServersError = "turnServers.error",
}

type RoomEvents =
    | RoomEvent.Name
    | RoomEvent.Redaction
    | RoomEvent.RedactionCancelled
    | RoomEvent.Receipt
    | RoomEvent.Tags
    | RoomEvent.LocalEchoUpdated
    | RoomEvent.HistoryImportedWithinTimeline
    | RoomEvent.AccountData
    | RoomEvent.MyMembership
    | RoomEvent.Timeline
    | RoomEvent.TimelineReset;

type RoomStateEvents =
    | RoomStateEvent.Events
    | RoomStateEvent.Members
    | RoomStateEvent.NewMember
    | RoomStateEvent.Update
    | RoomStateEvent.Marker;

type CryptoEvents = (typeof CryptoEvent)[keyof typeof CryptoEvent];

type MatrixEventEvents = MatrixEventEvent.Decrypted | MatrixEventEvent.Replaced | MatrixEventEvent.VisibilityChange;

type RoomMemberEvents =
    | RoomMemberEvent.Name
    | RoomMemberEvent.Typing
    | RoomMemberEvent.PowerLevel
    | RoomMemberEvent.Membership;

type UserEvents =
    | UserEvent.AvatarUrl
    | UserEvent.DisplayName
    | UserEvent.Presence
    | UserEvent.CurrentlyActive
    | UserEvent.LastPresenceTs;

export type EmittedEvents =
    | ClientEvent
    | RoomEvents
    | RoomStateEvents
    | CryptoEvents
    | MatrixEventEvents
    | RoomMemberEvents
    | UserEvents
    | CallEvent // re-emitted by call.ts using Object.values
    | CallEventHandlerEvent.Incoming
    | GroupCallEventHandlerEvent.Incoming
    | GroupCallEventHandlerEvent.Outgoing
    | GroupCallEventHandlerEvent.Ended
    | GroupCallEventHandlerEvent.Participants
    | HttpApiEvent.SessionLoggedOut
    | HttpApiEvent.NoConsent
    | BeaconEvent;

export type ClientEventHandlerMap = {
    [ClientEvent.Sync]: (state: SyncState, prevState: SyncState | null, data?: ISyncStateData) => void;
    [ClientEvent.Event]: (event: MatrixEvent) => void;
    [ClientEvent.ToDeviceEvent]: (event: MatrixEvent) => void;
    [ClientEvent.ReceivedToDeviceMessage]: (payload: ReceivedToDeviceMessage) => void;
    [ClientEvent.AccountData]: (event: MatrixEvent, lastEvent?: MatrixEvent) => void;
    [ClientEvent.Room]: (room: Room) => void;
    [ClientEvent.DeleteRoom]: (roomId: string) => void;
    [ClientEvent.SyncUnexpectedError]: (error: Error) => void;
    [ClientEvent.ClientWellKnown]: (data: IClientWellKnown) => void;
    [ClientEvent.ReceivedVoipEvent]: (event: MatrixEvent) => void;
    [ClientEvent.TurnServers]: (servers: ITurnServer[]) => void;
    [ClientEvent.TurnServersError]: (error: Error, fatal: boolean) => void;
} & RoomEventHandlerMap &
    RoomStateEventHandlerMap &
    CryptoEventHandlerMap &
    MatrixEventHandlerMap &
    RoomMemberEventHandlerMap &
    UserEventHandlerMap &
    CallEventHandlerEventHandlerMap &
    GroupCallEventHandlerEventHandlerMap &
    CallEventHandlerMap &
    HttpApiEventHandlerMap &
    BeaconEventHandlerMap;

const SSO_ACTION_PARAM = new UnstableValue("action", "org.matrix.msc3824.action");

/**
 * Represents a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 */
export class MatrixClient extends TypedEventEmitter<EmittedEvents, ClientEventHandlerMap> {
    public static readonly RESTORE_BACKUP_ERROR_BAD_KEY = "RESTORE_BACKUP_ERROR_BAD_KEY";

    private readonly logger: Logger;

    public reEmitter = new TypedReEmitter<EmittedEvents, ClientEventHandlerMap>(this);
    public olmVersion: [number, number, number] | null = null; // populated after initLegacyCrypto
    public usingExternalCrypto = false;
    private _store!: Store;
    public deviceId: string | null;
    public credentials: { userId: string | null };

    /**
     * Encryption key used for encrypting sensitive data (such as e2ee keys) in storage.
     *
     * As supplied in the constructor via {@link IMatrixClientCreateOpts#pickleKey}.
     * Used for migration from the legacy crypto to the rust crypto
     */
    private readonly legacyPickleKey?: string;

    public scheduler?: MatrixScheduler;
    public clientRunning = false;
    public timelineSupport = false;
    public urlPreviewCache: { [key: string]: Promise<IPreviewUrlResponse> } = {};
    public identityServer?: IIdentityServerProvider;
    public http: MatrixHttpApi<IHttpOpts & { onlyData: true }>; // XXX: Intended private, used in code.

    private cryptoBackend?: CryptoBackend; // one of crypto or rustCrypto
    private readonly enableEncryptedStateEvents: boolean;
    public cryptoCallbacks: CryptoCallbacks; // XXX: Intended private, used in code.
    public callEventHandler?: CallEventHandler; // XXX: Intended private, used in code.
    public groupCallEventHandler?: GroupCallEventHandler;
    public supportsCallTransfer = false; // XXX: Intended private, used in code.
    public forceTURN = false; // XXX: Intended private, used in code.
    public iceCandidatePoolSize = 0; // XXX: Intended private, used in code.
    public idBaseUrl?: string;
    public baseUrl: string;
    public readonly isVoipWithNoMediaAllowed;
    public disableVoip: boolean;

    public useLivekitForGroupCalls: boolean;

    // Note: these are all `protected` to let downstream consumers make mistakes if they want to.
    // We don't technically support this usage, but have reasons to do this.

    protected canSupportVoip = false;
    protected peekSync: SyncApi | null = null;
    protected isGuestAccount = false;
    protected ongoingScrollbacks: { [roomId: string]: { promise?: Promise<Room>; errorTs?: number } } = {};
    protected notifTimelineSet: EventTimelineSet | null = null;

    /**
     * Legacy crypto store used for migration from the legacy crypto to the rust crypto
     * @private
     */
    private readonly legacyCryptoStore?: CryptoStore;
    protected verificationMethods?: string[];
    protected fallbackICEServerAllowed = false;
    protected syncApi?: SlidingSyncSdk | SyncApi;
    public roomNameGenerator?: ICreateClientOpts["roomNameGenerator"];
    public pushRules?: IPushRules;
    protected syncLeftRoomsPromise?: Promise<Room[]>;
    protected syncedLeftRooms = false;
    protected clientOpts?: IStoredClientOpts;
    protected clientWellKnownIntervalID?: ReturnType<typeof setInterval>;
    protected canResetTimelineCallback?: ResetTimelineCallback;

    public canSupport = new Map<Feature, ServerSupport>();

    // The pushprocessor caches useful things, so keep one and re-use it
    public readonly pushProcessor = new PushProcessor(this);

    // Promise to a response of the server's /versions response
    // TODO: This should expire: https://github.com/matrix-org/matrix-js-sdk/issues/1020
    protected serverVersionsPromise?: Promise<IServerVersions>;

    protected clientWellKnown?: IClientWellKnown;
    protected clientWellKnownPromise?: Promise<IClientWellKnown>;
    protected turnServers: ITurnServer[] = [];
    protected turnServersExpiry = 0;
    protected checkTurnServersIntervalID?: ReturnType<typeof setInterval>;
    protected txnCtr = 0;
    protected mediaHandler = new MediaHandler(this);
    protected sessionId: string;

    /** IDs of events which are currently being encrypted.
     *
     * This is part of the cancellation mechanism: if the event is no longer listed here when encryption completes,
     * that tells us that it has been cancelled, and we should not send it.
     */
    private eventsBeingEncrypted = new Set<string>();

    private useE2eForGroupCall = true;
    private toDeviceMessageQueue: ToDeviceMessageQueue;
    public livekitServiceURL?: string;

    private _secretStorage: ServerSideSecretStorageImpl;

    // A manager for determining which invites should be ignored.
    public readonly ignoredInvites: IgnoredInvites;

    public readonly matrixRTC: MatrixRTCSessionManager;

    private serverCapabilitiesService: ServerCapabilities;

    public constructor(opts: IMatrixClientCreateOpts) {
        super();

        // If a custom logger is provided, use it. Otherwise, default to the global
        // one in logger.ts.
        this.logger = opts.logger ?? logger;

        opts.baseUrl = utils.ensureNoTrailingSlash(opts.baseUrl);
        opts.idBaseUrl = utils.ensureNoTrailingSlash(opts.idBaseUrl);

        this.baseUrl = opts.baseUrl;
        this.idBaseUrl = opts.idBaseUrl;
        this.identityServer = opts.identityServer;

        this.usingExternalCrypto = opts.usingExternalCrypto ?? false;
        this.store = opts.store || new StubStore();
        this.deviceId = opts.deviceId || null;
        this.sessionId = secureRandomString(10);

        const userId = opts.userId || null;
        this.credentials = { userId };

        this.http = new MatrixHttpApi(this as ConstructorParameters<typeof MatrixHttpApi>[0], {
            fetchFn: opts.fetchFn,
            baseUrl: opts.baseUrl,
            idBaseUrl: opts.idBaseUrl,
            accessToken: opts.accessToken,
            refreshToken: opts.refreshToken,
            tokenRefreshFunction: opts.tokenRefreshFunction,
            prefix: ClientPrefix.V3,
            onlyData: true,
            extraParams: opts.queryParams,
            localTimeoutMs: opts.localTimeoutMs,
            useAuthorizationHeader: opts.useAuthorizationHeader,
            logger: this.logger,
        });

        if (opts.pickleKey) {
            this.legacyPickleKey = opts.pickleKey;
        }

        this.useLivekitForGroupCalls = Boolean(opts.useLivekitForGroupCalls);

        this.scheduler = opts.scheduler;
        if (this.scheduler) {
            this.scheduler.setProcessFunction(async (eventToSend: MatrixEvent) => {
                const room = this.getRoom(eventToSend.getRoomId());
                if (eventToSend.status !== EventStatus.SENDING) {
                    this.updatePendingEventStatus(room, eventToSend, EventStatus.SENDING);
                }
                const res = await this.sendEventHttpRequest(eventToSend);
                if (room) {
                    // ensure we update pending event before the next scheduler run so that any listeners to event id
                    // updates on the synchronous event emitter get a chance to run first.
                    room.updatePendingEvent(eventToSend, EventStatus.SENT, res.event_id);
                }
                return res;
            });
        }

        this.disableVoip = opts.disableVoip ?? false;

        if (!this.disableVoip && supportsMatrixCall()) {
            this.callEventHandler = new CallEventHandler(this);
            this.groupCallEventHandler = new GroupCallEventHandler(this);
            this.canSupportVoip = true;
            // Start listening for calls after the initial sync is done
            // We do not need to backfill the call event buffer
            // with encrypted events that might never get decrypted
            this.on(ClientEvent.Sync, this.startCallEventHandler);
        }

        // NB. We initialise MatrixRTC whether we have call support or not: this is just
        // the underlying session management and doesn't use any actual media capabilities
        this.matrixRTC = new MatrixRTCSessionManager(this.logger, this);

        this.serverCapabilitiesService = new ServerCapabilities(this.logger, this.http);

        this.on(ClientEvent.Sync, this.fixupRoomNotifications);

        this.timelineSupport = Boolean(opts.timelineSupport);

        this.legacyCryptoStore = opts.cryptoStore;
        this.verificationMethods = opts.verificationMethods;
        this.cryptoCallbacks = opts.cryptoCallbacks || {};
        this.enableEncryptedStateEvents = opts.enableEncryptedStateEvents ?? false;

        this.forceTURN = opts.forceTURN || false;
        this.iceCandidatePoolSize = opts.iceCandidatePoolSize === undefined ? 0 : opts.iceCandidatePoolSize;
        this.supportsCallTransfer = opts.supportsCallTransfer || false;
        this.fallbackICEServerAllowed = opts.fallbackICEServerAllowed || false;
        this.isVoipWithNoMediaAllowed = opts.isVoipWithNoMediaAllowed || false;

        if (opts.useE2eForGroupCall !== undefined) this.useE2eForGroupCall = opts.useE2eForGroupCall;

        this.livekitServiceURL = opts.livekitServiceURL;

        this.roomNameGenerator = opts.roomNameGenerator;

        this.toDeviceMessageQueue = new ToDeviceMessageQueue(this, this.logger);

        // The SDK doesn't really provide a clean way for events to recalculate the push
        // actions for themselves, so we have to kinda help them out when they are encrypted.
        // We do this so that push rules are correctly executed on events in their decrypted
        // state, such as highlights when the user's name is mentioned.
        this.on(MatrixEventEvent.Decrypted, (event) => {
            fixNotificationCountOnDecryption(this, event);
        });

        this.ignoredInvites = new IgnoredInvites(this);
        this._secretStorage = new ServerSideSecretStorageImpl(this, opts.cryptoCallbacks ?? {});

        // having lots of event listeners is not unusual. 0 means "unlimited".
        this.setMaxListeners(0);
    }

    public set store(newStore: Store) {
        this._store = newStore;
        this._store.setUserCreator((userId) => User.createUser(userId, this));
    }

    public get store(): Store {
        return this._store;
    }

    /**
     * High level helper method to begin syncing and poll for new events. To listen for these
     * events, add a listener for {@link ClientEvent.Event}
     * via {@link MatrixClient#on}. Alternatively, listen for specific
     * state change events.
     * @param opts - Options to apply when syncing.
     */
    public async startClient(opts?: IStartClientOpts): Promise<void> {
        if (this.clientRunning) {
            // client is already running.
            return;
        }
        this.clientRunning = true;

        this.on(ClientEvent.Sync, this.startMatrixRTC);

        // Create our own user object artificially (instead of waiting for sync)
        // so it's always available, even if the user is not in any rooms etc.
        const userId = this.getUserId();
        if (userId) {
            this.store.storeUser(new User(userId));
        }

        // periodically poll for turn servers if we support voip
        if (this.supportsVoip()) {
            this.checkTurnServersIntervalID = setInterval(() => {
                this.checkTurnServers();
            }, TURN_CHECK_INTERVAL);
            // noinspection ES6MissingAwait
            this.checkTurnServers();
        }

        if (this.syncApi) {
            // This shouldn't happen since we thought the client was not running
            this.logger.error("Still have sync object whilst not running: stopping old one");
            this.syncApi.stop();
        }

        try {
            await this.getVersions();

            // This should be done with `canSupport`
            // TODO: https://github.com/vector-im/element-web/issues/23643
            const { threads, list, fwdPagination } = await this.doesServerSupportThread();
            Thread.setServerSideSupport(threads);
            Thread.setServerSideListSupport(list);
            Thread.setServerSideFwdPaginationSupport(fwdPagination);
        } catch (e) {
            this.logger.error(
                "Can't fetch server versions, continuing to initialise sync, this will be retried later",
                e,
            );
        }

        this.clientOpts = opts ?? {};
        if (this.clientOpts.slidingSync) {
            this.syncApi = new SlidingSyncSdk(
                this.clientOpts.slidingSync,
                this,
                this.clientOpts,
                this.buildSyncApiOptions(),
            );
        } else {
            this.syncApi = new SyncApi(this, this.clientOpts, this.buildSyncApiOptions());
        }

        this.syncApi.sync().catch((e) => this.logger.info("Sync startup aborted with an error:", e));

        if (this.clientOpts.clientWellKnownPollPeriod !== undefined) {
            this.clientWellKnownIntervalID = setInterval(() => {
                this.fetchClientWellKnown();
            }, 1000 * this.clientOpts.clientWellKnownPollPeriod);
            this.fetchClientWellKnown();
        }

        this.toDeviceMessageQueue.start();
        this.serverCapabilitiesService.start();
    }

    /**
     * Construct a SyncApiOptions for this client, suitable for passing into the SyncApi constructor
     */
    protected buildSyncApiOptions(): SyncApiOptions {
        return {
            cryptoCallbacks: this.cryptoBackend,
            canResetEntireTimeline: (roomId: string): boolean => {
                if (!this.canResetTimelineCallback) {
                    return false;
                }
                return this.canResetTimelineCallback(roomId);
            },
            logger: this.logger.getChild("sync"),
        };
    }

    /**
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    public stopClient(): void {
        this.cryptoBackend?.stop(); // crypto might have been initialised even if the client wasn't fully started

        this.off(ClientEvent.Sync, this.startMatrixRTC);

        if (!this.clientRunning) return; // already stopped

        this.logger.debug("stopping MatrixClient");

        this.clientRunning = false;

        this.syncApi?.stop();
        this.syncApi = undefined;

        this.peekSync?.stopPeeking();

        this.callEventHandler?.stop();
        this.groupCallEventHandler?.stop();
        this.callEventHandler = undefined;
        this.groupCallEventHandler = undefined;

        globalThis.clearInterval(this.checkTurnServersIntervalID);
        this.checkTurnServersIntervalID = undefined;

        if (this.clientWellKnownIntervalID !== undefined) {
            globalThis.clearInterval(this.clientWellKnownIntervalID);
        }

        this.toDeviceMessageQueue.stop();

        this.matrixRTC.stop();

        this.serverCapabilitiesService.stop();
    }

    /**
     * Clear any data out of the persistent stores used by the client.
     *
     * @param args.cryptoDatabasePrefix - The database name to use for indexeddb, defaults to 'matrix-js-sdk'.
     * @returns Promise which resolves when the stores have been cleared.
     */
    public clearStores(
        args: {
            cryptoDatabasePrefix?: string;
        } = {},
    ): Promise<void> {
        if (this.clientRunning) {
            throw new Error("Cannot clear stores while client is running");
        }

        const promises: Promise<void>[] = [];

        promises.push(this.store.deleteAllData());
        if (this.legacyCryptoStore) {
            promises.push(this.legacyCryptoStore.deleteAllData());
        }

        // delete the stores used by the rust matrix-sdk-crypto, in case they were used
        const deleteRustSdkStore = async (): Promise<void> => {
            let indexedDB: IDBFactory;
            try {
                indexedDB = globalThis.indexedDB;
                if (!indexedDB) return; // No indexedDB support
            } catch {
                // No indexedDB support
                return;
            }
            for (const dbname of [
                `${args.cryptoDatabasePrefix ?? RUST_SDK_STORE_PREFIX}::matrix-sdk-crypto`,
                `${args.cryptoDatabasePrefix ?? RUST_SDK_STORE_PREFIX}::matrix-sdk-crypto-meta`,
            ]) {
                const prom = new Promise((resolve, reject) => {
                    this.logger.info(`Removing IndexedDB instance ${dbname}`);
                    const req = indexedDB.deleteDatabase(dbname);
                    req.onsuccess = (_): void => {
                        this.logger.info(`Removed IndexedDB instance ${dbname}`);
                        resolve(0);
                    };
                    req.onerror = (e): void => {
                        // In private browsing, Firefox has a globalThis.indexedDB, but attempts to delete an indexeddb
                        // (even a non-existent one) fail with "DOMException: A mutation operation was attempted on a
                        // database that did not allow mutations."
                        //
                        // it seems like the only thing we can really do is ignore the error.
                        this.logger.warn(`Failed to remove IndexedDB instance ${dbname}:`, e);
                        resolve(0);
                    };
                    req.onblocked = (e): void => {
                        this.logger.info(`cannot yet remove IndexedDB instance ${dbname}`);
                    };
                });
                await prom;
            }
        };
        promises.push(deleteRustSdkStore());

        return Promise.all(promises).then(); // .then to fix types
    }

    /**
     * Get the user-id of the logged-in user
     *
     * @returns MXID for the logged-in user, or null if not logged in
     */
    public getUserId(): string | null {
        return this.credentials?.userId ?? null;
    }

    /**
     * Get the user-id of the logged-in user
     *
     * @returns MXID for the logged-in user
     * @throws Error if not logged in
     */
    public getSafeUserId(): string {
        const userId = this.getUserId();
        if (!userId) {
            throw new Error("Expected logged in user but found none.");
        }
        return userId;
    }

    /**
     * Get the domain for this client's MXID
     * @returns Domain of this MXID
     */
    public getDomain(): string | null {
        if (this.credentials?.userId) {
            return this.credentials.userId.replace(/^.*?:/, "");
        }
        return null;
    }

    /**
     * Get the local part of the current user ID e.g. "foo" in "\@foo:bar".
     * @returns The user ID localpart or null.
     */
    public getUserIdLocalpart(): string | null {
        return this.credentials?.userId?.split(":")[0].substring(1) ?? null;
    }

    /**
     * Get the device ID of this client
     * @returns device ID
     */
    public getDeviceId(): string | null {
        return this.deviceId;
    }

    /**
     * Get the session ID of this client
     * @returns session ID
     */
    public getSessionId(): string {
        return this.sessionId;
    }

    /**
     * Check if the runtime environment supports VoIP calling.
     * @returns True if VoIP is supported.
     */
    public supportsVoip(): boolean {
        return !this.disableVoip && this.canSupportVoip;
    }

    /**
     * @returns
     */
    public getMediaHandler(): MediaHandler {
        return this.mediaHandler;
    }

    /**
     * Set whether VoIP calls are forced to use only TURN
     * candidates. This is the same as the forceTURN option
     * when creating the client.
     * @param force - True to force use of TURN servers
     */
    public setForceTURN(force: boolean): void {
        this.forceTURN = force;
    }

    /**
     * Set whether to advertise transfer support to other parties on Matrix calls.
     * @param support - True to advertise the 'm.call.transferee' capability
     */
    public setSupportsCallTransfer(support: boolean): void {
        this.supportsCallTransfer = support;
    }

    /**
     * Returns true if to-device signalling for group calls will be encrypted with Olm.
     * If false, it will be sent unencrypted.
     * @returns boolean Whether group call signalling will be encrypted
     */
    public getUseE2eForGroupCall(): boolean {
        return this.useE2eForGroupCall;
    }

    /**
     * Creates a new call.
     * The place*Call methods on the returned call can be used to actually place a call
     *
     * @param roomId - The room the call is to be placed in.
     * @returns the call or null if the browser doesn't support calling.
     */
    public createCall(roomId: string): MatrixCall | null {
        return createNewMatrixCall(this, roomId);
    }

    /**
     * Creates a new group call and sends the associated state event
     * to alert other members that the room now has a group call.
     *
     * @param roomId - The room the call is to be placed in.
     */
    public async createGroupCall(
        roomId: string,
        type: GroupCallType,
        isPtt: boolean,
        intent: GroupCallIntent,
        dataChannelsEnabled?: boolean,
        dataChannelOptions?: IGroupCallDataChannelOptions,
    ): Promise<GroupCall> {
        if (this.getGroupCallForRoom(roomId)) {
            throw new Error(`${roomId} already has an existing group call`);
        }

        const room = this.getRoom(roomId);

        if (!room) {
            throw new Error(`Cannot find room ${roomId}`);
        }

        // Because without Media section a WebRTC connection is not possible, so need a RTCDataChannel to set up a
        // no media WebRTC connection anyway.
        return new GroupCall(
            this,
            room,
            type,
            isPtt,
            intent,
            undefined,
            dataChannelsEnabled || this.isVoipWithNoMediaAllowed,
            dataChannelOptions,
            this.isVoipWithNoMediaAllowed,
            this.useLivekitForGroupCalls,
            this.livekitServiceURL,
        ).create();
    }

    public getLivekitServiceURL(): string | undefined {
        return this.livekitServiceURL;
    }

    // This shouldn't need to exist, but the widget API has startup ordering problems that
    // mean it doesn't know the livekit URL fast enough: remove this once this is fixed.
    public setLivekitServiceURL(newURL: string): void {
        this.livekitServiceURL = newURL;
    }

    /**
     * Wait until an initial state for the given room has been processed by the
     * client and the client is aware of any ongoing group calls. Awaiting on
     * the promise returned by this method before calling getGroupCallForRoom()
     * avoids races where getGroupCallForRoom is called before the state for that
     * room has been processed. It does not, however, fix other races, eg. two
     * clients both creating a group call at the same time.
     * @param roomId - The room ID to wait for
     * @returns A promise that resolves once existing group calls in the room
     *          have been processed.
     */
    public waitUntilRoomReadyForGroupCalls(roomId: string): Promise<void> {
        return this.groupCallEventHandler!.waitUntilRoomReadyForGroupCalls(roomId);
    }

    /**
     * Get an existing group call for the provided room.
     * @returns The group call or null if it doesn't already exist.
     */
    public getGroupCallForRoom(roomId: string): GroupCall | null {
        return this.groupCallEventHandler!.groupCalls.get(roomId) || null;
    }

    /**
     * Get the current sync state.
     * @returns the sync state, which may be null.
     * @see MatrixClient#event:"sync"
     */
    public getSyncState(): SyncState | null {
        return this.syncApi?.getSyncState() ?? null;
    }

    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     */
    public getSyncStateData(): ISyncStateData | null {
        if (!this.syncApi) {
            return null;
        }
        return this.syncApi.getSyncStateData();
    }

    /**
     * Whether the initial sync has completed.
     * @returns True if at least one sync has happened.
     */
    public isInitialSyncComplete(): boolean {
        const state = this.getSyncState();
        if (!state) {
            return false;
        }
        return state === SyncState.Prepared || state === SyncState.Syncing;
    }

    /**
     * Return whether the client is configured for a guest account.
     * @returns True if this is a guest access_token (or no token is supplied).
     */
    public isGuest(): boolean {
        return this.isGuestAccount;
    }

    /**
     * Set whether this client is a guest account. <b>This method is experimental
     * and may change without warning.</b>
     * @param guest - True if this is a guest account.
     * @experimental if the token is a macaroon, it should be encoded in it that it is a 'guest'
     * access token, which means that the SDK can determine this entirely without
     * the dev manually flipping this flag.
     */
    public setGuest(guest: boolean): void {
        this.isGuestAccount = guest;
    }

    /**
     * Return the provided scheduler, if any.
     * @returns The scheduler or undefined
     */
    public getScheduler(): MatrixScheduler | undefined {
        return this.scheduler;
    }

    /**
     * Retry a backed off syncing request immediately. This should only be used when
     * the user <b>explicitly</b> attempts to retry their lost connection.
     * Will also retry any outbound to-device messages currently in the queue to be sent
     * (retries of regular outgoing events are handled separately, per-event).
     * @returns True if this resulted in a request being retried.
     */
    public retryImmediately(): boolean {
        // don't await for this promise: we just want to kick it off
        this.toDeviceMessageQueue.sendQueue();
        return this.syncApi?.retryImmediately() ?? false;
    }

    /**
     * Return the global notification EventTimelineSet, if any
     *
     * @returns the globl notification EventTimelineSet
     */
    public getNotifTimelineSet(): EventTimelineSet | null {
        return this.notifTimelineSet;
    }

    /**
     * Set the global notification EventTimelineSet
     *
     */
    public setNotifTimelineSet(set: EventTimelineSet): void {
        this.notifTimelineSet = set;
    }

    /**
     * Gets the cached capabilities of the homeserver, returning cached ones if available.
     * If there are no cached capabilities and none can be fetched, throw an exception.
     *
     * @returns Promise resolving with The capabilities of the homeserver
     */
    public async getCapabilities(): Promise<Capabilities> {
        const caps = this.serverCapabilitiesService.getCachedCapabilities();
        if (caps) return caps;
        return this.serverCapabilitiesService.fetchCapabilities();
    }

    /**
     * Gets the cached capabilities of the homeserver. If none have been fetched yet,
     * return undefined.
     *
     * @returns The capabilities of the homeserver
     */
    public getCachedCapabilities(): Capabilities | undefined {
        return this.serverCapabilitiesService.getCachedCapabilities();
    }

    /**
     * Fetches the latest capabilities from the homeserver, ignoring any cached
     * versions. The newly returned version is cached.
     *
     * @returns A promise which resolves to the capabilities of the homeserver
     */
    public fetchCapabilities(): Promise<Capabilities> {
        return this.serverCapabilitiesService.fetchCapabilities();
    }

    /**
     * Initialise support for end-to-end encryption in this client, using the rust matrix-sdk-crypto.
     *
     * **WARNING**: the cryptography stack is not thread-safe. Having multiple `MatrixClient` instances connected to
     * the same Indexed DB will cause data corruption and decryption failures. The application layer is responsible for
     * ensuring that only one `MatrixClient` issue is instantiated at a time.
     *
     * @param args.useIndexedDB - True to use an indexeddb store, false to use an in-memory store. Defaults to 'true'.
     * @param args.cryptoDatabasePrefix - The database name to use for indexeddb, defaults to 'matrix-js-sdk'.
     *    Unused if useIndexedDB is 'false'.
     * @param args.storageKey - A key with which to encrypt the indexeddb store. If provided, it must be exactly
     *    32 bytes of data, and must be the same each time the client is initialised for a given device.
     *    If both this and `storagePassword` are unspecified, the store will be unencrypted.
     * @param args.storagePassword - An alternative to `storageKey`. A password which will be used to derive a key to
     *    encrypt the store with. Deriving a key from a password is (deliberately) a slow operation, so prefer
     *    to pass a `storageKey` directly where possible.
     *
     * @returns a Promise which will resolve when the crypto layer has been
     *    successfully initialised.
     */
    public async initRustCrypto(
        args: {
            useIndexedDB?: boolean;
            cryptoDatabasePrefix?: string;
            storageKey?: Uint8Array;
            storagePassword?: string;
        } = {},
    ): Promise<void> {
        if (this.cryptoBackend) {
            this.logger.warn("Attempt to re-initialise e2e encryption on MatrixClient");
            return;
        }

        const userId = this.getUserId();
        if (userId === null) {
            throw new Error(
                `Cannot enable encryption on MatrixClient with unknown userId: ` +
                    `ensure userId is passed in createClient().`,
            );
        }
        const deviceId = this.getDeviceId();
        if (deviceId === null) {
            throw new Error(
                `Cannot enable encryption on MatrixClient with unknown deviceId: ` +
                    `ensure deviceId is passed in createClient().`,
            );
        }

        // importing rust-crypto will download the webassembly, so we delay it until we know it will be
        // needed.
        this.logger.debug("Downloading Rust crypto library");
        const RustCrypto = await import("./rust-crypto/index.ts");

        const rustCrypto = await RustCrypto.initRustCrypto({
            logger: this.logger,
            http: this.http,
            userId: userId,
            deviceId: deviceId,
            secretStorage: this.secretStorage,
            cryptoCallbacks: this.cryptoCallbacks,
            storePrefix: args.useIndexedDB === false ? null : (args.cryptoDatabasePrefix ?? RUST_SDK_STORE_PREFIX),
            storeKey: args.storageKey,
            storePassphrase: args.storagePassword,

            legacyCryptoStore: this.legacyCryptoStore,
            legacyPickleKey: this.legacyPickleKey ?? "DEFAULT_KEY",
            legacyMigrationProgressListener: (progress: number, total: number): void => {
                this.emit(CryptoEvent.LegacyCryptoStoreMigrationProgress, progress, total);
            },

            enableEncryptedStateEvents: this.enableEncryptedStateEvents,
        });

        rustCrypto.setSupportedVerificationMethods(this.verificationMethods);

        this.cryptoBackend = rustCrypto;

        // attach the event listeners needed by RustCrypto
        this.on(RoomMemberEvent.Membership, rustCrypto.onRoomMembership.bind(rustCrypto));
        this.on(ClientEvent.Event, (event) => {
            rustCrypto.onLiveEventFromSync(event);
        });

        // re-emit the events emitted by the crypto impl
        this.reEmitter.reEmit(rustCrypto, [
            CryptoEvent.VerificationRequestReceived,
            CryptoEvent.UserTrustStatusChanged,
            CryptoEvent.KeyBackupStatus,
            CryptoEvent.KeyBackupSessionsRemaining,
            CryptoEvent.KeyBackupFailed,
            CryptoEvent.KeyBackupDecryptionKeyCached,
            CryptoEvent.KeysChanged,
            CryptoEvent.DevicesUpdated,
            CryptoEvent.WillUpdateDevices,
            CryptoEvent.DehydratedDeviceCreated,
            CryptoEvent.DehydratedDeviceUploaded,
            CryptoEvent.RehydrationStarted,
            CryptoEvent.RehydrationProgress,
            CryptoEvent.RehydrationCompleted,
            CryptoEvent.RehydrationError,
            CryptoEvent.DehydrationKeyCached,
            CryptoEvent.DehydratedDeviceRotationError,
        ]);
    }

    /**
     * Access the server-side secret storage API for this client.
     */
    public get secretStorage(): ServerSideSecretStorage {
        return this._secretStorage;
    }

    /**
     * Access the crypto API for this client.
     *
     * If end-to-end encryption has been enabled for this client (via {@link initRustCrypto}),
     * returns an object giving access to the crypto API. Otherwise, returns `undefined`.
     */
    public getCrypto(): CryptoApi | undefined {
        return this.cryptoBackend;
    }

    /**
     * Whether encryption is enabled for a room.
     * @param roomId - the room id to query.
     * @returns whether encryption is enabled.
     *
     * @deprecated Not correctly supported for Rust Cryptography. Use {@link CryptoApi.isEncryptionEnabledInRoom} and/or
     *    {@link Room.hasEncryptionStateEvent}.
     */
    public isRoomEncrypted(roomId: string): boolean {
        const room = this.getRoom(roomId);
        if (!room) {
            // we don't know about this room, so can't determine if it should be
            // encrypted. Let's assume not.
            return false;
        }

        // if there is an 'm.room.encryption' event in this room, it should be
        // encrypted (independently of whether we actually support encryption)
        return room.hasEncryptionStateEvent();
    }

    /**
     * Check whether the key backup private key is stored in secret storage.
     * @returns map of key name to key info the secret is
     *     encrypted with, or null if it is not present or not encrypted with a
     *     trusted key
     */
    public isKeyBackupKeyStored(): Promise<Record<string, SecretStorageKeyDescription> | null> {
        return Promise.resolve(this.secretStorage.isStored("m.megolm_backup.v1"));
    }

    private makeKeyBackupPath(roomId?: string, sessionId?: string, version?: string): IKeyBackupPath {
        let path: string;
        if (sessionId !== undefined) {
            path = utils.encodeUri("/room_keys/keys/$roomId/$sessionId", {
                $roomId: roomId!,
                $sessionId: sessionId,
            });
        } else if (roomId !== undefined) {
            path = utils.encodeUri("/room_keys/keys/$roomId", {
                $roomId: roomId,
            });
        } else {
            path = "/room_keys/keys";
        }
        const queryData = version === undefined ? undefined : { version };
        return { path, queryData };
    }

    public deleteKeysFromBackup(roomId: undefined, sessionId: undefined, version?: string): Promise<void>;
    public deleteKeysFromBackup(roomId: string, sessionId: undefined, version?: string): Promise<void>;
    public deleteKeysFromBackup(roomId: string, sessionId: string, version?: string): Promise<void>;
    public async deleteKeysFromBackup(roomId?: string, sessionId?: string, version?: string): Promise<void> {
        const path = this.makeKeyBackupPath(roomId!, sessionId!, version);
        await this.http.authedRequest(Method.Delete, path.path, path.queryData, undefined, { prefix: ClientPrefix.V3 });
    }

    /**
     * Get the config for the media repository.
     *
     * @param useAuthenticatedMedia - If true, the caller supports authenticated
     * media and wants an authentication-required URL. Note that server support
     * for authenticated media will *not* be checked - it is the caller's responsibility
     * to do so before calling this function.
     *
     * @returns Promise which resolves with an object containing the config.
     */
    public getMediaConfig(useAuthenticatedMedia: boolean = false): Promise<IMediaConfig> {
        const path = useAuthenticatedMedia ? "/media/config" : "/config";
        return this.http.authedRequest(Method.Get, path, undefined, undefined, {
            prefix: useAuthenticatedMedia ? ClientPrefix.V1 : MediaPrefix.V3,
        });
    }

    /**
     * Get the room for the given room ID.
     * This function will return a valid room for any room for which a Room event
     * has been emitted. Note in particular that other events, eg. RoomState.members
     * will be emitted for a room before this function will return the given room.
     * @param roomId - The room ID
     * @returns The Room or null if it doesn't exist or there is no data store.
     */
    public getRoom(roomId: string | undefined): Room | null {
        if (!roomId) {
            return null;
        }
        return this.store.getRoom(roomId);
    }

    /**
     * Retrieve all known rooms.
     * @returns A list of rooms, or an empty list if there is no data store.
     */
    public getRooms(): Room[] {
        return this.store.getRooms();
    }

    /**
     * Retrieve all rooms that should be displayed to the user
     * This is essentially getRooms() with some rooms filtered out, eg. old versions
     * of rooms that have been replaced or (in future) other rooms that have been
     * marked at the protocol level as not to be displayed to the user.
     *
     * @param msc3946ProcessDynamicPredecessor - if true, look for an
     *                                           m.room.predecessor state event and
     *                                           use it if found (MSC3946).
     * @returns A list of rooms, or an empty list if there is no data store.
     */
    public getVisibleRooms(msc3946ProcessDynamicPredecessor = false): Room[] {
        const allRooms = this.store.getRooms();

        const visibleRooms = new Set(allRooms);
        for (const room of visibleRooms) {
            const predecessors = this.findPredecessorRooms(room, true, msc3946ProcessDynamicPredecessor);
            for (const predecessor of predecessors) {
                visibleRooms.delete(predecessor);
            }
        }
        return Array.from(visibleRooms);
    }

    /**
     * Retrieve a user.
     * @param userId - The user ID to retrieve.
     * @returns A user or null if there is no data store or the user does
     * not exist.
     */
    public getUser(userId: string): User | null {
        return this.store.getUser(userId);
    }

    /**
     * Retrieve all known users.
     * @returns A list of users, or an empty list if there is no data store.
     */
    public getUsers(): User[] {
        return this.store.getUsers();
    }

    /**
     * Set account data event for the current user, and wait for the result to be echoed over `/sync`.
     *
     * Waiting for the remote echo ensures that a subsequent call to {@link getAccountData} will return the updated
     * value.
     *
     * If called before the client is started with {@link startClient}, logs a warning and falls back to
     * {@link setAccountDataRaw}.
     *
     * Retries the request up to 5 times in the case of an {@link ConnectionError}.
     *
     * @param eventType - The event type
     * @param content - the contents object for the event
     */
    public async setAccountData<K extends keyof AccountDataEvents>(
        eventType: K,
        content: AccountDataEvents[K] | Record<string, never>,
    ): Promise<EmptyObject> {
        // If the sync loop is not running, fall back to setAccountDataRaw.
        if (!this.clientRunning) {
            this.logger.warn(
                "Calling `setAccountData` before the client is started: `getAccountData` may return inconsistent results.",
            );
            return await retryNetworkOperation(5, () => this.setAccountDataRaw(eventType, content));
        }

        // If the account data is already correct, then we cannot expect an update over sync, and the operation
        // is, in any case, a no-op.
        //
        // NB that we rely on this operation being synchronous to avoid a race condition: there must be no `await`
        // between here and `this.addListener` below, in case we miss an update.
        const existingData = this.store.getAccountData(eventType);
        if (existingData && deepCompare(existingData.event.content, content)) return {};

        // Create a promise which will resolve when the update is received
        const updatedResolvers = Promise.withResolvers<void>();
        function accountDataListener(event: MatrixEvent): void {
            // Note that we cannot safely check that the content matches what we expected, because there is a race:
            //   * We set the new content
            //   * Another client sets alternative content
            //   * Then /sync returns, but only reflects the latest content.
            //
            // Of course there is room for debate over what we should actually do in that case -- a subsequent
            // `getAccountData` isn't going to return the expected value, but whose fault is that? Databases are hard.
            //
            // Anyway, what we *shouldn't* do is get stuck in a loop. I think the best we can do is check that the event
            // type matches.
            if (event.getType() === eventType) updatedResolvers.resolve();
        }
        this.addListener(ClientEvent.AccountData, accountDataListener);

        try {
            const result = await retryNetworkOperation(5, () => this.setAccountDataRaw(eventType, content));
            await updatedResolvers.promise;
            return result;
        } finally {
            this.removeListener(ClientEvent.AccountData, accountDataListener);
        }
    }

    /**
     * Set account data event for the current user, without waiting for the remote echo.
     *
     * @param eventType - The event type
     * @param content - the contents object for the event
     */
    public setAccountDataRaw<K extends keyof AccountDataEvents>(
        eventType: K,
        content: AccountDataEvents[K] | Record<string, never>,
    ): Promise<EmptyObject> {
        const path = utils.encodeUri("/user/$userId/account_data/$type", {
            $userId: this.credentials.userId!,
            $type: eventType,
        });

        return this.http.authedRequest(Method.Put, path, undefined, content);
    }

    /**
     * Get account data event of given type for the current user.
     * @param eventType - The event type
     * @returns The contents of the given account data event
     */
    public getAccountData<K extends keyof AccountDataEvents>(eventType: K): MatrixEvent | undefined {
        return this.store.getAccountData(eventType);
    }

    /**
     * Get account data event of given type for the current user. This variant
     * gets account data directly from the homeserver if the local store is not
     * ready, which can be useful very early in startup before the initial sync.
     * @param eventType - The event type
     * @returns Promise which resolves: The contents of the given account data event.
     * @returns Rejects: with an error response.
     */
    public async getAccountDataFromServer<K extends keyof AccountDataEvents>(
        eventType: K,
    ): Promise<AccountDataEvents[K] | null> {
        if (this.isInitialSyncComplete()) {
            const event = this.store.getAccountData(eventType);
            if (!event) {
                return null;
            }
            // The network version below returns just the content, so this branch
            // does the same to match.
            return event.getContent<AccountDataEvents[K]>();
        }
        const path = utils.encodeUri("/user/$userId/account_data/$type", {
            $userId: this.credentials.userId!,
            $type: eventType,
        });
        try {
            return await this.http.authedRequest(Method.Get, path);
        } catch (e) {
            if ((<MatrixError>e).data?.errcode === "M_NOT_FOUND") {
                return null;
            }
            throw e;
        }
    }

    public async deleteAccountData(eventType: keyof AccountDataEvents): Promise<void> {
        const msc3391DeleteAccountDataServerSupport = this.canSupport.get(Feature.AccountDataDeletion);
        // if deletion is not supported overwrite with empty content
        if (msc3391DeleteAccountDataServerSupport === ServerSupport.Unsupported) {
            await this.setAccountData(eventType, {});
            return;
        }
        const path = utils.encodeUri("/user/$userId/account_data/$type", {
            $userId: this.getSafeUserId(),
            $type: eventType,
        });
        const options =
            msc3391DeleteAccountDataServerSupport === ServerSupport.Unstable
                ? { prefix: "/_matrix/client/unstable/org.matrix.msc3391" }
                : undefined;
        return await this.http.authedRequest(Method.Delete, path, undefined, undefined, options);
    }

    /**
     * Gets the users that are ignored by this client
     * @returns The array of users that are ignored (empty if none)
     */
    public getIgnoredUsers(): string[] {
        const event = this.getAccountData(EventType.IgnoredUserList);
        if (!event?.getContent()["ignored_users"]) return [];
        return Object.keys(event.getContent()["ignored_users"]);
    }

    /**
     * Sets the users that the current user should ignore.
     * @param userIds - the user IDs to ignore
     * @returns Promise which resolves: an empty object
     * @returns Rejects: with an error response.
     */
    public setIgnoredUsers(userIds: string[]): Promise<EmptyObject> {
        const content = { ignored_users: {} as Record<string, EmptyObject> };
        userIds.forEach((u) => {
            content.ignored_users[u] = {};
        });
        return this.setAccountData(EventType.IgnoredUserList, content);
    }

    /**
     * Gets whether or not a specific user is being ignored by this client.
     * @param userId - the user ID to check
     * @returns true if the user is ignored, false otherwise
     */
    public isUserIgnored(userId: string): boolean {
        return this.getIgnoredUsers().includes(userId);
    }

    /**
     * Join a room. If you have already joined the room, this will no-op.
     * @param roomIdOrAlias - The room ID or room alias to join.
     * @param opts - Options when joining the room.
     * @returns Promise which resolves: Room object.
     * @returns Rejects: with an error response.
     */
    public async joinRoom(roomIdOrAlias: string, opts: IJoinRoomOpts = {}): Promise<Room> {
        const room = this.getRoom(roomIdOrAlias);
        const roomMember = room?.getMember(this.getSafeUserId());
        const preJoinMembership = roomMember?.membership;

        // If we were invited to the room, the ID of the user that sent the invite. Otherwise, `null`.
        const inviter =
            preJoinMembership == KnownMembership.Invite ? (roomMember?.events.member?.getSender() ?? null) : null;

        this.logger.debug(
            `joinRoom[${roomIdOrAlias}]: preJoinMembership=${preJoinMembership}, inviter=${inviter}, opts=${JSON.stringify(opts)}`,
        );
        if (preJoinMembership == KnownMembership.Join) return room!;

        let signPromise: Promise<IThirdPartySigned | void> = Promise.resolve();

        if (opts.inviteSignUrl) {
            const url = new URL(opts.inviteSignUrl);
            url.searchParams.set("mxid", this.credentials.userId!);
            signPromise = this.http.requestOtherUrl<IThirdPartySigned>(Method.Post, url);
        }

        const queryParams: QueryDict = {};
        if (opts.viaServers) {
            // server_name has been deprecated in favour of via with Matrix >1.11 (MSC4156)
            // We only use the first 3 servers, to avoid URI length issues.
            queryParams.via = queryParams.server_name = opts.viaServers.slice(0, 3);
        }

        const data: IJoinRequestBody = {};
        const signedInviteObj = await signPromise;
        if (signedInviteObj) {
            data.third_party_signed = signedInviteObj;
        }

        const path = utils.encodeUri("/join/$roomid", { $roomid: roomIdOrAlias });
        const res = await this.http.authedRequest<{ room_id: string }>(Method.Post, path, queryParams, data);

        const roomId = res.room_id;
        if (opts.acceptSharedHistory && inviter && this.cryptoBackend) {
            // Try to accept the room key bundle specified in a `m.room_key_bundle` to-device message we (might have) already received.
            const bundleDownloaded = await this.cryptoBackend.maybeAcceptKeyBundle(roomId, inviter);
            // If this fails, i.e. we haven't received this message yet, we need to wait until the to-device message arrives.
            if (!bundleDownloaded) {
                this.cryptoBackend.markRoomAsPendingKeyBundle(roomId, inviter);
            }
        }

        // In case we were originally given an alias, check the room cache again
        // with the resolved ID - this method is supposed to no-op if we already
        // were in the room, after all.
        const resolvedRoom = this.getRoom(roomId);
        if (resolvedRoom?.hasMembershipState(this.credentials.userId!, KnownMembership.Join)) return resolvedRoom;

        const syncApi = new SyncApi(this, this.clientOpts, this.buildSyncApiOptions());
        return syncApi.createRoom(roomId);
    }

    /**
     * Knock a room. If you have already knocked the room, this will no-op.
     * @param roomIdOrAlias - The room ID or room alias to knock.
     * @param opts - Options when knocking the room.
     * @returns Promise which resolves: `{room_id: {string}}`
     * @returns Rejects: with an error response.
     */
    public knockRoom(roomIdOrAlias: string, opts: KnockRoomOpts = {}): Promise<{ room_id: string }> {
        const room = this.getRoom(roomIdOrAlias);
        if (room?.hasMembershipState(this.credentials.userId!, KnownMembership.Knock)) {
            return Promise.resolve({ room_id: room.roomId });
        }

        const path = utils.encodeUri("/knock/$roomIdOrAlias", { $roomIdOrAlias: roomIdOrAlias });

        const queryParams: QueryDict = {};
        if (opts.viaServers) {
            // We only use the first 3 servers, to avoid URI length issues.
            const viaServers = Array.isArray(opts.viaServers) ? opts.viaServers.slice(0, 3) : [opts.viaServers];
            // server_name has been deprecated in favour of via with Matrix >1.11 (MSC4156)
            queryParams.server_name = viaServers;
            queryParams.via = viaServers;
        }

        const body: Record<string, string> = {};
        if (opts.reason) {
            body.reason = opts.reason;
        }

        return this.http.authedRequest(Method.Post, path, queryParams, body);
    }

    /**
     * Resend an event. Will also retry any to-device messages waiting to be sent.
     * @param event - The event to resend.
     * @param room - Optional. The room the event is in. Will update the
     * timeline entry if provided.
     * @returns Promise which resolves: to an ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public resendEvent(event: MatrixEvent, room: Room): Promise<ISendEventResponse> {
        // also kick the to-device queue to retry
        this.toDeviceMessageQueue.sendQueue();

        this.updatePendingEventStatus(room, event, EventStatus.SENDING);
        return this.encryptAndSendEvent(room, event);
    }

    /**
     * Cancel a queued or unsent event.
     *
     * @param event -   Event to cancel
     * @throws Error if the event is not in QUEUED, NOT_SENT or ENCRYPTING state
     */
    public cancelPendingEvent(event: MatrixEvent): void {
        if (![EventStatus.QUEUED, EventStatus.NOT_SENT, EventStatus.ENCRYPTING].includes(event.status!)) {
            throw new Error("cannot cancel an event with status " + event.status);
        }

        // If the event is currently being encrypted then remove it from the pending list, to indicate that it should
        // not be sent.
        if (event.status === EventStatus.ENCRYPTING) {
            this.eventsBeingEncrypted.delete(event.getId()!);
        } else if (this.scheduler && event.status === EventStatus.QUEUED) {
            // tell the scheduler to forget about it, if it's queued
            this.scheduler.removeEventFromQueue(event);
        }

        // then tell the room about the change of state, which will remove it
        // from the room's list of pending events.
        const room = this.getRoom(event.getRoomId());
        this.updatePendingEventStatus(room, event, EventStatus.CANCELLED);
    }

    /**
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public setRoomName(roomId: string, name: string): Promise<ISendEventResponse> {
        return this.sendStateEvent(roomId, EventType.RoomName, { name: name });
    }

    /**
     * @param roomId - The room to update the topic in.
     * @param topic - The plaintext topic. May be empty to remove the topic.
     * @param htmlTopic - Optional.
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public setRoomTopic(roomId: string, topic?: string, htmlTopic?: string): Promise<ISendEventResponse> {
        const content = ContentHelpers.makeTopicContent(topic, htmlTopic);
        return this.sendStateEvent(roomId, EventType.RoomTopic, content);
    }

    /**
     * @returns Promise which resolves: to an object keyed by tagId with objects containing a numeric order field.
     * @returns Rejects: with an error response.
     */
    public getRoomTags(roomId: string): Promise<ITagsResponse> {
        const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags", {
            $userId: this.credentials.userId!,
            $roomId: roomId,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * @param tagName - name of room tag to be set
     * @param metadata - associated with that tag to be stored
     * @returns Promise which resolves: to an empty object
     * @returns Rejects: with an error response.
     */
    public setRoomTag(roomId: string, tagName: string, metadata: ITagMetadata = {}): Promise<EmptyObject> {
        const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
            $userId: this.credentials.userId!,
            $roomId: roomId,
            $tag: tagName,
        });
        return this.http.authedRequest(Method.Put, path, undefined, metadata);
    }

    /**
     * @param tagName - name of room tag to be removed
     * @returns Promise which resolves: to an empty object
     * @returns Rejects: with an error response.
     */
    public deleteRoomTag(roomId: string, tagName: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
            $userId: this.credentials.userId!,
            $roomId: roomId,
            $tag: tagName,
        });
        return this.http.authedRequest(Method.Delete, path);
    }

    /**
     * @param eventType - event type to be set
     * @param content - event content
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public setRoomAccountData(roomId: string, eventType: string, content: Record<string, any>): Promise<EmptyObject> {
        const path = utils.encodeUri("/user/$userId/rooms/$roomId/account_data/$type", {
            $userId: this.credentials.userId!,
            $roomId: roomId,
            $type: eventType,
        });
        return this.http.authedRequest(Method.Put, path, undefined, content);
    }

    /**
     * Set a power level to one or multiple users.
     * Will apply changes atop of current power level event from local state if running & synced, falling back
     * to fetching latest from the `/state/` API.
     * @param roomId - the room to update power levels in
     * @param userId - the ID of the user or users to update power levels of
     * @param powerLevel - the numeric power level to update given users to
     * @returns Promise which resolves: to an ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public async setPowerLevel(
        roomId: string,
        userId: string | string[],
        powerLevel: number | undefined,
    ): Promise<ISendEventResponse> {
        let content: IPowerLevelsContent | undefined;
        if (this.clientRunning && this.isInitialSyncComplete()) {
            content = this.getRoom(roomId)?.currentState?.getStateEvents(EventType.RoomPowerLevels, "")?.getContent();
        }
        if (!content) {
            try {
                content = await this.getStateEvent(roomId, EventType.RoomPowerLevels, "");
            } catch (e) {
                // It is possible for a Matrix room to not have a power levels event
                if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
                    content = {};
                } else {
                    throw e;
                }
            }
        }

        // take a copy of the content to ensure we don't corrupt
        // existing client state with a failed power level change
        content = utils.deepCopy(content);

        if (!content?.users) {
            content.users = {};
        }
        const users = Array.isArray(userId) ? userId : [userId];
        for (const user of users) {
            if (powerLevel == null) {
                delete content.users[user];
            } else {
                content.users[user] = powerLevel;
            }
        }

        return this.sendStateEvent(roomId, EventType.RoomPowerLevels, content, "");
    }

    /**
     * Create an m.beacon_info event
     * @returns
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async unstable_createLiveBeacon(
        roomId: Room["roomId"],
        beaconInfoContent: MBeaconInfoEventContent,
    ): Promise<ISendEventResponse> {
        return this.unstable_setLiveBeacon(roomId, beaconInfoContent);
    }

    /**
     * Upsert a live beacon event
     * using a specific m.beacon_info.* event variable type
     * @param roomId - string
     * @returns
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async unstable_setLiveBeacon(
        roomId: string,
        beaconInfoContent: MBeaconInfoEventContent,
    ): Promise<ISendEventResponse> {
        return this.sendStateEvent(roomId, M_BEACON_INFO.name, beaconInfoContent, this.getUserId()!);
    }

    public sendEvent<K extends keyof TimelineEvents>(
        roomId: string,
        eventType: K,
        content: TimelineEvents[K],
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendEvent<K extends keyof TimelineEvents>(
        roomId: string,
        threadId: string | null,
        eventType: K,
        content: TimelineEvents[K],
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendEvent(
        roomId: string,
        threadIdOrEventType: string | null,
        eventTypeOrContent: string | IContent,
        contentOrTxnId?: IContent | string,
        txnIdOrVoid?: string,
    ): Promise<ISendEventResponse> {
        let threadId: string | null;
        let eventType: string;
        let content: IContent;
        let txnId: string | undefined;
        if (!threadIdOrEventType?.startsWith(EVENT_ID_PREFIX) && threadIdOrEventType !== null) {
            txnId = contentOrTxnId as string;
            content = eventTypeOrContent as IContent;
            eventType = threadIdOrEventType;
            threadId = null;
        } else {
            txnId = txnIdOrVoid;
            content = contentOrTxnId as IContent;
            eventType = eventTypeOrContent as string;
            threadId = threadIdOrEventType;
        }

        this.addThreadRelationIfNeeded(content, threadId, roomId);
        return this.sendCompleteEvent({ roomId, threadId, eventObject: { type: eventType, content }, txnId });
    }

    /**
     * If we expect that an event is part of a thread but is missing the relation
     * we need to add it manually, as well as the reply fallback
     */
    private addThreadRelationIfNeeded(content: IContent, threadId: string | null, roomId: string): void {
        if (threadId && !content["m.relates_to"]?.rel_type) {
            const isReply = !!content["m.relates_to"]?.["m.in_reply_to"];
            content["m.relates_to"] = {
                ...content["m.relates_to"],
                rel_type: THREAD_RELATION_TYPE.name,
                event_id: threadId,
                // Set is_falling_back to true unless this is actually intended to be a reply
                is_falling_back: !isReply,
            };
            const thread = this.getRoom(roomId)?.getThread(threadId);
            if (thread && !isReply) {
                content["m.relates_to"]["m.in_reply_to"] = {
                    event_id:
                        thread
                            .lastReply((ev: MatrixEvent) => {
                                return ev.isRelation(THREAD_RELATION_TYPE.name) && !ev.status;
                            })
                            ?.getId() ?? threadId,
                };
            }
        }
    }

    /**
     * @param eventObject - An object with the partial structure of an event, to which event_id, user_id, room_id and origin_server_ts will be added.
     * @param txnId - Optional.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    private sendCompleteEvent(params: {
        roomId: string;
        threadId: string | null;
        eventObject: Partial<IEvent>;
        queryDict?: QueryDict;
        txnId?: string;
    }): Promise<ISendEventResponse>;
    /**
     * Sends a delayed event (MSC4140).
     * @param eventObject - An object with the partial structure of an event, to which event_id, user_id, room_id and origin_server_ts will be added.
     * @param delayOpts - Properties of the delay for this event.
     * @param txnId - Optional.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    private sendCompleteEvent(params: {
        roomId: string;
        threadId: string | null;
        eventObject: Partial<IEvent>;
        delayOpts: SendDelayedEventRequestOpts;
        queryDict?: QueryDict;
        txnId?: string;
    }): Promise<SendDelayedEventResponse>;
    private sendCompleteEvent({
        roomId,
        threadId,
        eventObject,
        delayOpts,
        queryDict,
        txnId,
    }: {
        roomId: string;
        threadId: string | null;
        eventObject: Partial<IEvent>;
        delayOpts?: SendDelayedEventRequestOpts;
        queryDict?: QueryDict;
        txnId?: string;
    }): Promise<SendDelayedEventResponse | ISendEventResponse> {
        if (!txnId) {
            txnId = this.makeTxnId();
        }

        // We always construct a MatrixEvent when sending because the store and scheduler use them.
        // We'll extract the params back out if it turns out the client has no scheduler or store.
        const localEvent = new MatrixEvent(
            Object.assign(eventObject, {
                event_id: "~" + roomId + ":" + txnId,
                user_id: this.credentials.userId,
                sender: this.credentials.userId,
                room_id: roomId,
                origin_server_ts: new Date().getTime(),
            }),
        );

        const room = this.getRoom(roomId);
        const thread = threadId ? room?.getThread(threadId) : undefined;
        if (thread) {
            localEvent.setThread(thread);
        }

        if (!delayOpts) {
            // set up re-emitter for this new event - this is normally the job of EventMapper but we don't use it here
            this.reEmitter.reEmit(localEvent, [MatrixEventEvent.Replaced, MatrixEventEvent.VisibilityChange]);
            room?.reEmitter.reEmit(localEvent, [MatrixEventEvent.BeforeRedaction]);
        }

        // if this is a relation or redaction of an event
        // that hasn't been sent yet (e.g. with a local id starting with a ~)
        // then listen for the remote echo of that event so that by the time
        // this event does get sent, we have the correct event_id
        const targetId = localEvent.getAssociatedId();
        if (targetId?.startsWith("~")) {
            const target = room?.getPendingEvents().find((e) => e.getId() === targetId);
            target?.once(MatrixEventEvent.LocalEventIdReplaced, () => {
                localEvent.updateAssociatedId(target.getId()!);
            });
        }

        const type = localEvent.getType();
        this.logger.debug(
            `sendEvent of type ${type} in ${roomId} with txnId ${txnId}${delayOpts ? " (delayed event)" : ""}${queryDict ? " query params: " + JSON.stringify(queryDict) : ""}`,
        );

        localEvent.setTxnId(txnId);
        localEvent.setStatus(EventStatus.SENDING);

        // TODO: separate store for delayed events?
        if (!delayOpts) {
            // add this event immediately to the local store as 'sending'.
            room?.addPendingEvent(localEvent, txnId);

            // addPendingEvent can change the state to NOT_SENT if it believes
            // that there's other events that have failed. We won't bother to
            // try sending the event if the state has changed as such.
            if (localEvent.status === EventStatus.NOT_SENT) {
                return Promise.reject(new Error("Event blocked by other events not yet sent"));
            }

            return this.encryptAndSendEvent(room, localEvent, queryDict);
        } else {
            return this.encryptAndSendEvent(room, localEvent, delayOpts, queryDict);
        }
    }

    /**
     * encrypts the event if necessary; adds the event to the queue, or sends it; marks the event as sent/unsent
     * @returns returns a promise which resolves with the result of the send request
     */
    protected async encryptAndSendEvent(
        room: Room | null,
        event: MatrixEvent,
        queryDict?: QueryDict,
    ): Promise<ISendEventResponse>;
    /**
     * Simply sends a delayed event without encrypting it.
     * TODO: Allow encrypted delayed events, and encrypt them properly
     * @param delayOpts - Properties of the delay for this event.
     * @returns returns a promise which resolves with the result of the delayed send request
     */
    protected async encryptAndSendEvent(
        room: Room | null,
        event: MatrixEvent,
        delayOpts: SendDelayedEventRequestOpts,
        queryDict?: QueryDict,
    ): Promise<ISendEventResponse>;
    protected async encryptAndSendEvent(
        room: Room | null,
        event: MatrixEvent,
        delayOptsOrQuery?: SendDelayedEventRequestOpts | QueryDict,
        queryDict?: QueryDict,
    ): Promise<ISendEventResponse | SendDelayedEventResponse> {
        let queryOpts = queryDict;
        if (delayOptsOrQuery && isSendDelayedEventRequestOpts(delayOptsOrQuery)) {
            return this.sendEventHttpRequest(event, delayOptsOrQuery, queryOpts);
        } else if (!queryOpts) {
            queryOpts = delayOptsOrQuery;
        }
        try {
            let cancelled: boolean;
            this.eventsBeingEncrypted.add(event.getId()!);
            try {
                await this.encryptEventIfNeeded(event, room ?? undefined);
            } finally {
                cancelled = !this.eventsBeingEncrypted.delete(event.getId()!);
            }

            if (cancelled) {
                // cancelled via MatrixClient::cancelPendingEvent
                return {} as ISendEventResponse;
            }

            // encryptEventIfNeeded may have updated the status from SENDING to ENCRYPTING. If so, we need
            // to put it back.
            if (event.status === EventStatus.ENCRYPTING) {
                this.updatePendingEventStatus(room, event, EventStatus.SENDING);
            }

            let promise: Promise<ISendEventResponse> | null = null;
            if (this.scheduler) {
                // if this returns a promise then the scheduler has control now and will
                // resolve/reject when it is done. Internally, the scheduler will invoke
                // processFn which is set to this._sendEventHttpRequest so the same code
                // path is executed regardless.
                promise = this.scheduler.queueEvent(event);
                if (promise && this.scheduler.getQueueForEvent(event)!.length > 1) {
                    // event is processed FIFO so if the length is 2 or more we know
                    // this event is stuck behind an earlier event.
                    this.updatePendingEventStatus(room, event, EventStatus.QUEUED);
                }
            }

            if (!promise) {
                promise = this.sendEventHttpRequest(event, queryOpts);
                if (room) {
                    promise = promise.then((res) => {
                        room.updatePendingEvent(event, EventStatus.SENT, res["event_id"]);
                        return res;
                    });
                }
            }

            return await promise;
        } catch (err) {
            this.logger.error("Error sending event", err);
            try {
                // set the error on the event before we update the status:
                // updating the status emits the event, so the state should be
                // consistent at that point.
                event.error = <MatrixError>err;
                this.updatePendingEventStatus(room, event, EventStatus.NOT_SENT);
            } catch (e) {
                this.logger.error("Exception in error handler!", e);
            }
            if (err instanceof MatrixError) {
                err.event = event;
            }
            throw err;
        }
    }

    private async encryptEventIfNeeded(event: MatrixEvent, room?: Room): Promise<void> {
        // If the room is unknown, we cannot encrypt for it
        if (!room) return;

        if (!(await this.shouldEncryptEventForRoom(event, room))) return;

        if (!this.cryptoBackend && this.usingExternalCrypto) {
            // The client has opted to allow sending messages to encrypted
            // rooms even if the room is encrypted, and we haven't set up
            // crypto. This is useful for users of matrix-org/pantalaimon
            return;
        }

        if (!this.cryptoBackend) {
            throw new Error("This room is configured to use encryption, but your client does not support encryption.");
        }

        this.updatePendingEventStatus(room, event, EventStatus.ENCRYPTING);
        await this.cryptoBackend.encryptEvent(event, room);
    }

    /**
     * Determine whether a given event should be encrypted when we send it to the given room.
     *
     * This takes into account event type and room configuration.
     */
    private async shouldEncryptEventForRoom(event: MatrixEvent, room: Room): Promise<boolean> {
        if (event.isEncrypted()) {
            // this event has already been encrypted; this happens if the
            // encryption step succeeded, but the send step failed on the first
            // attempt.
            return false;
        }

        if (event.getType() === EventType.Reaction) {
            // For reactions, there is a very little gained by encrypting the entire
            // event, as relation data is already kept in the clear. Event
            // encryption for a reaction effectively only obscures the event type,
            // but the purpose is still obvious from the relation data, so nothing
            // is really gained. It also causes quite a few problems, such as:
            //   * triggers notifications via default push rules
            //   * prevents server-side bundling for reactions
            // The reaction key / content / emoji value does warrant encrypting, but
            // this will be handled separately by encrypting just this value.
            // See https://github.com/matrix-org/matrix-doc/pull/1849#pullrequestreview-248763642
            return false;
        }

        if (event.isRedaction()) {
            // Redactions do not support encryption in the spec at this time.
            // Whilst it mostly worked in some clients, it wasn't compliant.
            return false;
        }

        // If the room has an m.room.encryption event, we should encrypt.
        if (room.hasEncryptionStateEvent()) return true;

        // If we have a crypto impl, and *it* thinks we should encrypt, then we should.
        if (await this.cryptoBackend?.isEncryptionEnabledInRoom(room.roomId)) return true;

        // Otherwise, no need to encrypt.
        return false;
    }

    /**
     * Returns the eventType that should be used taking encryption into account
     * for a given eventType.
     * @param roomId - the room for the events `eventType` relates to
     * @param eventType - the event type
     * @returns the event type taking encryption into account
     */
    private getEncryptedIfNeededEventType(
        roomId: string,
        eventType?: EventType | string | null,
    ): EventType | string | null | undefined {
        if (eventType === EventType.Reaction) return eventType;
        return this.getRoom(roomId)?.hasEncryptionStateEvent() ? EventType.RoomMessageEncrypted : eventType;
    }

    protected updatePendingEventStatus(room: Room | null, event: MatrixEvent, newStatus: EventStatus): void {
        if (room) {
            room.updatePendingEvent(event, newStatus);
        } else {
            event.setStatus(newStatus);
        }
    }

    private sendEventHttpRequest(event: MatrixEvent, queryDict?: QueryDict): Promise<ISendEventResponse>;
    private sendEventHttpRequest(
        event: MatrixEvent,
        delayOpts: SendDelayedEventRequestOpts,
        queryDict?: QueryDict,
    ): Promise<SendDelayedEventResponse>;
    private sendEventHttpRequest(
        event: MatrixEvent,
        queryOrDelayOpts?: SendDelayedEventRequestOpts | QueryDict,
        queryDict?: QueryDict,
    ): Promise<ISendEventResponse | SendDelayedEventResponse> {
        let txnId = event.getTxnId();
        if (!txnId) {
            txnId = this.makeTxnId();
            event.setTxnId(txnId);
        }

        const pathParams = {
            $roomId: event.getRoomId()!,
            $eventType: event.getWireType(),
            $stateKey: event.getStateKey()!,
            $txnId: txnId,
        };

        let path: string;

        if (event.isState()) {
            let pathTemplate = "/rooms/$roomId/state/$eventType";
            if (event.getStateKey() && event.getStateKey()!.length > 0) {
                pathTemplate = "/rooms/$roomId/state/$eventType/$stateKey";
            }
            path = utils.encodeUri(pathTemplate, pathParams);
        } else if (event.isRedaction() && event.event.redacts) {
            const pathTemplate = `/rooms/$roomId/redact/$redactsEventId/$txnId`;
            path = utils.encodeUri(pathTemplate, {
                $redactsEventId: event.event.redacts,
                ...pathParams,
            });
        } else {
            path = utils.encodeUri("/rooms/$roomId/send/$eventType/$txnId", pathParams);
        }

        const delayOpts =
            queryOrDelayOpts && isSendDelayedEventRequestOpts(queryOrDelayOpts) ? queryOrDelayOpts : undefined;
        const queryOpts = !delayOpts ? queryOrDelayOpts : queryDict;
        const content = event.getWireContent();
        if (delayOpts) {
            return this.http.authedRequest<SendDelayedEventResponse>(
                Method.Put,
                path,
                { ...getUnstableDelayQueryOpts(delayOpts), ...queryOpts },
                content,
            );
        } else {
            return this.http.authedRequest<ISendEventResponse>(Method.Put, path, queryOpts, content).then((res) => {
                this.logger.debug(`Event sent to ${event.getRoomId()} with event id ${res.event_id}`);
                return res;
            });
        }
    }

    /**
     * @param txnId -  transaction id. One will be made up if not supplied.
     * @param opts - Redact options
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     * @throws Error if called with `with_rel_types` (MSC3912) but the server does not support it.
     *         Callers should check whether the server supports MSC3912 via `MatrixClient.canSupport`.
     */
    public redactEvent(
        roomId: string,
        eventId: string,
        txnId?: string | undefined,
        opts?: IRedactOpts,
    ): Promise<ISendEventResponse>;
    public redactEvent(
        roomId: string,
        threadId: string | null,
        eventId: string,
        txnId?: string | undefined,
        opts?: IRedactOpts,
    ): Promise<ISendEventResponse>;
    public redactEvent(
        roomId: string,
        threadId: string | null,
        eventId?: string,
        txnId?: string | IRedactOpts,
        opts?: IRedactOpts,
    ): Promise<ISendEventResponse> {
        if (!eventId?.startsWith(EVENT_ID_PREFIX)) {
            opts = txnId as IRedactOpts;
            txnId = eventId;
            eventId = threadId!;
            threadId = null;
        }
        const reason = opts?.reason;
        const content: IContent = { reason };

        if (opts?.with_rel_types !== undefined) {
            if (this.canSupport.get(Feature.RelationBasedRedactions) === ServerSupport.Unsupported) {
                throw new Error(
                    "Server does not support relation based redactions " +
                        `roomId ${roomId} eventId ${eventId} txnId: ${txnId as string} threadId ${threadId}`,
                );
            }

            const withRelTypesPropName =
                this.canSupport.get(Feature.RelationBasedRedactions) === ServerSupport.Stable
                    ? MSC3912_RELATION_BASED_REDACTIONS_PROP.stable!
                    : MSC3912_RELATION_BASED_REDACTIONS_PROP.unstable!;

            content[withRelTypesPropName] = opts.with_rel_types;
        }

        return this.sendCompleteEvent({
            roomId,
            threadId,
            eventObject: {
                type: EventType.RoomRedaction,
                content,
                redacts: eventId,
            },
            txnId: txnId as string,
        });
    }

    /**
     * @param txnId - Optional.
     * @returns Promise which resolves: to an ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendMessage(roomId: string, content: RoomMessageEventContent, txnId?: string): Promise<ISendEventResponse>;
    public sendMessage(
        roomId: string,
        threadId: string | null,
        content: RoomMessageEventContent,
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendMessage(
        roomId: string,
        threadId: string | null | RoomMessageEventContent,
        content?: RoomMessageEventContent | string,
        txnId?: string,
    ): Promise<ISendEventResponse> {
        if (typeof threadId !== "string" && threadId !== null) {
            txnId = content as string;
            content = threadId as RoomMessageEventContent;
            threadId = null;
        }

        const eventType = EventType.RoomMessage;
        const sendContent = content as RoomMessageEventContent;

        return this.sendEvent(roomId, threadId as string | null, eventType, sendContent, txnId);
    }

    /**
     * @param txnId - Optional.
     * @returns
     * @returns Rejects: with an error response.
     */
    public sendTextMessage(roomId: string, body: string, txnId?: string): Promise<ISendEventResponse>;
    public sendTextMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendTextMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            txnId = body;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeTextMessage(body);
        return this.sendMessage(roomId, threadId, content, txnId);
    }

    /**
     * @param txnId - Optional.
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendNotice(roomId: string, body: string, txnId?: string): Promise<ISendEventResponse>;
    public sendNotice(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendNotice(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            txnId = body;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeNotice(body);
        return this.sendMessage(roomId, threadId, content, txnId);
    }

    /**
     * @param txnId - Optional.
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendEmoteMessage(roomId: string, body: string, txnId?: string): Promise<ISendEventResponse>;
    public sendEmoteMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse>;
    public sendEmoteMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        txnId?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            txnId = body;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeEmoteMessage(body);
        return this.sendMessage(roomId, threadId, content, txnId);
    }

    /**
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendImageMessage(roomId: string, url: string, info?: ImageInfo, text?: string): Promise<ISendEventResponse>;
    public sendImageMessage(
        roomId: string,
        threadId: string | null,
        url: string,
        info?: ImageInfo,
        text?: string,
    ): Promise<ISendEventResponse>;
    public sendImageMessage(
        roomId: string,
        threadId: string | null,
        url?: string | ImageInfo,
        info?: ImageInfo | string,
        text = "Image",
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            text = (info as string) || "Image";
            info = url as ImageInfo;
            url = threadId as string;
            threadId = null;
        }
        const content = {
            msgtype: MsgType.Image,
            url: url as string,
            info: info as ImageInfo,
            body: text,
        } satisfies RoomMessageEventContent;
        return this.sendMessage(roomId, threadId, content);
    }

    /**
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendStickerMessage(
        roomId: string,
        url: string,
        info?: ImageInfo,
        text?: string,
    ): Promise<ISendEventResponse>;
    public sendStickerMessage(
        roomId: string,
        threadId: string | null,
        url: string,
        info?: ImageInfo,
        text?: string,
    ): Promise<ISendEventResponse>;
    public sendStickerMessage(
        roomId: string,
        threadId: string | null,
        url?: string | ImageInfo,
        info?: ImageInfo | string,
        text = "Sticker",
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            text = (info as string) || "Sticker";
            info = url as ImageInfo;
            url = threadId as string;
            threadId = null;
        }
        const content = {
            url: url as string,
            info: info as ImageInfo,
            body: text,
        } satisfies StickerEventContent;

        return this.sendEvent(roomId, threadId, EventType.Sticker, content);
    }

    /**
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendHtmlMessage(roomId: string, body: string, htmlBody: string): Promise<ISendEventResponse>;
    public sendHtmlMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody: string,
    ): Promise<ISendEventResponse>;
    public sendHtmlMessage(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            htmlBody = body as string;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeHtmlMessage(body, htmlBody!);
        return this.sendMessage(roomId, threadId, content);
    }

    /**
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendHtmlNotice(roomId: string, body: string, htmlBody: string): Promise<ISendEventResponse>;
    public sendHtmlNotice(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody: string,
    ): Promise<ISendEventResponse>;
    public sendHtmlNotice(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            htmlBody = body as string;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeHtmlNotice(body, htmlBody!);
        return this.sendMessage(roomId, threadId, content);
    }

    /**
     * @returns Promise which resolves: to a ISendEventResponse object
     * @returns Rejects: with an error response.
     */
    public sendHtmlEmote(roomId: string, body: string, htmlBody: string): Promise<ISendEventResponse>;
    public sendHtmlEmote(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody: string,
    ): Promise<ISendEventResponse>;
    public sendHtmlEmote(
        roomId: string,
        threadId: string | null,
        body: string,
        htmlBody?: string,
    ): Promise<ISendEventResponse> {
        if (!threadId?.startsWith(EVENT_ID_PREFIX) && threadId !== null) {
            htmlBody = body as string;
            body = threadId;
            threadId = null;
        }
        const content = ContentHelpers.makeHtmlEmote(body, htmlBody!);
        return this.sendMessage(roomId, threadId, content);
    }

    /**
     * Send a delayed timeline event.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     */
    // eslint-disable-next-line
    public async _unstable_sendDelayedEvent<K extends keyof TimelineEvents>(
        roomId: string,
        delayOpts: SendDelayedEventRequestOpts,
        threadId: string | null,
        eventType: K,
        content: TimelineEvents[K],
        txnId?: string,
    ): Promise<SendDelayedEventResponse> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "sendDelayedEvent",
            );
        }

        this.addThreadRelationIfNeeded(content, threadId, roomId);
        return this.sendCompleteEvent({
            roomId,
            threadId,
            eventObject: { type: eventType, content },
            delayOpts,
            txnId,
        });
    }

    /**
     * Send a delayed sticky timeline event.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) and
     *   [MSC4354](https://github.com/matrix-org/matrix-spec-proposals/pull/4354) for more details.
     */
    // eslint-disable-next-line
    public async _unstable_sendStickyDelayedEvent<K extends keyof TimelineEvents>(
        roomId: string,
        stickDuration: number,
        delayOpts: SendDelayedEventRequestOpts,
        threadId: string | null,
        eventType: K,
        content: TimelineEvents[K] & { msc4354_sticky_key?: string },
        txnId?: string,
    ): Promise<SendDelayedEventResponse> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "getDelayedEvents",
            );
        }
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4354_STICKY_EVENTS))) {
            throw new UnsupportedStickyEventsEndpointError(
                "Server does not support the sticky events",
                "sendStickyEvent",
            );
        }

        this.addThreadRelationIfNeeded(content, threadId, roomId);
        return this.sendCompleteEvent({
            roomId,
            threadId,
            eventObject: { type: eventType, content },
            queryDict: { "org.matrix.msc4354.sticky_duration_ms": stickDuration },
            delayOpts,
            txnId,
        });
    }

    /**
     * Send a delayed state event.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     */
    // eslint-disable-next-line
    public async _unstable_sendDelayedStateEvent<K extends keyof StateEvents>(
        roomId: string,
        delayOpts: SendDelayedEventRequestOpts,
        eventType: K,
        content: StateEvents[K],
        stateKey = "",
        opts: IRequestOpts = {},
    ): Promise<SendDelayedEventResponse> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "sendDelayedStateEvent",
            );
        }

        const pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey,
        };
        let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this.http.authedRequest(Method.Put, path, getUnstableDelayQueryOpts(delayOpts), content as Body, opts);
    }

    /**
     * Send a sticky timeline event.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4354](https://github.com/matrix-org/matrix-spec-proposals/pull/4354) for more details.
     */
    // eslint-disable-next-line
    public async _unstable_sendStickyEvent<K extends keyof TimelineEvents>(
        roomId: string,
        stickDuration: number,
        threadId: string | null,
        eventType: K,
        content: TimelineEvents[K] & { msc4354_sticky_key?: string },
        txnId?: string,
    ): Promise<ISendEventResponse> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4354_STICKY_EVENTS))) {
            throw new UnsupportedStickyEventsEndpointError(
                "Server does not support the sticky events",
                "sendStickyEvent",
            );
        }

        this.addThreadRelationIfNeeded(content, threadId, roomId);
        return this.sendCompleteEvent({
            roomId,
            threadId,
            eventObject: { type: eventType, content },
            queryDict: { "org.matrix.msc4354.sticky_duration_ms": stickDuration },
            txnId,
        });
    }

    /**
     * Get information about delayed events owned by the requesting user.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     */
    // eslint-disable-next-line
    public async _unstable_getDelayedEvents(
        status?: "scheduled" | "finalised",
        delayId?: string | string[],
        fromToken?: string,
    ): Promise<DelayedEventInfo> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "getDelayedEvents",
            );
        }

        const queryDict = {
            from: fromToken,
            status,
            delay_id: delayId,
        };
        return await this.http.authedRequest(Method.Get, "/delayed_events", queryDict, undefined, {
            prefix: `${ClientPrefix.Unstable}/${UNSTABLE_MSC4140_DELAYED_EVENTS}`,
        });
    }

    /**
     * Manage a delayed event associated with the given delay_id.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     *
     * @deprecated Instead use one of:
     * - {@link _unstable_cancelScheduledDelayedEvent}
     * - {@link _unstable_restartScheduledDelayedEvent}
     * - {@link _unstable_sendScheduledDelayedEvent}
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_updateDelayedEvent(
        delayId: string,
        action: UpdateDelayedEventAction,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "updateDelayedEvent",
            );
        }
        return await this.updateScheduledDelayedEventWithActionInBody(delayId, action, requestOptions);
    }

    /**
     * Cancel the scheduled delivery of the delayed event matching the provided delayId.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     *
     * @throws A M_NOT_FOUND error if no matching delayed event could be found.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_cancelScheduledDelayedEvent(
        delayId: string,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        return await this.updateScheduledDelayedEvent(delayId, UpdateDelayedEventAction.Cancel, requestOptions);
    }

    /**
     * Restart the scheduled delivery of the delayed event matching the given delayId.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     *
     * @throws A M_NOT_FOUND error if no matching delayed event could be found.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_restartScheduledDelayedEvent(
        delayId: string,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        return await this.updateScheduledDelayedEvent(delayId, UpdateDelayedEventAction.Restart, requestOptions);
    }

    /**
     * Immediately send the delayed event matching the given delayId,
     * instead of waiting for its scheduled delivery.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC4140](https://github.com/matrix-org/matrix-spec-proposals/pull/4140) for more details.
     *
     * @throws A M_NOT_FOUND error if no matching delayed event could be found.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_sendScheduledDelayedEvent(
        delayId: string,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        return await this.updateScheduledDelayedEvent(delayId, UpdateDelayedEventAction.Send, requestOptions);
    }

    private async updateScheduledDelayedEvent(
        delayId: string,
        action: UpdateDelayedEventAction,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                `${action}ScheduledDelayedEvent`,
            );
        }

        try {
            const path = utils.encodeUri("/delayed_events/$delayId/$action", {
                $delayId: delayId,
                $action: action,
            });
            return await this.http.request(Method.Post, path, undefined, undefined, {
                ...requestOptions,
                prefix: `${ClientPrefix.Unstable}/${UNSTABLE_MSC4140_DELAYED_EVENTS}`,
            });
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_UNRECOGNIZED") {
                // For backwards compatibility with an older version of this endpoint
                // which put the update action in the request body instead of the path
                return await this.updateScheduledDelayedEventWithActionInBody(delayId, action, requestOptions);
            } else {
                throw e;
            }
        }
    }

    /**
     * @deprecated Present for backwards compatibility with an older version of MSC4140
     * which had a single, authenticated endpoint for updating a delayed event, instead
     * of one unauthenticated endpoint per update action.
     */
    private async updateScheduledDelayedEventWithActionInBody(
        delayId: string,
        action: UpdateDelayedEventAction,
        requestOptions: IRequestOpts = {},
    ): Promise<EmptyObject> {
        const path = utils.encodeUri("/delayed_events/$delayId", {
            $delayId: delayId,
        });
        const data = {
            action,
        };
        try {
            return await this.http.request(Method.Post, path, undefined, data, {
                ...requestOptions,
                prefix: `${ClientPrefix.Unstable}/${UNSTABLE_MSC4140_DELAYED_EVENTS}`,
            });
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_MISSING_TOKEN") {
                // For backwards compatibility with an older version of this endpoint
                // which required authentication
                return await this.http.authedRequest(Method.Post, path, undefined, data, {
                    ...requestOptions,
                    prefix: `${ClientPrefix.Unstable}/${UNSTABLE_MSC4140_DELAYED_EVENTS}`,
                });
            } else {
                throw e;
            }
        }
    }

    /**
     * Send a receipt.
     * @param event - The event being acknowledged
     * @param receiptType - The kind of receipt e.g. "m.read". Other than
     * ReceiptType.Read are experimental!
     * @param body - Additional content to send alongside the receipt.
     * @param unthreaded - An unthreaded receipt will clear room+thread notifications
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public async sendReceipt(
        event: MatrixEvent,
        receiptType: ReceiptType,
        body?: Record<string, any>,
        unthreaded = false,
    ): Promise<EmptyObject> {
        if (this.isGuest()) {
            return Promise.resolve({}); // guests cannot send receipts so don't bother.
        }

        const path = utils.encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
            $roomId: event.getRoomId()!,
            $receiptType: receiptType,
            $eventId: event.getId()!,
        });

        // Unless we're explicitly making an unthreaded receipt or we don't
        // support threads, include the `thread_id` property in the body.
        const shouldAddThreadId = !unthreaded && this.supportsThreads();
        const fullBody = shouldAddThreadId ? { ...body, thread_id: threadIdForReceipt(event) } : body;

        const promise = this.http.authedRequest<EmptyObject>(Method.Post, path, undefined, fullBody || {});

        const room = this.getRoom(event.getRoomId());
        if (room && this.credentials.userId) {
            room.addLocalEchoReceipt(this.credentials.userId, event, receiptType, unthreaded);
        }
        return promise;
    }

    /**
     * Send a read receipt.
     * @param event - The event that has been read.
     * @param receiptType - other than ReceiptType.Read are experimental! Optional.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public async sendReadReceipt(
        event: MatrixEvent | null,
        receiptType = ReceiptType.Read,
        unthreaded = false,
    ): Promise<EmptyObject | undefined> {
        if (!event) return;
        const eventId = event.getId()!;
        const room = this.getRoom(event.getRoomId());
        if (room?.hasPendingEvent(eventId)) {
            throw new Error(`Cannot set read receipt to a pending event (${eventId})`);
        }

        return this.sendReceipt(event, receiptType, {}, unthreaded);
    }

    /**
     * Set a marker to indicate the point in a room before which the user has read every
     * event. This can be retrieved from room account data (the event type is `m.fully_read`)
     * and displayed as a horizontal line in the timeline that is visually distinct to the
     * position of the user's own read receipt.
     * @param roomId - ID of the room that has been read
     * @param rmEventId - ID of the event that has been read
     * @param rrEvent - the event tracked by the read receipt. This is here for
     * convenience because the RR and the RM are commonly updated at the same time as each
     * other. The local echo of this receipt will be done if set. Optional.
     * @param rpEvent - the m.read.private read receipt event for when we don't
     * want other users to see the read receipts. This is experimental. Optional.
     * @returns Promise which resolves: the empty object, `{}`.
     */
    public async setRoomReadMarkers(
        roomId: string,
        rmEventId: string,
        rrEvent?: MatrixEvent,
        rpEvent?: MatrixEvent,
    ): Promise<EmptyObject> {
        const room = this.getRoom(roomId);
        if (room?.hasPendingEvent(rmEventId)) {
            throw new Error(`Cannot set read marker to a pending event (${rmEventId})`);
        }

        // Add the optional RR update, do local echo like `sendReceipt`
        let rrEventId: string | undefined;
        if (rrEvent) {
            rrEventId = rrEvent.getId()!;
            if (room?.hasPendingEvent(rrEventId)) {
                throw new Error(`Cannot set read receipt to a pending event (${rrEventId})`);
            }
            room?.addLocalEchoReceipt(this.credentials.userId!, rrEvent, ReceiptType.Read);
        }

        // Add the optional private RR update, do local echo like `sendReceipt`
        let rpEventId: string | undefined;
        if (rpEvent) {
            rpEventId = rpEvent.getId()!;
            if (room?.hasPendingEvent(rpEventId)) {
                throw new Error(`Cannot set read receipt to a pending event (${rpEventId})`);
            }
            room?.addLocalEchoReceipt(this.credentials.userId!, rpEvent, ReceiptType.ReadPrivate);
        }

        return await this.setRoomReadMarkersHttpRequest(roomId, rmEventId, rrEventId, rpEventId);
    }

    public sendRtcDecline(roomId: string, notificationEventId: string): Promise<ISendEventResponse> {
        return this.sendEvent(roomId, EventType.RTCDecline, {
            "m.relates_to": { event_id: notificationEventId, rel_type: RelationType.Reference },
        });
    }

    /**
     * Get a preview of the given URL as of (roughly) the given point in time,
     * described as an object with OpenGraph keys and associated values.
     * Attributes may be synthesized where actual OG metadata is lacking.
     * Caches results to prevent hammering the server.
     * @param url - The URL to get preview data for
     * @param ts - The preferred point in time that the preview should
     * describe (ms since epoch).  The preview returned will either be the most
     * recent one preceding this timestamp if available, or failing that the next
     * most recent available preview.
     * @returns Promise which resolves: Object of OG metadata.
     * @returns Rejects: with an error response.
     * May return synthesized attributes if the URL lacked OG meta.
     */
    public getUrlPreview(url: string, ts: number): Promise<IPreviewUrlResponse> {
        // bucket the timestamp to the nearest minute to prevent excessive spam to the server
        // Surely 60-second accuracy is enough for anyone.
        ts = Math.floor(ts / 60000) * 60000;

        const parsed = new URL(url);
        parsed.hash = ""; // strip the hash as it won't affect the preview
        url = parsed.toString();

        const key = ts + "_" + url;

        // If there's already a request in flight (or we've handled it), return that instead.
        if (key in this.urlPreviewCache) {
            return this.urlPreviewCache[key];
        }

        const resp = this.http.authedRequest<IPreviewUrlResponse>(
            Method.Get,
            "/preview_url",
            {
                url,
                ts: ts.toString(),
            },
            undefined,
            {
                prefix: MediaPrefix.V3,
                priority: "low",
            },
        );
        // TODO: Expire the URL preview cache sometimes
        this.urlPreviewCache[key] = resp;
        return resp;
    }

    /**
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<EmptyObject> {
        if (this.isGuest()) {
            return Promise.resolve({}); // guests cannot send typing notifications so don't bother.
        }

        const path = utils.encodeUri("/rooms/$roomId/typing/$userId", {
            $roomId: roomId,
            $userId: this.getUserId()!,
        });
        const data: QueryDict = {
            typing: isTyping,
        };
        if (isTyping) {
            data.timeout = timeoutMs ? timeoutMs : 20000;
        }
        return this.http.authedRequest(Method.Put, path, undefined, data);
    }

    /**
     * Determines the history of room upgrades for a given room, as far as the
     * client can see. Returns an array of Rooms where the first entry is the
     * oldest and the last entry is the newest (likely current) room. If the
     * provided room is not found, this returns an empty list. This works in
     * both directions, looking for older and newer rooms of the given room.
     * @param roomId - The room ID to search from
     * @param verifyLinks - If true, the function will only return rooms
     * which can be proven to be linked. For example, rooms which have a create
     * event pointing to an old room which the client is not aware of or doesn't
     * have a matching tombstone would not be returned.
     * @param msc3946ProcessDynamicPredecessor - if true, look for
     * m.room.predecessor state events as well as create events, and prefer
     * predecessor events where they exist (MSC3946).
     * @returns An array of rooms representing the upgrade
     * history.
     */
    public getRoomUpgradeHistory(
        roomId: string,
        verifyLinks = false,
        msc3946ProcessDynamicPredecessor = false,
    ): Room[] {
        const currentRoom = this.getRoom(roomId);
        if (!currentRoom) return [];

        const before = this.findPredecessorRooms(currentRoom, verifyLinks, msc3946ProcessDynamicPredecessor);
        const after = this.findSuccessorRooms(currentRoom, verifyLinks, msc3946ProcessDynamicPredecessor);

        return [...before, currentRoom, ...after];
    }

    private findPredecessorRooms(room: Room, verifyLinks: boolean, msc3946ProcessDynamicPredecessor: boolean): Room[] {
        const ret: Room[] = [];
        const seenRoomIDs = new Set<string>([room.roomId]);

        // Work backwards from newer to older rooms
        let predecessorRoomId = room.findPredecessor(msc3946ProcessDynamicPredecessor)?.roomId;
        while (predecessorRoomId !== null) {
            if (predecessorRoomId) {
                if (seenRoomIDs.has(predecessorRoomId)) break;
                seenRoomIDs.add(predecessorRoomId);
            }
            const predecessorRoom = this.getRoom(predecessorRoomId);
            if (predecessorRoom === null) {
                break;
            }
            if (verifyLinks) {
                const tombstone = predecessorRoom.currentState.getStateEvents(EventType.RoomTombstone, "");
                if (!tombstone || tombstone.getContent()["replacement_room"] !== room.roomId) {
                    break;
                }
            }

            // Insert at the front because we're working backwards from the currentRoom
            ret.splice(0, 0, predecessorRoom);

            room = predecessorRoom;
            predecessorRoomId = room.findPredecessor(msc3946ProcessDynamicPredecessor)?.roomId;
        }
        return ret;
    }

    private findSuccessorRooms(room: Room, verifyLinks: boolean, msc3946ProcessDynamicPredecessor: boolean): Room[] {
        const ret: Room[] = [];

        // Work forwards, looking at tombstone events
        let tombstoneEvent = room.currentState.getStateEvents(EventType.RoomTombstone, "");
        while (tombstoneEvent) {
            const successorRoom = this.getRoom(tombstoneEvent.getContent()["replacement_room"]);
            if (!successorRoom) break; // end of the chain
            if (successorRoom.roomId === room.roomId) break; // Tombstone is referencing its own room

            if (verifyLinks) {
                const predecessorRoomId = successorRoom.findPredecessor(msc3946ProcessDynamicPredecessor)?.roomId;
                if (!predecessorRoomId || predecessorRoomId !== room.roomId) {
                    break;
                }
            }

            // Push to the end because we're looking forwards
            ret.push(successorRoom);
            const roomIds = new Set(ret.map((ref) => ref.roomId));
            if (roomIds.size < ret.length) {
                // The last room added to the list introduced a previous roomId
                // To avoid recursion, return the last rooms - 1
                return ret.slice(0, ret.length - 1);
            }

            // Set the current room to the reference room so we know where we're at
            room = successorRoom;
            tombstoneEvent = room.currentState.getStateEvents(EventType.RoomTombstone, "");
        }
        return ret;
    }

    /**
     * Send an invite to the given user to join the given room.
     *
     * @param roomId - The ID of the room to which the user should be invited.
     * @param userId - The ID of the user that should be invited.
     * @param opts - Optional reason object. For backwards compatibility, a string is also accepted, and will be interpreted as a reason.
     *
     * @returns An empty object.
     */
    public async invite(roomId: string, userId: string, opts: InviteOpts | string = {}): Promise<EmptyObject> {
        if (typeof opts != "object") {
            opts = { reason: opts };
        }

        if (opts.shareEncryptedHistory) {
            await this.cryptoBackend?.shareRoomHistoryWithUser(roomId, userId);
        }

        return await this.membershipChange(roomId, userId, KnownMembership.Invite, opts.reason);
    }

    /**
     * Invite a user to a room based on their email address.
     * @param roomId - The room to invite the user to.
     * @param email - The email address to invite.
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public inviteByEmail(roomId: string, email: string): Promise<EmptyObject> {
        return this.inviteByThreePid(roomId, "email", email);
    }

    /**
     * Invite a user to a room based on a third-party identifier.
     * @param roomId - The room to invite the user to.
     * @param medium - The medium to invite the user e.g. "email".
     * @param address - The address for the specified medium.
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public async inviteByThreePid(roomId: string, medium: string, address: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/rooms/$roomId/invite", { $roomId: roomId });

        const identityServerUrl = this.getIdentityServerUrl(true);
        if (!identityServerUrl) {
            return Promise.reject(
                new MatrixError({
                    error: "No supplied identity server URL",
                    errcode: "ORG.MATRIX.JSSDK_MISSING_PARAM",
                }),
            );
        }
        const params: Record<string, string> = {
            id_server: identityServerUrl,
            medium: medium,
            address: address,
        };

        if (this.identityServer?.getAccessToken) {
            const identityAccessToken = await this.identityServer.getAccessToken();
            if (identityAccessToken) {
                params["id_access_token"] = identityAccessToken;
            }
        }

        return this.http.authedRequest(Method.Post, path, undefined, params);
    }

    /**
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public leave(roomId: string): Promise<EmptyObject> {
        return this.membershipChange(roomId, undefined, KnownMembership.Leave);
    }

    /**
     * Leaves all rooms in the chain of room upgrades based on the given room. By
     * default, this will leave all the previous and upgraded rooms, including the
     * given room. To only leave the given room and any previous rooms, keeping the
     * upgraded (modern) rooms untouched supply `false` to `includeFuture`.
     * @param roomId - The room ID to start leaving at
     * @param includeFuture - If true, the whole chain (past and future) of
     * upgraded rooms will be left.
     * @returns Promise which resolves when completed with an object keyed
     * by room ID and value of the error encountered when leaving or null.
     */
    public leaveRoomChain(
        roomId: string,
        includeFuture = true,
    ): Promise<{ [roomId: string]: Error | MatrixError | null }> {
        const upgradeHistory = this.getRoomUpgradeHistory(roomId, true);

        let eligibleToLeave = upgradeHistory;
        if (!includeFuture) {
            eligibleToLeave = [];
            for (const room of upgradeHistory) {
                eligibleToLeave.push(room);
                if (room.roomId === roomId) {
                    break;
                }
            }
        }

        const populationResults: { [roomId: string]: Error } = {};
        const promises: Promise<unknown>[] = [];

        const doLeave = (roomId: string): Promise<void> => {
            return this.leave(roomId)
                .then(() => {
                    delete populationResults[roomId];
                })
                .catch((err) => {
                    // suppress error
                    populationResults[roomId] = err;
                });
        };

        for (const room of eligibleToLeave) {
            promises.push(doLeave(room.roomId));
        }

        return Promise.all(promises).then(() => populationResults);
    }

    /**
     * @param reason - Optional.
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public ban(roomId: string, userId: string, reason?: string): Promise<EmptyObject> {
        return this.membershipChange(roomId, userId, KnownMembership.Ban, reason);
    }

    /**
     * @param deleteRoom - True to delete the room from the store on success.
     * Default: true.
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public async forget(roomId: string, deleteRoom = true): Promise<EmptyObject> {
        // API returns an empty object
        const path = utils.encodeUri("/rooms/$room_id/forget", {
            $room_id: roomId,
        });
        const response = await this.http.authedRequest<EmptyObject>(Method.Post, path);
        if (deleteRoom) {
            this.store.removeRoom(roomId);
            this.emit(ClientEvent.DeleteRoom, roomId);
        }
        return response;
    }

    /**
     * @returns Promise which resolves: Object (currently empty)
     * @returns Rejects: with an error response.
     */
    public unban(roomId: string, userId: string): Promise<EmptyObject> {
        // unbanning != set their state to leave: this used to be
        // the case, but was then changed so that leaving was always
        // a revoking of privilege, otherwise two people racing to
        // kick / ban someone could end up banning and then un-banning
        // them.
        const path = utils.encodeUri("/rooms/$roomId/unban", {
            $roomId: roomId,
        });
        const data = {
            user_id: userId,
        };
        return this.http.authedRequest(Method.Post, path, undefined, data);
    }

    /**
     * @param reason - Optional.
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public kick(roomId: string, userId: string, reason?: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/rooms/$roomId/kick", {
            $roomId: roomId,
        });
        const data = {
            user_id: userId,
            reason: reason,
        };
        return this.http.authedRequest(Method.Post, path, undefined, data);
    }

    private membershipChange(
        roomId: string,
        userId: string | undefined,
        membership: Membership,
        reason?: string,
    ): Promise<EmptyObject> {
        // API returns an empty object
        const path = utils.encodeUri("/rooms/$room_id/$membership", {
            $room_id: roomId,
            $membership: membership,
        });
        return this.http.authedRequest(Method.Post, path, undefined, {
            user_id: userId, // may be undefined e.g. on leave
            reason: reason,
        });
    }

    /**
     * Obtain a dict of actions which should be performed for this event according
     * to the push rules for this user.  Caches the dict on the event.
     * @param event - The event to get push actions for.
     * @param forceRecalculate - forces to recalculate actions for an event
     * Useful when an event just got decrypted
     * @returns A dict of actions to perform.
     */
    public getPushActionsForEvent(event: MatrixEvent, forceRecalculate = false): IActionsObject | null {
        if (!event.getPushActions() || forceRecalculate) {
            const { actions, rule } = this.pushProcessor.actionsAndRuleForEvent(event);
            event.setPushDetails(actions, rule);
        }
        return event.getPushActions();
    }

    /**
     * Obtain a dict of actions which should be performed for this event according
     * to the push rules for this user.  Caches the dict on the event.
     * @param event - The event to get push actions for.
     * @param forceRecalculate - forces to recalculate actions for an event
     * Useful when an event just got decrypted
     * @returns A dict of actions to perform.
     */
    public getPushDetailsForEvent(event: MatrixEvent, forceRecalculate = false): PushDetails | null {
        if (!event.getPushDetails() || forceRecalculate) {
            const { actions, rule } = this.pushProcessor.actionsAndRuleForEvent(event);
            event.setPushDetails(actions, rule);
        }
        return event.getPushDetails();
    }

    /**
     * @param info - The kind of info to set (e.g. 'avatar_url')
     * @param data - The JSON object to set.
     * @returns
     * @returns Rejects: with an error response.
     */
    // eslint-disable-next-line camelcase
    public setProfileInfo(info: "avatar_url", data: { avatar_url: string }): Promise<EmptyObject>;
    public setProfileInfo(info: "displayname", data: { displayname: string }): Promise<EmptyObject>;
    public setProfileInfo(info: "avatar_url" | "displayname", data: object): Promise<EmptyObject> {
        const path = utils.encodeUri("/profile/$userId/$info", {
            $userId: this.credentials.userId!,
            $info: info,
        });
        return this.http.authedRequest(Method.Put, path, undefined, data);
    }

    /**
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public async setDisplayName(name: string): Promise<EmptyObject> {
        const prom = await this.setProfileInfo("displayname", { displayname: name });
        // XXX: synthesise a profile update for ourselves because Synapse is broken and won't
        const user = this.getUser(this.getUserId()!);
        if (user) {
            user.displayName = name;
            user.emit(UserEvent.DisplayName, user.events.presence, user);
        }
        return prom;
    }

    /**
     * @returns Promise which resolves: `{}` an empty object.
     * @returns Rejects: with an error response.
     */
    public async setAvatarUrl(url: string): Promise<EmptyObject> {
        const prom = await this.setProfileInfo("avatar_url", { avatar_url: url });
        // XXX: synthesise a profile update for ourselves because Synapse is broken and won't
        const user = this.getUser(this.getUserId()!);
        if (user) {
            user.avatarUrl = url;
            user.emit(UserEvent.AvatarUrl, user.events.presence, user);
        }
        return prom;
    }

    /**
     * Turn an MXC URL into an HTTP one. <strong>This method is experimental and
     * may change.</strong>
     * @param mxcUrl - The MXC URL
     * @param width - The desired width of the thumbnail.
     * @param height - The desired height of the thumbnail.
     * @param resizeMethod - The thumbnail resize method to use, either
     * "crop" or "scale".
     * @param allowDirectLinks - If true, return any non-mxc URLs
     * directly. Fetching such URLs will leak information about the user to
     * anyone they share a room with. If false, will return null for such URLs.
     * @param allowRedirects - If true, the caller supports the URL being 307 or
     * 308 redirected to another resource upon request. If false, redirects
     * are not expected. Implied `true` when `useAuthentication` is `true`.
     * @param useAuthentication - If true, the caller supports authenticated
     * media and wants an authentication-required URL. Note that server support
     * for authenticated media will *not* be checked - it is the caller's responsibility
     * to do so before calling this function. Note also that `useAuthentication`
     * implies `allowRedirects`. Defaults to false (unauthenticated endpoints).
     * @returns the avatar URL or null.
     */
    public mxcUrlToHttp(
        mxcUrl: string,
        width?: number,
        height?: number,
        resizeMethod?: string,
        allowDirectLinks?: boolean,
        allowRedirects?: boolean,
        useAuthentication?: boolean,
    ): string | null {
        return getHttpUriForMxc(
            this.baseUrl,
            mxcUrl,
            width,
            height,
            resizeMethod,
            allowDirectLinks,
            allowRedirects,
            useAuthentication,
        );
    }

    /**
     * Specify the set_presence value to be used for subsequent calls to the Sync API.
     * This has an advantage over calls to the PUT /presence API in that it
     * doesn't clobber status_msg set by other devices.
     * @param presence - the presence to specify to set_presence of sync calls
     */
    public async setSyncPresence(presence?: SetPresence): Promise<void> {
        this.syncApi?.setPresence(presence);
    }

    /**
     * @param opts - Options to apply
     * @returns Promise which resolves
     * @returns Rejects: with an error response.
     * @throws If 'presence' isn't a valid presence enum value.
     */
    public async setPresence(opts: IPresenceOpts): Promise<void> {
        const path = utils.encodeUri("/presence/$userId/status", {
            $userId: this.credentials.userId!,
        });

        const validStates = ["offline", "online", "unavailable"];
        if (validStates.indexOf(opts.presence) === -1) {
            throw new Error("Bad presence value: " + opts.presence);
        }
        await this.http.authedRequest(Method.Put, path, undefined, opts);
    }

    /**
     * @param userId - The user to get presence for
     * @returns Promise which resolves: The presence state for this user.
     * @returns Rejects: with an error response.
     */
    public getPresence(userId: string): Promise<IStatusResponse> {
        const path = utils.encodeUri("/presence/$userId/status", {
            $userId: userId,
        });

        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Retrieve older messages from the given room and put them in the timeline.
     *
     * If this is called multiple times whilst a request is ongoing, the <i>same</i>
     * Promise will be returned. If there was a problem requesting scrollback, there
     * will be a small delay before another request can be made (to prevent tight-looping
     * when there is no connection).
     *
     * @param room - The room to get older messages in.
     * @param limit - Optional. The maximum number of previous events to
     * pull in. Default: 30.
     * @returns Promise which resolves: Room. If you are at the beginning
     * of the timeline, `Room.oldState.paginationToken` will be
     * `null`.
     * @returns Rejects: with an error response.
     */
    public scrollback(room: Room, limit = 30): Promise<Room> {
        let timeToWaitMs = 0;

        let info = this.ongoingScrollbacks[room.roomId] || {};
        if (info.promise) {
            return info.promise;
        } else if (info.errorTs) {
            const timeWaitedMs = Date.now() - info.errorTs;
            timeToWaitMs = Math.max(SCROLLBACK_DELAY_MS - timeWaitedMs, 0);
        }

        if (room.oldState.paginationToken === null) {
            return Promise.resolve(room); // already at the start.
        }
        // attempt to grab more events from the store first
        const numAdded = this.store.scrollback(room, limit).length;
        if (numAdded === limit) {
            // store contained everything we needed.
            return Promise.resolve(room);
        }
        // reduce the required number of events appropriately
        limit = limit - numAdded;

        const promise = new Promise<Room>((resolve, reject) => {
            // wait for a time before doing this request
            // (which may be 0 in order not to special case the code paths)
            sleep(timeToWaitMs)
                .then(() => {
                    return this.createMessagesRequest(
                        room.roomId,
                        room.oldState.paginationToken,
                        limit,
                        Direction.Backward,
                    );
                })
                .then((res: IMessagesResponse) => {
                    const matrixEvents = res.chunk.map(this.getEventMapper());
                    if (res.state) {
                        const stateEvents = res.state.map(this.getEventMapper());
                        room.currentState.setUnknownStateEvents(stateEvents);
                    }

                    const [timelineEvents, threadedEvents, unknownRelations] =
                        room.partitionThreadedEvents(matrixEvents);

                    this.processAggregatedTimelineEvents(room, timelineEvents);
                    room.addEventsToTimeline(timelineEvents, true, true, room.getLiveTimeline());
                    this.processThreadEvents(room, threadedEvents, true);
                    unknownRelations.forEach((event) => room.relations.aggregateChildEvent(event));

                    room.oldState.paginationToken = res.end ?? null;
                    if (res.chunk.length === 0) {
                        room.oldState.paginationToken = null;
                    }
                    this.store.storeEvents(room, matrixEvents, res.end ?? null, true);
                    delete this.ongoingScrollbacks[room.roomId];
                    resolve(room);
                })
                .catch((err) => {
                    this.ongoingScrollbacks[room.roomId] = {
                        errorTs: Date.now(),
                    };
                    reject(err);
                });
        });

        info = { promise };

        this.ongoingScrollbacks[room.roomId] = info;
        return promise;
    }

    public getEventMapper(options?: MapperOpts): EventMapper {
        return eventMapperFor(this, options || {});
    }

    /**
     * Calls the `/context` API for the given room ID & event ID.
     * Returns the response, with `event` asserted and all optional arrays defaulted to an empty array.
     * @param roomId - the room ID to request a context for
     * @param eventId - the event ID to request a context for
     * @throws if `event` in the response is missing
     * @private
     */
    private async getEventContext(
        roomId: string,
        eventId: string,
    ): Promise<IContextResponse & Omit<Required<IContextResponse>, "start" | "end">> {
        const path = utils.encodeUri("/rooms/$roomId/context/$eventId", {
            $roomId: roomId,
            $eventId: eventId,
        });

        const params: Record<string, string | string[]> = {
            limit: "0",
        };
        if (this.clientOpts?.lazyLoadMembers) {
            params.filter = JSON.stringify(Filter.LAZY_LOADING_MESSAGES_FILTER);
        }

        // TODO: we should implement a backoff (as per scrollback()) to deal more nicely with HTTP errors.
        const res = await this.http.authedRequest<IContextResponse>(Method.Get, path, params);
        if (res.event) {
            return {
                start: res.start,
                end: res.end,
                event: res.event,
                events_after: res.events_after ?? [],
                events_before: res.events_before ?? [],
                state: res.state ?? [],
            };
        }

        throw new Error("'event' not in '/context' result - homeserver too old?");
    }

    /**
     * Get an EventTimeline for the given event
     *
     * <p>If the EventTimelineSet object already has the given event in its store, the
     * corresponding timeline will be returned. Otherwise, a /context request is
     * made, and used to construct an EventTimeline.
     * If the event does not belong to this EventTimelineSet then undefined will be returned.
     *
     * @param timelineSet -  The timelineSet to look for the event in, must be bound to a room
     * @param eventId -  The ID of the event to look for
     *
     * @returns Promise which resolves:
     *    {@link EventTimeline} including the given event
     */
    public async getEventTimeline(timelineSet: EventTimelineSet, eventId: string): Promise<EventTimeline | null> {
        // don't allow any timeline support unless it's been enabled.
        if (!this.timelineSupport) {
            throw new Error(
                "timeline support is disabled. Set the 'timelineSupport'" +
                    " parameter to true when creating MatrixClient to enable it.",
            );
        }

        if (!timelineSet?.room) {
            throw new Error("getEventTimeline only supports room timelines");
        }

        if (timelineSet.getTimelineForEvent(eventId)) {
            return timelineSet.getTimelineForEvent(eventId);
        }

        if (timelineSet.thread && this.supportsThreads()) {
            return (await this.getThreadTimeline(timelineSet, eventId)) ?? null;
        }

        const res = await this.getEventContext(timelineSet.room.roomId, eventId);

        // by the time the request completes, the event might have ended up in the timeline.
        if (timelineSet.getTimelineForEvent(eventId)) {
            return timelineSet.getTimelineForEvent(eventId);
        }

        const mapper = this.getEventMapper();
        const event = mapper(res.event);
        if (event.isRelation(THREAD_RELATION_TYPE.name)) {
            this.logger.warn("Tried loading a regular timeline at the position of a thread event");
            return null;
        }
        const events = [
            // Order events from most recent to oldest (reverse-chronological).
            // We start with the last event, since that's the point at which we have known state.
            // events_after is already backwards; events_before is forwards.
            ...res.events_after.reverse().map(mapper),
            event,
            ...res.events_before.map(mapper),
        ];

        // Here we handle non-thread timelines only, but still process any thread events to populate thread summaries.
        let timeline = timelineSet.getTimelineForEvent(events[0].getId());
        if (timeline) {
            timeline.getState(EventTimeline.BACKWARDS)!.setUnknownStateEvents(res.state.map(mapper));
        } else {
            timeline = timelineSet.addTimeline();
            timeline.initialiseState(res.state.map(mapper));
            timeline.getState(EventTimeline.FORWARDS)!.paginationToken = res.end ?? null;
        }

        const [timelineEvents, threadedEvents, unknownRelations] = timelineSet.room.partitionThreadedEvents(events);
        timelineSet.addEventsToTimeline(timelineEvents, true, false, timeline, res.start);
        // The target event is not in a thread but process the contextual events, so we can show any threads around it.
        this.processThreadEvents(timelineSet.room, threadedEvents, true);
        this.processAggregatedTimelineEvents(timelineSet.room, timelineEvents);
        unknownRelations.forEach((event) => timelineSet.relations.aggregateChildEvent(event));

        // There is no guarantee that the event ended up in "timeline" (we might have switched to a neighbouring
        // timeline) - so check the room's index again. On the other hand, there's no guarantee the event ended up
        // anywhere, if it was later redacted, so we just return the timeline we first thought of.
        return (
            timelineSet.getTimelineForEvent(eventId) ??
            timelineSet.room.findThreadForEvent(event)?.liveTimeline ?? // for Threads degraded support
            timeline
        );
    }

    public async getThreadTimeline(timelineSet: EventTimelineSet, eventId: string): Promise<EventTimeline | undefined> {
        if (!this.supportsThreads()) {
            throw new Error("could not get thread timeline: no client support");
        }

        if (!timelineSet.room) {
            throw new Error("could not get thread timeline: not a room timeline");
        }

        if (!timelineSet.thread) {
            throw new Error("could not get thread timeline: not a thread timeline");
        }

        const res = await this.getEventContext(timelineSet.room.roomId, eventId);

        const mapper = this.getEventMapper();
        const event = mapper(res.event);

        if (!timelineSet.canContain(event)) {
            return undefined;
        }

        const recurse = this.canSupport.get(Feature.RelationsRecursion) !== ServerSupport.Unsupported;
        if (Thread.hasServerSideSupport) {
            if (Thread.hasServerSideFwdPaginationSupport) {
                if (!timelineSet.thread) {
                    throw new Error("could not get thread timeline: not a thread timeline");
                }

                const thread = timelineSet.thread;
                const resOlder: IRelationsResponse = await this.fetchRelations(
                    timelineSet.room.roomId,
                    thread.id,
                    null,
                    null,
                    { dir: Direction.Backward, from: res.start, recurse: recurse || undefined },
                );
                const resNewer: IRelationsResponse = await this.fetchRelations(
                    timelineSet.room.roomId,
                    thread.id,
                    null,
                    null,
                    { dir: Direction.Forward, from: res.end, recurse: recurse || undefined },
                );
                const events = [
                    // Order events from most recent to oldest (reverse-chronological).
                    // We start with the last event, since that's the point at which we have known state.
                    // events_after is already backwards; events_before is forwards.
                    ...resNewer.chunk.reverse().filter(getRelationsThreadFilter(thread.id)).map(mapper),
                    event,
                    ...resOlder.chunk.filter(getRelationsThreadFilter(thread.id)).map(mapper),
                ];

                for (const event of events) {
                    await timelineSet.thread?.processEvent(event);
                }

                // Here we handle non-thread timelines only, but still process any thread events to populate thread summaries.
                let timeline = timelineSet.getTimelineForEvent(event.getId());
                if (timeline) {
                    timeline.getState(EventTimeline.BACKWARDS)!.setUnknownStateEvents(res.state.map(mapper));
                } else {
                    timeline = timelineSet.addTimeline();
                    timeline.initialiseState(res.state.map(mapper));
                }

                timelineSet.addEventsToTimeline(events, true, false, timeline, resNewer.next_batch);
                if (!resOlder.next_batch) {
                    const originalEvent = await this.fetchRoomEvent(timelineSet.room.roomId, thread.id);
                    timelineSet.addEventsToTimeline([mapper(originalEvent)], true, false, timeline, null);
                }
                timeline.setPaginationToken(resOlder.next_batch ?? null, Direction.Backward);
                timeline.setPaginationToken(resNewer.next_batch ?? null, Direction.Forward);
                this.processAggregatedTimelineEvents(timelineSet.room, events);

                // There is no guarantee that the event ended up in "timeline" (we might have switched to a neighbouring
                // timeline) - so check the room's index again. On the other hand, there's no guarantee the event ended up
                // anywhere, if it was later redacted, so we just return the timeline we first thought of.
                return timelineSet.getTimelineForEvent(eventId) ?? timeline;
            } else {
                // Where the event is a thread reply (not a root) and running in MSC-enabled mode the Thread timeline only
                // functions contiguously, so we have to jump through some hoops to get our target event in it.
                // XXX: workaround for https://github.com/vector-im/element-meta/issues/150

                const thread = timelineSet.thread;

                const resOlder = await this.fetchRelations(
                    timelineSet.room.roomId,
                    thread.id,
                    THREAD_RELATION_TYPE.name,
                    null,
                    { dir: Direction.Backward, from: res.start, recurse: recurse || undefined },
                );
                const eventsNewer: IEvent[] = [];
                let nextBatch = res.end;
                while (nextBatch) {
                    const resNewer: IRelationsResponse = await this.fetchRelations(
                        timelineSet.room.roomId,
                        thread.id,
                        THREAD_RELATION_TYPE.name,
                        null,
                        { dir: Direction.Forward, from: nextBatch, recurse: recurse || undefined },
                    );
                    nextBatch = resNewer.next_batch;
                    eventsNewer.push(...resNewer.chunk);
                }
                const events = [
                    // Order events from most recent to oldest (reverse-chronological).
                    // We start with the last event, since that's the point at which we have known state.
                    // events_after is already backwards; events_before is forwards.
                    ...eventsNewer.reverse().map(mapper),
                    event,
                    ...resOlder.chunk.map(mapper),
                ];
                for (const event of events) {
                    await timelineSet.thread?.processEvent(event);
                }

                // Here we handle non-thread timelines only, but still process any thread events to populate thread
                // summaries.
                const timeline = timelineSet.getLiveTimeline();
                timeline.getState(EventTimeline.BACKWARDS)!.setUnknownStateEvents(res.state.map(mapper));

                timelineSet.addEventsToTimeline(events, true, false, timeline, null);
                if (!resOlder.next_batch) {
                    const originalEvent = await this.fetchRoomEvent(timelineSet.room.roomId, thread.id);
                    timelineSet.addEventsToTimeline([mapper(originalEvent)], true, false, timeline, null);
                }
                timeline.setPaginationToken(resOlder.next_batch ?? null, Direction.Backward);
                timeline.setPaginationToken(null, Direction.Forward);
                this.processAggregatedTimelineEvents(timelineSet.room, events);

                return timeline;
            }
        }
    }

    /**
     * Get an EventTimeline for the latest events in the room. This will just
     * call `/messages` to get the latest message in the room, then use
     * `client.getEventTimeline(...)` to construct a new timeline from it.
     *
     * @param timelineSet -  The timelineSet to find or add the timeline to
     *
     * @returns Promise which resolves:
     *    {@link EventTimeline} timeline with the latest events in the room
     */
    public async getLatestTimeline(timelineSet: EventTimelineSet): Promise<EventTimeline | null> {
        // don't allow any timeline support unless it's been enabled.
        if (!this.timelineSupport) {
            throw new Error(
                "timeline support is disabled. Set the 'timelineSupport'" +
                    " parameter to true when creating MatrixClient to enable it.",
            );
        }

        if (!timelineSet.room) {
            throw new Error("getLatestTimeline only supports room timelines");
        }

        let event: IRoomEvent | undefined;
        if (timelineSet.threadListType !== null) {
            const res = await this.createThreadListMessagesRequest(
                timelineSet.room.roomId,
                null,
                1,
                Direction.Backward,
                timelineSet.threadListType,
                timelineSet.getFilter(),
            );
            event = res.chunk?.[0];
        } else if (timelineSet.thread && Thread.hasServerSideSupport) {
            const recurse = this.canSupport.get(Feature.RelationsRecursion) !== ServerSupport.Unsupported;
            const res = await this.fetchRelations(
                timelineSet.room.roomId,
                timelineSet.thread.id,
                THREAD_RELATION_TYPE.name,
                null,
                { dir: Direction.Backward, limit: 1, recurse: recurse || undefined },
            );
            event = res.chunk?.[0];
        } else {
            const messagesPath = utils.encodeUri("/rooms/$roomId/messages", {
                $roomId: timelineSet.room.roomId,
            });

            const params: Record<string, string | string[]> = {
                dir: "b",
            };
            if (this.clientOpts?.lazyLoadMembers) {
                params.filter = JSON.stringify(Filter.LAZY_LOADING_MESSAGES_FILTER);
            }

            const res = await this.http.authedRequest<IMessagesResponse>(Method.Get, messagesPath, params);
            event = res.chunk?.[0];
        }
        if (!event) {
            throw new Error("No message returned when trying to construct getLatestTimeline");
        }

        return this.getEventTimeline(timelineSet, event.event_id);
    }

    /**
     * Makes a request to /messages with the appropriate lazy loading filter set.
     * XXX: if we do get rid of scrollback (as it's not used at the moment),
     * we could inline this method again in paginateEventTimeline as that would
     * then be the only call-site
     * @param limit - the maximum amount of events the retrieve
     * @param dir - 'f' or 'b'
     * @param timelineFilter - the timeline filter to pass
     */
    // XXX: Intended private, used in code.
    public createMessagesRequest(
        roomId: string,
        fromToken: string | null,
        limit = 30,
        dir: Direction,
        timelineFilter?: Filter,
    ): Promise<IMessagesResponse> {
        const path = utils.encodeUri("/rooms/$roomId/messages", { $roomId: roomId });

        const params: Record<string, string> = {
            limit: limit.toString(),
            dir: dir,
        };

        if (fromToken) {
            params.from = fromToken;
        }

        let filter: IRoomEventFilter | null = null;
        if (this.clientOpts?.lazyLoadMembers) {
            // create a shallow copy of LAZY_LOADING_MESSAGES_FILTER,
            // so the timelineFilter doesn't get written into it below
            filter = Object.assign({}, Filter.LAZY_LOADING_MESSAGES_FILTER);
        }
        if (timelineFilter) {
            // XXX: it's horrific that /messages' filter parameter doesn't match
            // /sync's one - see https://matrix.org/jira/browse/SPEC-451
            filter = filter || {};
            Object.assign(filter, timelineFilter.getRoomTimelineFilterComponent()?.toJSON());
        }
        if (filter) {
            params.filter = JSON.stringify(filter);
        }
        return this.http.authedRequest(Method.Get, path, params);
    }

    /**
     * Makes a request to /messages with the appropriate lazy loading filter set.
     * XXX: if we do get rid of scrollback (as it's not used at the moment),
     * we could inline this method again in paginateEventTimeline as that would
     * then be the only call-site
     * @param limit - the maximum amount of events the retrieve
     * @param dir - 'f' or 'b'
     * @param timelineFilter - the timeline filter to pass
     */
    // XXX: Intended private, used by room.fetchRoomThreads
    public createThreadListMessagesRequest(
        roomId: string,
        fromToken: string | null,
        limit = 30,
        dir = Direction.Backward,
        threadListType: ThreadFilterType | null = ThreadFilterType.All,
        timelineFilter?: Filter,
    ): Promise<IMessagesResponse> {
        const path = utils.encodeUri("/rooms/$roomId/threads", { $roomId: roomId });

        const params: Record<string, string> = {
            limit: limit.toString(),
            dir: dir,
            include: threadFilterTypeToFilter(threadListType),
        };

        if (fromToken) {
            params.from = fromToken;
        }

        let filter: IRoomEventFilter = {};
        if (this.clientOpts?.lazyLoadMembers) {
            // create a shallow copy of LAZY_LOADING_MESSAGES_FILTER,
            // so the timelineFilter doesn't get written into it below
            filter = {
                ...Filter.LAZY_LOADING_MESSAGES_FILTER,
            };
        }
        if (timelineFilter) {
            // XXX: it's horrific that /messages' filter parameter doesn't match
            // /sync's one - see https://matrix.org/jira/browse/SPEC-451
            filter = {
                ...filter,
                ...timelineFilter.getRoomTimelineFilterComponent()?.toJSON(),
            };
        }
        if (Object.keys(filter).length) {
            params.filter = JSON.stringify(filter);
        }

        const opts = {
            prefix:
                Thread.hasServerSideListSupport === FeatureSupport.Stable
                    ? ClientPrefix.V1
                    : "/_matrix/client/unstable/org.matrix.msc3856",
        };

        return this.http
            .authedRequest<IThreadedMessagesResponse>(Method.Get, path, params, undefined, opts)
            .then((res) => ({
                ...res,
                chunk: res.chunk?.reverse(),
                start: res.prev_batch,
                end: res.next_batch,
            }));
    }

    /**
     * Take an EventTimeline, and back/forward-fill results.
     *
     * @param eventTimeline - timeline object to be updated
     *
     * @returns Promise which resolves to a boolean: false if there are no
     *    events and we reached either end of the timeline; else true.
     */
    public paginateEventTimeline(eventTimeline: EventTimeline, opts: IPaginateOpts): Promise<boolean> {
        const isNotifTimeline = eventTimeline.getTimelineSet() === this.notifTimelineSet;
        const room = this.getRoom(eventTimeline.getRoomId()!);
        const threadListType = eventTimeline.getTimelineSet().threadListType;
        const thread = eventTimeline.getTimelineSet().thread;

        // TODO: we should implement a backoff (as per scrollback()) to deal more
        // nicely with HTTP errors.
        opts = opts || {};
        const backwards = opts.backwards || false;

        if (isNotifTimeline) {
            if (!backwards) {
                throw new Error("paginateNotifTimeline can only paginate backwards");
            }
        }

        const dir = backwards ? EventTimeline.BACKWARDS : EventTimeline.FORWARDS;

        const token = eventTimeline.getPaginationToken(dir);
        const pendingRequest = eventTimeline.paginationRequests[dir];

        if (pendingRequest) {
            // already a request in progress - return the existing promise
            return pendingRequest;
        }

        let path: string;
        let params: Record<string, string>;
        let promise: Promise<boolean>;

        if (isNotifTimeline) {
            path = "/notifications";
            params = {
                limit: (opts.limit ?? 30).toString(),
                only: "highlight",
            };

            if (token && token !== "end") {
                params.from = token;
            }

            promise = this.http
                .authedRequest<INotificationsResponse>(Method.Get, path, params)
                .then(async (res) => {
                    const token = res.next_token;
                    const matrixEvents: MatrixEvent[] = [];

                    res.notifications = res.notifications.filter(noUnsafeEventProps);

                    for (let i = 0; i < res.notifications.length; i++) {
                        const notification = res.notifications[i];
                        const event = this.getEventMapper()(notification.event);

                        // @TODO(kerrya) reprocessing every notification is ugly
                        // remove if we get server MSC3994 support
                        this.getPushDetailsForEvent(event, true);

                        event.event.room_id = notification.room_id; // XXX: gutwrenching
                        matrixEvents[i] = event;
                    }

                    // No need to partition events for threads here, everything lives
                    // in the notification timeline set
                    const timelineSet = eventTimeline.getTimelineSet();
                    timelineSet.addEventsToTimeline(matrixEvents, backwards, false, eventTimeline, token);
                    this.processAggregatedTimelineEvents(timelineSet.room, matrixEvents);

                    // if we've hit the end of the timeline, we need to stop trying to
                    // paginate. We need to keep the 'forwards' token though, to make sure
                    // we can recover from gappy syncs.
                    if (backwards && !res.next_token) {
                        eventTimeline.setPaginationToken(null, dir);
                    }
                    return Boolean(res.next_token);
                })
                .finally(() => {
                    eventTimeline.paginationRequests[dir] = null;
                });
            eventTimeline.paginationRequests[dir] = promise;
        } else if (threadListType !== null) {
            if (!room) {
                throw new Error("Unknown room " + eventTimeline.getRoomId());
            }

            if (!Thread.hasServerSideFwdPaginationSupport && dir === Direction.Forward) {
                throw new Error("Cannot paginate threads forwards without server-side support for MSC 3715");
            }

            promise = this.createThreadListMessagesRequest(
                eventTimeline.getRoomId()!,
                token,
                opts.limit,
                dir,
                threadListType,
                eventTimeline.getFilter(),
            )
                .then((res) => {
                    if (res.state) {
                        const roomState = eventTimeline.getState(dir)!;
                        const stateEvents = res.state.filter(noUnsafeEventProps).map(this.getEventMapper());
                        roomState.setUnknownStateEvents(stateEvents);
                    }

                    const token = res.end;
                    const matrixEvents = res.chunk.filter(noUnsafeEventProps).map(this.getEventMapper());

                    const timelineSet = eventTimeline.getTimelineSet();
                    timelineSet.addEventsToTimeline(matrixEvents, backwards, false, eventTimeline, token);
                    this.processAggregatedTimelineEvents(room, matrixEvents);
                    this.processThreadRoots(room, matrixEvents, backwards);

                    // if we've hit the end of the timeline, we need to stop trying to
                    // paginate. We need to keep the 'forwards' token though, to make sure
                    // we can recover from gappy syncs.
                    if (backwards && res.end == res.start) {
                        eventTimeline.setPaginationToken(null, dir);
                    }
                    return res.end !== res.start;
                })
                .finally(() => {
                    eventTimeline.paginationRequests[dir] = null;
                });
            eventTimeline.paginationRequests[dir] = promise;
        } else if (thread) {
            const room = this.getRoom(eventTimeline.getRoomId() ?? undefined);
            if (!room) {
                throw new Error("Unknown room " + eventTimeline.getRoomId());
            }

            const recurse = this.canSupport.get(Feature.RelationsRecursion) !== ServerSupport.Unsupported;
            promise = this.fetchRelations(eventTimeline.getRoomId() ?? "", thread.id, null, null, {
                dir,
                limit: opts.limit,
                from: token ?? undefined,
                recurse: recurse || undefined,
            })
                .then(async (res) => {
                    const mapper = this.getEventMapper();
                    const matrixEvents = res.chunk
                        .filter(noUnsafeEventProps)
                        .filter(getRelationsThreadFilter(thread.id))
                        .map(mapper);

                    // Process latest events first
                    for (const event of matrixEvents.slice().reverse()) {
                        await thread?.processEvent(event);
                        const sender = event.getSender()!;
                        if (!backwards || thread?.getEventReadUpTo(sender) === null) {
                            room.addLocalEchoReceipt(sender, event, ReceiptType.Read);
                        }
                    }

                    const newToken = res.next_batch;

                    const timelineSet = eventTimeline.getTimelineSet();
                    timelineSet.addEventsToTimeline(matrixEvents, backwards, false, eventTimeline, newToken ?? null);
                    if (!newToken && backwards) {
                        const originalEvent =
                            thread.rootEvent ??
                            mapper(await this.fetchRoomEvent(eventTimeline.getRoomId() ?? "", thread.id));
                        timelineSet.addEventsToTimeline([originalEvent], true, false, eventTimeline, null);
                    }
                    this.processAggregatedTimelineEvents(timelineSet.room, matrixEvents);

                    // if we've hit the end of the timeline, we need to stop trying to
                    // paginate. We need to keep the 'forwards' token though, to make sure
                    // we can recover from gappy syncs.
                    if (backwards && !newToken) {
                        eventTimeline.setPaginationToken(null, dir);
                    }
                    return Boolean(newToken);
                })
                .finally(() => {
                    eventTimeline.paginationRequests[dir] = null;
                });
            eventTimeline.paginationRequests[dir] = promise;
        } else {
            if (!room) {
                throw new Error("Unknown room " + eventTimeline.getRoomId());
            }

            promise = this.createMessagesRequest(
                eventTimeline.getRoomId()!,
                token,
                opts.limit,
                dir,
                eventTimeline.getFilter(),
            )
                .then((res) => {
                    if (res.state) {
                        const roomState = eventTimeline.getState(dir)!;
                        const stateEvents = res.state.filter(noUnsafeEventProps).map(this.getEventMapper());
                        roomState.setUnknownStateEvents(stateEvents);
                    }
                    const token = res.end;
                    const matrixEvents = res.chunk.filter(noUnsafeEventProps).map(this.getEventMapper());

                    const timelineSet = eventTimeline.getTimelineSet();
                    const [timelineEvents, , unknownRelations] = room.partitionThreadedEvents(matrixEvents);
                    timelineSet.addEventsToTimeline(timelineEvents, backwards, false, eventTimeline, token);
                    this.processAggregatedTimelineEvents(room, timelineEvents);
                    this.processThreadRoots(
                        room,
                        timelineEvents.filter((it) => it.getServerAggregatedRelation(THREAD_RELATION_TYPE.name)),
                        false,
                    );
                    unknownRelations.forEach((event) => room.relations.aggregateChildEvent(event));

                    const atEnd = res.end === undefined || res.end === res.start;

                    // if we've hit the end of the timeline, we need to stop trying to
                    // paginate. We need to keep the 'forwards' token though, to make sure
                    // we can recover from gappy syncs.
                    if (backwards && atEnd) {
                        eventTimeline.setPaginationToken(null, dir);
                    }
                    return !atEnd;
                })
                .finally(() => {
                    eventTimeline.paginationRequests[dir] = null;
                });
            eventTimeline.paginationRequests[dir] = promise;
        }

        return promise;
    }

    /**
     * Reset the notifTimelineSet entirely, paginating in some historical notifs as
     * a starting point for subsequent pagination.
     */
    public resetNotifTimelineSet(): void {
        if (!this.notifTimelineSet) {
            return;
        }

        // FIXME: This thing is a total hack, and results in duplicate events being
        // added to the timeline both from /sync and /notifications, and lots of
        // slow and wasteful processing and pagination.  The correct solution is to
        // extend /messages or /search or something to filter on notifications.

        // use the fictitious token 'end'. in practice we would ideally give it
        // the oldest backwards pagination token from /sync, but /sync doesn't
        // know about /notifications, so we have no choice but to start paginating
        // from the current point in time.  This may well overlap with historical
        // notifs which are then inserted into the timeline by /sync responses.
        this.notifTimelineSet.resetLiveTimeline("end");

        // we could try to paginate a single event at this point in order to get
        // a more valid pagination token, but it just ends up with an out of order
        // timeline. given what a mess this is and given we're going to have duplicate
        // events anyway, just leave it with the dummy token for now.
        /*
        this.paginateNotifTimeline(this._notifTimelineSet.getLiveTimeline(), {
            backwards: true,
            limit: 1
        });
        */
    }

    /**
     * Peek into a room and receive updates about the room. This only works if the
     * history visibility for the room is world_readable.
     * @param roomId - The room to attempt to peek into.
     * @param limit - The number of timeline events to initially retrieve.
     * @returns Promise which resolves: Room object
     * @returns Rejects: with an error response.
     */
    public peekInRoom(roomId: string, limit: number = 20): Promise<Room> {
        this.peekSync?.stopPeeking();
        this.peekSync = new SyncApi(this, this.clientOpts, this.buildSyncApiOptions());
        return this.peekSync.peek(roomId, limit);
    }

    /**
     * Stop any ongoing room peeking.
     */
    public stopPeeking(): void {
        if (this.peekSync) {
            this.peekSync.stopPeeking();
            this.peekSync = null;
        }
    }

    /**
     * Set r/w flags for guest access in a room.
     * @param roomId - The room to configure guest access in.
     * @param opts - Options
     * @returns Promise which resolves
     * @returns Rejects: with an error response.
     */
    public setGuestAccess(roomId: string, opts: IGuestAccessOpts): Promise<void> {
        const writePromise = this.sendStateEvent(
            roomId,
            EventType.RoomGuestAccess,
            {
                guest_access: opts.allowJoin ? GuestAccess.CanJoin : GuestAccess.Forbidden,
            },
            "",
        );

        let readPromise: Promise<unknown> = Promise.resolve();
        if (opts.allowRead) {
            readPromise = this.sendStateEvent(
                roomId,
                EventType.RoomHistoryVisibility,
                {
                    history_visibility: HistoryVisibility.WorldReadable,
                },
                "",
            );
        }

        return Promise.all([readPromise, writePromise]).then(); // .then() to hide results for contract
    }

    /**
     * Requests an email verification token for the purposes of registration.
     * This API requests a token from the homeserver.
     * The doesServerRequireIdServerParam() method can be used to determine if
     * the server requires the id_server parameter to be provided.
     *
     * Parameters and return value are as for requestEmailToken

     * @param email - As requestEmailToken
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestRegisterEmailToken(
        email: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
    ): Promise<IRequestTokenResponse> {
        return this.requestTokenFromEndpoint("/register/email/requestToken", {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

    /**
     * Requests a text message verification token for the purposes of registration.
     * This API requests a token from the homeserver.
     * The doesServerRequireIdServerParam() method can be used to determine if
     * the server requires the id_server parameter to be provided.
     *
     * @param phoneCountry - The ISO 3166-1 alpha-2 code for the country in which
     *    phoneNumber should be parsed relative to.
     * @param phoneNumber - The phone number, in national or international format
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestRegisterMsisdnToken(
        phoneCountry: string,
        phoneNumber: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
    ): Promise<IRequestMsisdnTokenResponse> {
        return this.requestTokenFromEndpoint("/register/msisdn/requestToken", {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

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
     * @param email - As requestEmailToken
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestAdd3pidEmailToken(
        email: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
    ): Promise<IRequestTokenResponse> {
        return this.requestTokenFromEndpoint("/account/3pid/email/requestToken", {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

    /**
     * Requests a text message verification token for the purposes of adding a
     * third party identifier to an account.
     * This API proxies the identity server /validate/email/requestToken API,
     * adding specific behaviour for the addition of phone numbers to an
     * account, as requestAdd3pidEmailToken.
     *
     * @param phoneCountry - As requestRegisterMsisdnToken
     * @param phoneNumber - As requestRegisterMsisdnToken
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestAdd3pidMsisdnToken(
        phoneCountry: string,
        phoneNumber: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
    ): Promise<IRequestMsisdnTokenResponse> {
        return this.requestTokenFromEndpoint("/account/3pid/msisdn/requestToken", {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

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
     * @param email - As requestEmailToken
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestPasswordEmailToken(
        email: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
    ): Promise<IRequestTokenResponse> {
        return this.requestTokenFromEndpoint("/account/password/email/requestToken", {
            email: email,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

    /**
     * Requests a text message verification token for the purposes of resetting
     * the password on an account.
     * This API proxies the identity server /validate/email/requestToken API,
     * adding specific behaviour for the password resetting, as requestPasswordEmailToken.
     *
     * @param phoneCountry - As requestRegisterMsisdnToken
     * @param phoneNumber - As requestRegisterMsisdnToken
     * @param clientSecret - As requestEmailToken
     * @param sendAttempt - As requestEmailToken
     * @param nextLink - As requestEmailToken
     * @returns Promise which resolves: As requestEmailToken
     */
    public requestPasswordMsisdnToken(
        phoneCountry: string,
        phoneNumber: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink: string,
    ): Promise<IRequestMsisdnTokenResponse> {
        return this.requestTokenFromEndpoint("/account/password/msisdn/requestToken", {
            country: phoneCountry,
            phone_number: phoneNumber,
            client_secret: clientSecret,
            send_attempt: sendAttempt,
            next_link: nextLink,
        });
    }

    /**
     * Internal utility function for requesting validation tokens from usage-specific
     * requestToken endpoints.
     *
     * @param endpoint - The endpoint to send the request to
     * @param params - Parameters for the POST request
     * @returns Promise which resolves: As requestEmailToken
     */
    private async requestTokenFromEndpoint<T extends IRequestTokenResponse>(
        endpoint: string,
        params: QueryDict,
    ): Promise<T> {
        const postParams = Object.assign({}, params);

        return this.http.request(Method.Post, endpoint, undefined, postParams);
    }

    /**
     * Get the room-kind push rule associated with a room.
     * @param scope - "global" or device-specific.
     * @param roomId - the id of the room.
     * @returns the rule or undefined.
     */
    public getRoomPushRule(scope: "global" | "device", roomId: string): IPushRule | undefined {
        // There can be only room-kind push rule per room
        // and its id is the room id.
        if (this.pushRules) {
            return this.pushRules[scope]?.room?.find((rule) => rule.rule_id === roomId);
        } else {
            throw new Error("SyncApi.sync() must be done before accessing to push rules.");
        }
    }

    /**
     * Set a room-kind muting push rule in a room.
     * The operation also updates MatrixClient.pushRules at the end.
     * @param scope - "global" or device-specific.
     * @param roomId - the id of the room.
     * @param mute - the mute state.
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public setRoomMutePushRule(scope: "global" | "device", roomId: string, mute: boolean): Promise<void> | undefined {
        let promise: Promise<unknown> | undefined;
        let hasDontNotifyRule = false;

        // Get the existing room-kind push rule if any
        const roomPushRule = this.getRoomPushRule(scope, roomId);
        if (roomPushRule?.actions.includes(PushRuleActionName.DontNotify)) {
            hasDontNotifyRule = true;
        }

        if (!mute) {
            // Remove the rule only if it is a muting rule
            if (hasDontNotifyRule) {
                promise = this.deletePushRule(scope, PushRuleKind.RoomSpecific, roomPushRule!.rule_id);
            }
        } else {
            if (!roomPushRule) {
                promise = this.addPushRule(scope, PushRuleKind.RoomSpecific, roomId, {
                    actions: [PushRuleActionName.DontNotify],
                });
            } else if (!hasDontNotifyRule) {
                // Remove the existing one before setting the mute push rule
                // This is a workaround to SYN-590 (Push rule update fails)
                const doneResolvers = Promise.withResolvers<void>();
                this.deletePushRule(scope, PushRuleKind.RoomSpecific, roomPushRule.rule_id)
                    .then(() => {
                        this.addPushRule(scope, PushRuleKind.RoomSpecific, roomId, {
                            actions: [PushRuleActionName.DontNotify],
                        })
                            .then(() => {
                                doneResolvers.resolve();
                            })
                            .catch((err) => {
                                doneResolvers.reject(err);
                            });
                    })
                    .catch((err) => {
                        doneResolvers.reject(err);
                    });

                promise = doneResolvers.promise;
            }
        }

        if (promise) {
            return new Promise<void>((resolve, reject) => {
                // Update this.pushRules when the operation completes
                promise!
                    .then(() => {
                        this.getPushRules()
                            .then((result) => {
                                this.pushRules = result;
                                resolve();
                            })
                            .catch((err) => {
                                reject(err);
                            });
                    })
                    .catch((err: Error) => {
                        // Update it even if the previous operation fails. This can help the
                        // app to recover when push settings has been modified from another client
                        this.getPushRules()
                            .then((result) => {
                                this.pushRules = result;
                                reject(err);
                            })
                            .catch((err2) => {
                                reject(err);
                            });
                    });
            });
        }
    }

    public searchMessageText(opts: ISearchOpts): Promise<ISearchResponse> {
        const roomEvents: ISearchRequestBody["search_categories"]["room_events"] = {
            search_term: opts.query,
        };

        if ("keys" in opts) {
            roomEvents.keys = opts.keys;
        }

        return this.search({
            body: {
                search_categories: {
                    room_events: roomEvents,
                },
            },
        });
    }

    /**
     * Perform a server-side search for room events.
     *
     * The returned promise resolves to an object containing the fields:
     *
     *  * count:       estimate of the number of results
     *  * next_batch:  token for back-pagination; if undefined, there are no more results
     *  * highlights:  a list of words to highlight from the stemming algorithm
     *  * results:     a list of results
     *
     * Each entry in the results list is a SearchResult.
     *
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public searchRoomEvents(opts: IEventSearchOpts): Promise<ISearchResults> {
        // TODO: support search groups

        const body = {
            search_categories: {
                room_events: {
                    search_term: opts.term,
                    filter: opts.filter,
                    order_by: SearchOrderBy.Recent,
                    event_context: {
                        before_limit: 1,
                        after_limit: 1,
                        include_profile: true,
                    },
                },
            },
        };

        const searchResults: ISearchResults = {
            _query: body,
            results: [],
            highlights: [],
        };

        return this.search({ body: body }).then((res) => this.processRoomEventsSearch(searchResults, res));
    }

    /**
     * Take a result from an earlier searchRoomEvents call, and backfill results.
     *
     * @param searchResults -  the results object to be updated
     * @returns Promise which resolves: updated result object
     * @returns Rejects: with an error response.
     */
    public backPaginateRoomEventsSearch<T extends ISearchResults>(searchResults: T): Promise<T> {
        // TODO: we should implement a backoff (as per scrollback()) to deal more
        // nicely with HTTP errors.

        if (!searchResults.next_batch) {
            return Promise.reject(new Error("Cannot backpaginate event search any further"));
        }

        if (searchResults.pendingRequest) {
            // already a request in progress - return the existing promise
            return searchResults.pendingRequest as Promise<T>;
        }

        const searchOpts = {
            body: searchResults._query!,
            next_batch: searchResults.next_batch,
        };

        const promise = this.search(searchOpts, searchResults.abortSignal)
            .then((res) => this.processRoomEventsSearch(searchResults, res))
            .finally(() => {
                searchResults.pendingRequest = undefined;
            });
        searchResults.pendingRequest = promise;

        return promise;
    }

    /**
     * helper for searchRoomEvents and backPaginateRoomEventsSearch. Processes the
     * response from the API call and updates the searchResults
     *
     * @returns searchResults
     * @internal
     */
    // XXX: Intended private, used in code
    public processRoomEventsSearch<T extends ISearchResults>(searchResults: T, response: ISearchResponse): T {
        const roomEvents = response.search_categories.room_events;

        searchResults.count = roomEvents.count;
        searchResults.next_batch = roomEvents.next_batch;

        // combine the highlight list with our existing list;
        const highlights = new Set<string>(roomEvents.highlights);
        searchResults.highlights.forEach((hl) => {
            highlights.add(hl);
        });

        // turn it back into a list.
        searchResults.highlights = Array.from(highlights);

        const mapper = this.getEventMapper();

        // append the new results to our existing results
        const resultsLength = roomEvents.results?.length ?? 0;
        for (let i = 0; i < resultsLength; i++) {
            const sr = SearchResult.fromJson(roomEvents.results![i], mapper);
            const room = this.getRoom(sr.context.getEvent().getRoomId());
            if (room) {
                for (const ev of sr.context.getTimeline()) {
                    ev.setMetadata(room.currentState, false);
                }
            }
            searchResults.results.push(sr);
        }
        return searchResults;
    }

    /**
     * Populate the store with rooms the user has left.
     * @returns Promise which resolves: TODO - Resolved when the rooms have
     * been added to the data store.
     * @returns Rejects: with an error response.
     */
    public syncLeftRooms(): Promise<Room[]> {
        // Guard against multiple calls whilst ongoing and multiple calls post success
        if (this.syncedLeftRooms) {
            return Promise.resolve([]); // don't call syncRooms again if it succeeded.
        }
        if (this.syncLeftRoomsPromise) {
            return this.syncLeftRoomsPromise; // return the ongoing request
        }
        const syncApi = new SyncApi(this, this.clientOpts, this.buildSyncApiOptions());
        this.syncLeftRoomsPromise = syncApi.syncLeftRooms();

        // cleanup locks
        this.syncLeftRoomsPromise
            .then(() => {
                this.logger.debug("Marking success of sync left room request");
                this.syncedLeftRooms = true; // flip the bit on success
            })
            .finally(() => {
                this.syncLeftRoomsPromise = undefined; // cleanup ongoing request state
            });

        return this.syncLeftRoomsPromise;
    }

    /**
     * Create a new filter.
     * @param content - The HTTP body for the request
     * @returns Promise which resolves to a Filter object.
     * @returns Rejects: with an error response.
     */
    public createFilter(content: IFilterDefinition): Promise<Filter> {
        const path = utils.encodeUri("/user/$userId/filter", {
            $userId: this.credentials.userId!,
        });
        return this.http.authedRequest<IFilterResponse>(Method.Post, path, undefined, content).then((response) => {
            // persist the filter
            const filter = Filter.fromJson(this.credentials.userId, response.filter_id, content);
            this.store.storeFilter(filter);
            return filter;
        });
    }

    /**
     * Retrieve a filter.
     * @param userId - The user ID of the filter owner
     * @param filterId - The filter ID to retrieve
     * @param allowCached - True to allow cached filters to be returned.
     * Default: True.
     * @returns Promise which resolves: a Filter object
     * @returns Rejects: with an error response.
     */
    public getFilter(userId: string, filterId: string, allowCached: boolean): Promise<Filter> {
        if (allowCached) {
            const filter = this.store.getFilter(userId, filterId);
            if (filter) {
                return Promise.resolve(filter);
            }
        }

        const path = utils.encodeUri("/user/$userId/filter/$filterId", {
            $userId: userId,
            $filterId: filterId,
        });

        return this.http.authedRequest<IFilterDefinition>(Method.Get, path).then((response) => {
            // persist the filter
            const filter = Filter.fromJson(userId, filterId, response);
            this.store.storeFilter(filter);
            return filter;
        });
    }

    /**
     * @returns Filter ID
     */
    public async getOrCreateFilter(filterName: string, filter: Filter): Promise<string> {
        const filterId = this.store.getFilterIdByName(filterName);
        let existingId: string | undefined;

        if (filterId) {
            // check that the existing filter matches our expectations
            try {
                const existingFilter = await this.getFilter(this.credentials.userId!, filterId, true);
                if (existingFilter) {
                    const oldDef = existingFilter.getDefinition();
                    const newDef = filter.getDefinition();

                    if (utils.deepCompare(oldDef, newDef)) {
                        // super, just use that.
                        // debuglog("Using existing filter ID %s: %s", filterId,
                        //          JSON.stringify(oldDef));
                        existingId = filterId;
                    }
                }
            } catch (error) {
                // Synapse currently returns the following when the filter cannot be found:
                // {
                //     errcode: "M_UNKNOWN",
                //     name: "M_UNKNOWN",
                //     message: "No row found",
                // }
                if ((<MatrixError>error).errcode !== "M_UNKNOWN" && (<MatrixError>error).errcode !== "M_NOT_FOUND") {
                    throw error;
                }
            }
            // if the filter doesn't exist anymore on the server, remove from store
            if (!existingId) {
                this.store.setFilterIdByName(filterName, undefined);
            }
        }

        if (existingId) {
            return existingId;
        }

        // create a new filter
        const createdFilter = await this.createFilter(filter.getDefinition());

        this.store.setFilterIdByName(filterName, createdFilter.filterId);
        return createdFilter.filterId!;
    }

    /**
     * Gets a bearer token from the homeserver that the user can
     * present to a third party in order to prove their ownership
     * of the Matrix account they are logged into.
     * @returns Promise which resolves: Token object
     * @returns Rejects: with an error response.
     */
    public getOpenIdToken(): Promise<IOpenIDToken> {
        const path = utils.encodeUri("/user/$userId/openid/request_token", {
            $userId: this.credentials.userId!,
        });

        return this.http.authedRequest(Method.Post, path, undefined, {});
    }

    private startCallEventHandler = (): void => {
        if (this.isInitialSyncComplete()) {
            if (supportsMatrixCall()) {
                this.callEventHandler!.start();
                this.groupCallEventHandler!.start();
            }

            this.off(ClientEvent.Sync, this.startCallEventHandler);
        }
    };

    private startMatrixRTC = (): void => {
        if (this.isInitialSyncComplete()) {
            this.matrixRTC.start();

            this.off(ClientEvent.Sync, this.startMatrixRTC);
        }
    };

    /**
     * Once the client has been initialised, we want to clear notifications we
     * know for a fact should be here.
     * This issue should also be addressed on synapse's side and is tracked as part
     * of https://github.com/matrix-org/synapse/issues/14837
     *
     * We consider a room or a thread as fully read if the current user has sent
     * the last event in the live timeline of that context and if the read receipt
     * we have on record matches.
     */
    private fixupRoomNotifications = (): void => {
        if (this.isInitialSyncComplete()) {
            const unreadRooms = (this.getRooms() ?? []).filter((room) => {
                return room.getUnreadNotificationCount(NotificationCountType.Total) > 0;
            });

            for (const room of unreadRooms) {
                const currentUserId = this.getSafeUserId();
                room.fixupNotifications(currentUserId);
            }

            this.off(ClientEvent.Sync, this.fixupRoomNotifications);
        }
    };

    /**
     * @returns Promise which resolves: ITurnServerResponse object
     * @returns Rejects: with an error response.
     */
    public turnServer(): Promise<ITurnServerResponse> {
        return this.http.authedRequest(Method.Get, "/voip/turnServer");
    }

    /**
     * Get the TURN servers for this homeserver.
     * @returns The servers or an empty list.
     */
    public getTurnServers(): ITurnServer[] {
        return this.turnServers || [];
    }

    /**
     * Get the unix timestamp (in milliseconds) at which the current
     * TURN credentials (from getTurnServers) expire
     * @returns The expiry timestamp in milliseconds
     */
    public getTurnServersExpiry(): number {
        return this.turnServersExpiry;
    }

    public get pollingTurnServers(): boolean {
        return this.checkTurnServersIntervalID !== undefined;
    }

    // XXX: Intended private, used in code.
    public async checkTurnServers(): Promise<boolean | undefined> {
        if (!this.supportsVoip()) {
            return;
        }

        let credentialsGood = false;
        const remainingTime = this.turnServersExpiry - Date.now();
        if (remainingTime > TURN_CHECK_INTERVAL) {
            this.logger.debug("TURN creds are valid for another " + remainingTime + " ms: not fetching new ones.");
            credentialsGood = true;
        } else {
            this.logger.debug("Fetching new TURN credentials");
            try {
                const res = await this.turnServer();
                if (res.uris) {
                    this.logger.debug("Got TURN URIs: " + res.uris + " refresh in " + res.ttl + " secs");
                    // map the response to a format that can be fed to RTCPeerConnection
                    const servers: ITurnServer = {
                        urls: res.uris,
                        username: res.username,
                        credential: res.password,
                    };
                    this.turnServers = [servers];
                    // The TTL is in seconds but we work in ms
                    this.turnServersExpiry = Date.now() + res.ttl * 1000;
                    credentialsGood = true;
                    this.emit(ClientEvent.TurnServers, this.turnServers);
                }
            } catch (err) {
                this.logger.error("Failed to get TURN URIs", err);
                if ((<HTTPError>err).httpStatus === 403) {
                    // We got a 403, so there's no point in looping forever.
                    this.logger.info("TURN access unavailable for this account: stopping credentials checks");
                    if (this.checkTurnServersIntervalID !== null) {
                        globalThis.clearInterval(this.checkTurnServersIntervalID);
                    }
                    this.checkTurnServersIntervalID = undefined;
                    this.emit(ClientEvent.TurnServersError, <HTTPError>err, true); // fatal
                } else {
                    // otherwise, if we failed for whatever reason, try again the next time we're called.
                    this.emit(ClientEvent.TurnServersError, <Error>err, false); // non-fatal
                }
            }
        }

        return credentialsGood;
    }

    /**
     * Set whether to allow a fallback ICE server should be used for negotiating a
     * WebRTC connection if the homeserver doesn't provide any servers. Defaults to
     * false.
     *
     */
    public setFallbackICEServerAllowed(allow: boolean): void {
        this.fallbackICEServerAllowed = allow;
    }

    /**
     * Get whether to allow a fallback ICE server should be used for negotiating a
     * WebRTC connection if the homeserver doesn't provide any servers. Defaults to
     * false.
     *
     * @returns
     */
    public isFallbackICEServerAllowed(): boolean {
        return this.fallbackICEServerAllowed;
    }

    /**
     * Determines if the current user is an administrator of the Synapse homeserver.
     * Returns false if untrue or the homeserver does not appear to be a Synapse
     * homeserver. <strong>This function is implementation specific and may change
     * as a result.</strong>
     * @returns true if the user appears to be a Synapse administrator.
     */
    public isSynapseAdministrator(): Promise<boolean> {
        const path = utils.encodeUri("/_synapse/admin/v1/users/$userId/admin", { $userId: this.getUserId()! });
        return this.http
            .authedRequest<{ admin: boolean }>(Method.Get, path, undefined, undefined, { prefix: "" })
            .then((r) => r.admin); // pull out the specific boolean we want
    }

    /**
     * Performs a whois lookup on a user using Synapse's administrator API.
     * <strong>This function is implementation specific and may change as a
     * result.</strong>
     * @param userId - the User ID to look up.
     * @returns the whois response - see Synapse docs for information.
     */
    public whoisSynapseUser(userId: string): Promise<ISynapseAdminWhoisResponse> {
        const path = utils.encodeUri("/_synapse/admin/v1/whois/$userId", { $userId: userId });
        return this.http.authedRequest(Method.Get, path, undefined, undefined, { prefix: "" });
    }

    /**
     * Deactivates a user using Synapse's administrator API. <strong>This
     * function is implementation specific and may change as a result.</strong>
     * @param userId - the User ID to deactivate.
     * @returns the deactivate response - see Synapse docs for information.
     */
    public deactivateSynapseUser(userId: string): Promise<ISynapseAdminDeactivateResponse> {
        const path = utils.encodeUri("/_synapse/admin/v1/deactivate/$userId", { $userId: userId });
        return this.http.authedRequest(Method.Post, path, undefined, undefined, { prefix: "" });
    }

    protected async fetchClientWellKnown(): Promise<void> {
        // `getRawClientConfig` does not throw or reject on network errors, instead
        // it absorbs errors and returns `{}`.
        this.clientWellKnownPromise = AutoDiscovery.getRawClientConfig(this.getDomain() ?? undefined);
        this.clientWellKnown = await this.clientWellKnownPromise;
        this.emit(ClientEvent.ClientWellKnown, this.clientWellKnown);
    }

    public getClientWellKnown(): IClientWellKnown | undefined {
        return this.clientWellKnown;
    }

    public waitForClientWellKnown(): Promise<IClientWellKnown> {
        if (!this.clientRunning) {
            throw new Error("Client is not running");
        }
        return this.clientWellKnownPromise!;
    }

    /**
     * store client options with boolean/string/numeric values
     * to know in the next session what flags the sync data was
     * created with (e.g. lazy loading)
     * @returns for store operation
     */
    public storeClientOptions(): Promise<void> {
        // XXX: Intended private, used in code
        const primTypes = ["boolean", "string", "number"];
        const serializableOpts = Object.entries(this.clientOpts!)
            .filter(([key, value]) => {
                return primTypes.includes(typeof value);
            })
            .reduce<Record<string, any>>((obj, [key, value]) => {
                obj[key] = value;
                return obj;
            }, {});
        return this.store.storeClientOptions(serializableOpts);
    }

    /**
     * Gets a set of room IDs in common with another user.
     *
     * Note: This endpoint is unstable, and can throw an `Error`.
     *   Check progress on [MSC2666](https://github.com/matrix-org/matrix-spec-proposals/pull/2666) for more details.
     *
     * @param userId - The userId to check.
     * @returns Promise which resolves to an array of rooms
     * @returns Rejects: with an error response.
     */
    // TODO: on spec release, rename this to getMutualRooms
    // eslint-disable-next-line
    public async _unstable_getSharedRooms(userId: string): Promise<string[]> {
        // Initial variant of the MSC
        const sharedRoomsSupport = await this.doesServerSupportUnstableFeature(UNSTABLE_MSC2666_SHARED_ROOMS);

        // Newer variant that renamed shared rooms to mutual rooms
        const mutualRoomsSupport = await this.doesServerSupportUnstableFeature(UNSTABLE_MSC2666_MUTUAL_ROOMS);

        // Latest variant that changed from path elements to query elements
        const queryMutualRoomsSupport = await this.doesServerSupportUnstableFeature(
            UNSTABLE_MSC2666_QUERY_MUTUAL_ROOMS,
        );

        if (!sharedRoomsSupport && !mutualRoomsSupport && !queryMutualRoomsSupport) {
            throw Error("Server does not support the Mutual Rooms API");
        }

        let path;
        let query;

        // Cascading unstable support switching.
        if (queryMutualRoomsSupport) {
            path = "/uk.half-shot.msc2666/user/mutual_rooms";
            query = { user_id: userId };
        } else {
            path = utils.encodeUri(
                `/uk.half-shot.msc2666/user/${mutualRoomsSupport ? "mutual_rooms" : "shared_rooms"}/$userId`,
                { $userId: userId },
            );
            query = {};
        }

        // Accumulated rooms
        const rooms: string[] = [];
        let token = null;

        do {
            const tokenQuery: Record<string, string> = {};
            if (token != null && queryMutualRoomsSupport) {
                tokenQuery["batch_token"] = token;
            }

            const res = await this.http.authedRequest<{
                joined: string[];
                next_batch_token?: string;
            }>(Method.Get, path, { ...query, ...tokenQuery }, undefined, {
                prefix: ClientPrefix.Unstable,
            });

            rooms.push(...res.joined);

            if (res.next_batch_token !== undefined) {
                token = res.next_batch_token;
            } else {
                token = null;
            }
        } while (token != null);

        return rooms;
    }

    /**
     * Get the API versions supported by the server, along with any
     * unstable APIs it supports
     * @returns The server /versions response
     */
    public async getVersions(): Promise<IServerVersions> {
        if (this.serverVersionsPromise) {
            return this.serverVersionsPromise;
        }

        // We send an authenticated request as of MSC4026
        this.serverVersionsPromise = this.http
            .authedRequest<IServerVersions>(Method.Get, "/_matrix/client/versions", undefined, undefined, {
                prefix: "",
            })
            .catch((e) => {
                // Need to unset this if it fails, otherwise we'll never retry
                this.serverVersionsPromise = undefined;
                // but rethrow the exception to anything that was waiting
                throw e;
            });

        const serverVersions = await this.serverVersionsPromise;
        this.canSupport = await buildFeatureSupportMap(serverVersions);

        return this.serverVersionsPromise;
    }

    /**
     * Check if a particular spec version is supported by the server.
     * @param version - The spec version (such as "r0.5.0") to check for.
     * @returns Whether it is supported
     */
    public async isVersionSupported(version: string): Promise<boolean> {
        const { versions } = await this.getVersions();
        return versions && versions.includes(version);
    }

    /**
     * Query the server to see if it lists support for an unstable feature
     * in the /versions response
     * @param feature - the feature name
     * @returns true if the feature is supported
     */
    public async doesServerSupportUnstableFeature(feature: string): Promise<boolean> {
        const response = await this.getVersions();
        if (!response) return false;
        const unstableFeatures = response["unstable_features"];
        return unstableFeatures && !!unstableFeatures[feature];
    }

    /**
     * Query the server to see if it is forcing encryption to be enabled for
     * a given room preset, based on the /versions response.
     * @param presetName - The name of the preset to check.
     * @returns true if the server is forcing encryption
     * for the preset.
     */
    public async doesServerForceEncryptionForPreset(presetName: Preset): Promise<boolean> {
        const response = await this.getVersions();
        if (!response) return false;
        const unstableFeatures = response["unstable_features"];

        // The preset name in the versions response will be without the _chat suffix.
        const versionsPresetName = presetName.includes("_chat")
            ? presetName.substring(0, presetName.indexOf("_chat"))
            : presetName;

        return unstableFeatures && !!unstableFeatures[`io.element.e2ee_forced.${versionsPresetName}`];
    }

    public async doesServerSupportThread(): Promise<{
        threads: FeatureSupport;
        list: FeatureSupport;
        fwdPagination: FeatureSupport;
    }> {
        if (await this.isVersionSupported("v1.4")) {
            return {
                threads: FeatureSupport.Stable,
                list: FeatureSupport.Stable,
                fwdPagination: FeatureSupport.Stable,
            };
        }

        try {
            const [threadUnstable, threadStable, listUnstable, listStable, fwdPaginationUnstable, fwdPaginationStable] =
                await Promise.all([
                    this.doesServerSupportUnstableFeature("org.matrix.msc3440"),
                    this.doesServerSupportUnstableFeature("org.matrix.msc3440.stable"),
                    this.doesServerSupportUnstableFeature("org.matrix.msc3856"),
                    this.doesServerSupportUnstableFeature("org.matrix.msc3856.stable"),
                    this.doesServerSupportUnstableFeature("org.matrix.msc3715"),
                    this.doesServerSupportUnstableFeature("org.matrix.msc3715.stable"),
                ]);

            return {
                threads: determineFeatureSupport(threadStable, threadUnstable),
                list: determineFeatureSupport(listStable, listUnstable),
                fwdPagination: determineFeatureSupport(fwdPaginationStable, fwdPaginationUnstable),
            };
        } catch {
            return {
                threads: FeatureSupport.None,
                list: FeatureSupport.None,
                fwdPagination: FeatureSupport.None,
            };
        }
    }

    /**
     * Get if lazy loading members is being used.
     * @returns Whether or not members are lazy loaded by this client
     */
    public hasLazyLoadMembersEnabled(): boolean {
        return !!this.clientOpts?.lazyLoadMembers;
    }

    /**
     * Set a function which is called when /sync returns a 'limited' response.
     * It is called with a room ID and returns a boolean. It should return 'true' if the SDK
     * can SAFELY remove events from this room. It may not be safe to remove events if there
     * are other references to the timelines for this room, e.g because the client is
     * actively viewing events in this room.
     * Default: returns false.
     * @param cb - The callback which will be invoked.
     */
    public setCanResetTimelineCallback(cb: ResetTimelineCallback): void {
        this.canResetTimelineCallback = cb;
    }

    /**
     * Get the callback set via `setCanResetTimelineCallback`.
     * @returns The callback or null
     */
    public getCanResetTimelineCallback(): ResetTimelineCallback | undefined {
        return this.canResetTimelineCallback;
    }

    /**
     * Returns relations for a given event. Handles encryption transparently,
     * with the caveat that the amount of events returned might be 0, even though you get a nextBatch.
     * When the returned promise resolves, all messages should have finished trying to decrypt.
     * @param roomId - the room of the event
     * @param eventId - the id of the event
     * @param relationType - the rel_type of the relations requested
     * @param eventType - the event type of the relations requested
     * @param opts - options with optional values for the request.
     * @returns an object with `events` as `MatrixEvent[]` and optionally `nextBatch` if more relations are available.
     */
    public async relations(
        roomId: string,
        eventId: string,
        relationType: RelationType | string | null,
        eventType?: EventType | string | null,
        opts: IRelationsRequestOpts = { dir: Direction.Backward },
    ): Promise<{
        originalEvent?: MatrixEvent | null;
        events: MatrixEvent[];
        nextBatch?: string | null;
        prevBatch?: string | null;
    }> {
        const fetchedEventType = eventType ? this.getEncryptedIfNeededEventType(roomId, eventType) : null;
        const [eventResult, result] = await Promise.all([
            this.fetchRoomEvent(roomId, eventId),
            this.fetchRelations(roomId, eventId, relationType, fetchedEventType, opts),
        ]);
        const mapper = this.getEventMapper();

        const originalEvent = eventResult ? mapper(eventResult) : undefined;
        let events = result.chunk.map(mapper);

        if (fetchedEventType === EventType.RoomMessageEncrypted) {
            const allEvents = originalEvent ? events.concat(originalEvent) : events;
            await Promise.all(allEvents.map((e) => this.decryptEventIfNeeded(e)));
            if (eventType !== null) {
                events = events.filter((e) => e.getType() === eventType);
            }
        }

        if (originalEvent && relationType === RelationType.Replace) {
            events = events.filter((e) => e.getSender() === originalEvent.getSender());
        }
        return {
            originalEvent: originalEvent ?? null,
            events,
            nextBatch: result.next_batch ?? null,
            prevBatch: result.prev_batch ?? null,
        };
    }

    /**
     * Generates a random string suitable for use as a client secret. <strong>This
     * method is experimental and may change.</strong>
     * @returns A new client secret
     */
    public generateClientSecret(): string {
        return secureRandomString(32);
    }

    /**
     * Attempts to decrypt an event
     * @param event - The event to decrypt
     * @returns A decryption promise
     */
    public decryptEventIfNeeded(event: MatrixEvent, options?: IDecryptOptions): Promise<void> {
        if (event.isState() && !this.enableEncryptedStateEvents) {
            return Promise.resolve();
        }

        if (event.shouldAttemptDecryption() && this.getCrypto()) {
            event.attemptDecryption(this.cryptoBackend!, options);
        }

        if (event.isBeingDecrypted()) {
            return event.getDecryptionPromise()!;
        } else {
            return Promise.resolve();
        }
    }

    private termsUrlForService(serviceType: SERVICE_TYPES, baseUrl: string): URL {
        switch (serviceType) {
            case SERVICE_TYPES.IS:
                return this.http.getUrl("/terms", undefined, IdentityPrefix.V2, baseUrl);
            case SERVICE_TYPES.IM:
                return this.http.getUrl("/terms", undefined, "/_matrix/integrations/v1", baseUrl);
            default:
                throw new Error("Unsupported service type");
        }
    }

    /**
     * Get the Homeserver URL of this client
     * @returns Homeserver URL of this client
     */
    public getHomeserverUrl(): string {
        return this.baseUrl;
    }

    /**
     * Get the identity server URL of this client
     * @param stripProto - whether or not to strip the protocol from the URL
     * @returns Identity server URL of this client
     */
    public getIdentityServerUrl(stripProto = false): string | undefined {
        if (stripProto && (this.idBaseUrl?.startsWith("http://") || this.idBaseUrl?.startsWith("https://"))) {
            return this.idBaseUrl.split("://")[1];
        }
        return this.idBaseUrl;
    }

    /**
     * Set the identity server URL of this client
     * @param url - New identity server URL
     */
    public setIdentityServerUrl(url?: string): void {
        this.idBaseUrl = utils.ensureNoTrailingSlash(url);
        this.http.setIdBaseUrl(this.idBaseUrl);
    }

    /**
     * Get the access token associated with this account.
     * @returns The access_token or null
     */
    public getAccessToken(): string | null {
        return this.http.opts.accessToken || null;
    }

    /**
     * Get the refresh token associated with this account.
     * @returns The refresh_token or null
     */
    public getRefreshToken(): string | null {
        return this.http.opts.refreshToken ?? null;
    }

    /**
     * Set the access token associated with this account.
     * @param token - The new access token.
     */
    public setAccessToken(token: string): void {
        this.http.opts.accessToken = token;
        // The /versions response can vary for different users so clear the cache
        this.serverVersionsPromise = undefined;
    }

    /**
     * @returns true if there is a valid access_token for this client.
     */
    public isLoggedIn(): boolean {
        return this.http.opts.accessToken !== undefined;
    }

    /**
     * Make up a new transaction id
     *
     * @returns a new, unique, transaction id
     */
    public makeTxnId(): string {
        return "m" + new Date().getTime() + "." + this.txnCtr++;
    }

    /**
     * Check whether a username is available prior to registration. An error response
     * indicates an invalid/unavailable username.
     * @param username - The username to check the availability of.
     * @returns Promise which resolves: to boolean of whether the username is available.
     */
    public isUsernameAvailable(username: string): Promise<boolean> {
        return this.http
            .authedRequest<{ available: true }>(Method.Get, "/register/available", { username })
            .then((response) => {
                return response.available;
            })
            .catch((response) => {
                if (response.errcode === "M_USER_IN_USE") {
                    return false;
                }
                return Promise.reject(response);
            });
    }

    /**
     * @param bindThreepids - Set key 'email' to true to bind any email
     *     threepid uses during registration in the identity server. Set 'msisdn' to
     *     true to bind msisdn.
     * @returns Promise which resolves to a RegisterResponse object
     * @returns Rejects: with an error response.
     */
    public register(
        username: string,
        password: string,
        sessionId: string | null,
        auth: { session?: string; type: string },
        bindThreepids?: { email?: boolean; msisdn?: boolean },
        guestAccessToken?: string,
        inhibitLogin?: boolean,
    ): Promise<RegisterResponse> {
        if (sessionId) {
            auth.session = sessionId;
        }

        const params: RegisterRequest = {
            auth: auth,
            refresh_token: true, // always ask for a refresh token - does nothing if unsupported
        };
        if (username !== undefined && username !== null) {
            params.username = username;
        }
        if (password !== undefined && password !== null) {
            params.password = password;
        }
        if (guestAccessToken !== undefined && guestAccessToken !== null) {
            params.guest_access_token = guestAccessToken;
        }
        if (inhibitLogin !== undefined && inhibitLogin !== null) {
            params.inhibit_login = inhibitLogin;
        }

        return this.registerRequest(params);
    }

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
     * @param body - JSON HTTP body to provide.
     * @returns Promise which resolves: JSON object that contains:
     *                   `{ user_id, device_id, access_token, home_server }`
     * @returns Rejects: with an error response.
     */
    public registerGuest({ body }: { body?: RegisterRequest } = {}): Promise<RegisterResponse> {
        return this.registerRequest(body || {}, "guest");
    }

    /**
     * @param data - parameters for registration request
     * @param kind - type of user to register. may be "guest"
     * @returns Promise which resolves: to the /register response
     * @returns Rejects: with an error response.
     */
    public registerRequest(data: RegisterRequest, kind?: string): Promise<RegisterResponse> {
        const params: { kind?: string } = {};
        if (kind) {
            params.kind = kind;
        }

        return this.http.request(Method.Post, "/register", params, data);
    }

    /**
     * Refreshes an access token using a provided refresh token. The refresh token
     * must be valid for the current access token known to the client instance.
     *
     * Note that this function will not cause a logout if the token is deemed
     * unknown by the server - the caller is responsible for managing logout
     * actions on error.
     * @param refreshToken - The refresh token.
     * @returns Promise which resolves to the new token.
     * @returns Rejects with an error response.
     */
    public refreshToken(refreshToken: string): Promise<IRefreshTokenResponse> {
        const performRefreshRequestWithPrefix = (prefix: ClientPrefix): Promise<IRefreshTokenResponse> =>
            this.http.authedRequest(
                Method.Post,
                "/refresh",
                undefined,
                { refresh_token: refreshToken },
                {
                    prefix,
                    inhibitLogoutEmit: true, // we don't want to cause logout loops
                },
            );

        // First try with the (specced) /v3/ prefix.
        // However, before Synapse 1.72.0, Synapse incorrectly required a /v1/ prefix, so we fall
        // back to that if the request fails, for backwards compatibility.
        return performRefreshRequestWithPrefix(ClientPrefix.V3).catch((e) => {
            if (e.errcode === "M_UNRECOGNIZED") {
                return performRefreshRequestWithPrefix(ClientPrefix.V1);
            }
            throw e;
        });
    }

    /**
     * @returns Promise which resolves to the available login flows
     * @returns Rejects: with an error response.
     */
    public loginFlows(): Promise<ILoginFlowsResponse> {
        return this.http.request(Method.Get, "/login");
    }

    /**
     * @returns Promise which resolves to a LoginResponse object
     * @returns Rejects: with an error response.
     *
     * @deprecated This method has unintuitive behaviour: it updates the `MatrixClient` instance with *some* of the
     *    returned credentials. Instead, call {@link loginRequest} and create a new `MatrixClient` instance using the
     *    results. See https://github.com/matrix-org/matrix-js-sdk/issues/4502.
     */
    public login(loginType: LoginRequest["type"], data: Omit<LoginRequest, "type">): Promise<LoginResponse> {
        return this.loginRequest({
            ...data,
            type: loginType,
        }).then((response) => {
            if (response.access_token && response.user_id) {
                this.http.opts.accessToken = response.access_token;
                this.credentials = {
                    userId: response.user_id,
                };
            }
            return response;
        });
    }

    /**
     * @returns Promise which resolves to a LoginResponse object
     * @returns Rejects: with an error response.
     *
     * @deprecated This method has unintuitive behaviour: it updates the `MatrixClient` instance with *some* of the
     *   returned credentials. Instead, call {@link loginRequest} with `data.type: "m.login.password"`, and create a new
     *   `MatrixClient` instance using the results. See https://github.com/matrix-org/matrix-js-sdk/issues/4502.
     */
    public loginWithPassword(user: string, password: string): Promise<LoginResponse> {
        return this.login("m.login.password", {
            user: user,
            password: password,
        });
    }

    /**
     * @param redirectUrl - The URL to redirect to after the HS
     * authenticates with CAS.
     * @returns The HS URL to hit to begin the CAS login process.
     */
    public getCasLoginUrl(redirectUrl: string): string {
        return this.getSsoLoginUrl(redirectUrl, "cas");
    }

    /**
     * @param redirectUrl - The URL to redirect to after the HS
     *     authenticates with the SSO.
     * @param loginType - The type of SSO login we are doing (sso or cas).
     *     Defaults to 'sso'.
     * @param idpId - The ID of the Identity Provider being targeted, optional.
     * @param action - the SSO flow to indicate to the IdP, optional.
     * @returns The HS URL to hit to begin the SSO login process.
     */
    public getSsoLoginUrl(redirectUrl: string, loginType = "sso", idpId?: string, action?: SSOAction): string {
        let url = "/login/" + loginType + "/redirect";
        if (idpId) {
            url += "/" + idpId;
        }

        const params = {
            redirectUrl,
            [SSO_ACTION_PARAM.unstable!]: action,
        };

        return this.http.getUrl(url, params).href;
    }

    /**
     * @param token - Login token previously received from homeserver
     * @returns Promise which resolves to a LoginResponse object
     * @returns Rejects: with an error response.
     *
     * @deprecated This method has unintuitive behaviour: it updates the `MatrixClient` instance with *some* of the
     *   returned credentials. Instead, call {@link loginRequest} with `data.type: "m.login.token"`, and create a new
     *   `MatrixClient` instance using the results. See https://github.com/matrix-org/matrix-js-sdk/issues/4502.
     */
    public loginWithToken(token: string): Promise<LoginResponse> {
        return this.login("m.login.token", {
            token: token,
        });
    }

    /**
     * Sends a `POST /login` request to the server.
     *
     * If successful, this will create a new device and access token for the user.
     *
     * @see {@link MatrixClient.loginFlows} which makes a `GET /login` request.
     * @see https://spec.matrix.org/v1.13/client-server-api/#post_matrixclientv3login
     *
     * @param data - Credentials and other details for the login request.
     */
    public async loginRequest(data: LoginRequest): Promise<LoginResponse> {
        return await this.http.authedRequest<LoginResponse>(Method.Post, "/login", undefined, data);
    }

    /**
     * Logs out the current session.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param stopClient - whether to stop the client before calling /logout to prevent invalid token errors.
     * @returns Promise which resolves: On success, the empty object `{}`
     */
    public async logout(stopClient = false): Promise<EmptyObject> {
        if (stopClient) {
            this.stopClient();
            this.http.abort();
        }

        return this.http.authedRequest(Method.Post, "/logout");
    }

    /**
     * Deactivates the logged-in account.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param auth - Optional. Auth data to supply for User-Interactive auth.
     * @param erase - Optional. If set, send as `erase` attribute in the
     * JSON request body, indicating whether the account should be erased. Defaults
     * to false.
     * @returns Promise which resolves: On success, the empty object
     */
    public deactivateAccount(
        auth?: AuthDict,
        erase?: boolean,
    ): Promise<{ id_server_unbind_result: IdServerUnbindResult }> {
        const body: Body = {};
        if (auth) {
            body.auth = auth;
        }
        if (erase !== undefined) {
            body.erase = erase;
        }

        return this.http.authedRequest(Method.Post, "/account/deactivate", undefined, body);
    }

    /**
     * Make a request for an `m.login.token` to be issued as per
     * https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv1loginget_token
     *
     * The server may require User-Interactive auth.
     *
     * @param auth - Optional. Auth data to supply for User-Interactive auth.
     * @returns Promise which resolves: On success, the token response
     * or UIA auth data.
     */
    public async requestLoginToken(auth?: AuthDict): Promise<LoginTokenPostResponse> {
        const body: UIARequest<unknown> = { auth };
        return this.http.authedRequest<LoginTokenPostResponse>(
            Method.Post,
            "/login/get_token",
            undefined, // no query params
            body,
            { prefix: ClientPrefix.V1 },
        );
    }

    /**
     * Get the fallback URL to use for unknown interactive-auth stages.
     *
     * @param loginType -     the type of stage being attempted
     * @param authSessionId - the auth session ID provided by the homeserver
     *
     * @returns HS URL to hit to for the fallback interface
     */
    public getFallbackAuthUrl(loginType: string, authSessionId: string): string {
        const path = utils.encodeUri("/auth/$loginType/fallback/web", {
            $loginType: loginType,
        });

        return this.http.getUrl(path, {
            session: authSessionId,
        }).href;
    }

    /**
     * Create a new room.
     * @param options - a list of options to pass to the /createRoom API.
     * @returns Promise which resolves: `{room_id: {string}}`
     * @returns Rejects: with an error response.
     */
    public async createRoom(options: ICreateRoomOpts): Promise<{ room_id: string }> {
        // eslint-disable-line camelcase
        // some valid options include: room_alias_name, visibility, invite

        // inject the id_access_token if inviting 3rd party addresses
        const invitesNeedingToken = (options.invite_3pid || []).filter((i) => !i.id_access_token);
        if (invitesNeedingToken.length > 0 && this.identityServer?.getAccessToken) {
            const identityAccessToken = await this.identityServer.getAccessToken();
            if (identityAccessToken) {
                for (const invite of invitesNeedingToken) {
                    invite.id_access_token = identityAccessToken;
                }
            }
        }

        return this.http.authedRequest(Method.Post, "/createRoom", undefined, options);
    }

    /**
     * Fetches relations for a given event
     * @param roomId - the room of the event
     * @param eventId - the id of the event
     * @param relationType - the rel_type of the relations requested
     * @param eventType - the event type of the relations requested
     * @param opts - options with optional values for the request.
     * @returns the response, with chunk, prev_batch and, next_batch.
     */
    public fetchRelations(
        roomId: string,
        eventId: string,
        relationType: RelationType | string | null,
        eventType?: EventType | string | null,
        opts: IRelationsRequestOpts = { dir: Direction.Backward },
    ): Promise<IRelationsResponse> {
        let params = opts as QueryDict;
        if (Thread.hasServerSideFwdPaginationSupport === FeatureSupport.Experimental) {
            params = replaceParam("dir", "org.matrix.msc3715.dir", params);
        }
        if (this.canSupport.get(Feature.RelationsRecursion) === ServerSupport.Unstable) {
            params = replaceParam("recurse", "org.matrix.msc3981.recurse", params);
        }
        const queryString = utils.encodeParams(params);

        let templatedUrl = "/rooms/$roomId/relations/$eventId";
        if (relationType !== null) {
            templatedUrl += "/$relationType";
            if (eventType !== null) {
                templatedUrl += "/$eventType";
            }
        } else if (eventType !== null) {
            this.logger.warn(`eventType: ${eventType} ignored when fetching
            relations as relationType is null`);
            eventType = null;
        }

        const path = utils.encodeUri(templatedUrl + "?" + queryString, {
            $roomId: roomId,
            $eventId: eventId,
            $relationType: relationType!,
            $eventType: eventType!,
        });
        return this.http.authedRequest(Method.Get, path, undefined, undefined, {
            prefix: ClientPrefix.V1,
        });
    }

    /**
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public roomState(roomId: string): Promise<IStateEventWithRoomId[]> {
        const path = utils.encodeUri("/rooms/$roomId/state", { $roomId: roomId });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Get an event in a room by its event id.
     *
     * @returns Promise which resolves to an object containing the event.
     * @returns Rejects: with an error response.
     */
    public fetchRoomEvent(roomId: string, eventId: string): Promise<Partial<IEvent>> {
        const path = utils.encodeUri("/rooms/$roomId/event/$eventId", {
            $roomId: roomId,
            $eventId: eventId,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * @param includeMembership - the membership type to include in the response
     * @param excludeMembership - the membership type to exclude from the response
     * @param atEventId - the id of the event for which moment in the timeline the members should be returned for
     * @returns Promise which resolves: dictionary of userid to profile information
     * @returns Rejects: with an error response.
     */
    public members(
        roomId: string,
        includeMembership?: string,
        excludeMembership?: string,
        atEventId?: string,
    ): Promise<{ [userId: string]: IStateEventWithRoomId[] }> {
        const queryParams: Record<string, string> = {};
        if (includeMembership) {
            queryParams.membership = includeMembership;
        }
        if (excludeMembership) {
            queryParams.not_membership = excludeMembership;
        }
        if (atEventId) {
            queryParams.at = atEventId;
        }

        const queryString = utils.encodeParams(queryParams);

        const path = utils.encodeUri("/rooms/$roomId/members?" + queryString, { $roomId: roomId });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Upgrades a room to a new protocol version
     * @param newVersion - The target version to upgrade to
     * @returns Promise which resolves: Object with key 'replacement_room'
     * @returns Rejects: with an error response.
     */
    public upgradeRoom(roomId: string, newVersion: string): Promise<{ replacement_room: string }> {
        // eslint-disable-line camelcase
        const path = utils.encodeUri("/rooms/$roomId/upgrade", { $roomId: roomId });
        return this.http.authedRequest(Method.Post, path, undefined, { new_version: newVersion });
    }

    /**
     * Retrieve a state event.
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public getStateEvent(roomId: string, eventType: string, stateKey: string): Promise<Record<string, any>> {
        const pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey,
        };
        let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Send a state event into a room
     * @param roomId - ID of the room to send the event into
     * @param eventType - type of the state event to send
     * @param content - content of the event to send
     * @param stateKey - the stateKey to send into the room
     * @param opts - Options for the request function.
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public async sendStateEvent<K extends keyof StateEvents>(
        roomId: string,
        eventType: K,
        content: StateEvents[K],
        stateKey = "",
        opts: IRequestOpts = {},
    ): Promise<ISendEventResponse> {
        const room = this.getRoom(roomId);
        const event = new MatrixEvent({
            room_id: roomId,
            type: eventType,
            state_key: stateKey,
            // Cast safety: StateEvents[K] is a stronger bound than IContent, which has [key: string]: any
            content: content as IContent,
        });

        await this.encryptStateEventIfNeeded(event, room ?? undefined);

        const pathParams = {
            $roomId: roomId,
            $eventType: event.getWireType(),
            $stateKey: event.getWireStateKey(),
        };
        let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this.http.authedRequest(Method.Put, path, undefined, event.getWireContent(), opts);
    }

    private async encryptStateEventIfNeeded(event: MatrixEvent, room?: Room): Promise<void> {
        if (!this.enableEncryptedStateEvents) {
            return;
        }

        // If the room is unknown, we cannot encrypt for it
        if (!room) return;

        if (!this.cryptoBackend && this.usingExternalCrypto) {
            // The client has opted to allow sending messages to encrypted
            // rooms even if the room is encrypted, and we haven't set up
            // crypto. This is useful for users of matrix-org/pantalaimon
            return;
        }

        if (!this.cryptoBackend) {
            throw new Error("This room is configured to use encryption, but your client does not support encryption.");
        }

        // Check regular encryption conditions.
        if (!(await this.shouldEncryptEventForRoom(event, room))) {
            return;
        }

        // If the crypto impl thinks we shouldn't encrypt, then we shouldn't.
        // Safety: we checked the crypto impl exists above.
        if (!(await this.cryptoBackend!.isStateEncryptionEnabledInRoom(room.roomId))) {
            return;
        }

        // Check if the event is excluded under MSC4362
        if (
            [
                "m.room.create",
                "m.room.member",
                "m.room.join_rules",
                "m.room.power_levels",
                "m.room.third_party_invite",
                "m.room.history_visibility",
                "m.room.guest_access",
                "m.room.encryption",
            ].includes(event.getType())
        ) {
            return;
        }

        await this.cryptoBackend.encryptEvent(event, room);
    }

    /**
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public roomInitialSync(roomId: string, limit: number): Promise<IRoomInitialSyncResponse> {
        const path = utils.encodeUri("/rooms/$roomId/initialSync", { $roomId: roomId });

        return this.http.authedRequest(Method.Get, path, { limit: limit?.toString() ?? "30" });
    }

    /**
     * Set a marker to indicate the point in a room before which the user has read every
     * event. This can be retrieved from room account data (the event type is `m.fully_read`)
     * and displayed as a horizontal line in the timeline that is visually distinct to the
     * position of the user's own read receipt.
     * @param roomId - ID of the room that has been read
     * @param rmEventId - ID of the event that has been read
     * @param rrEventId - ID of the event tracked by the read receipt. This is here
     * for convenience because the RR and the RM are commonly updated at the same time as
     * each other. Optional.
     * @param rpEventId - rpEvent the m.read.private read receipt event for when we
     * don't want other users to see the read receipts. This is experimental. Optional.
     * @returns Promise which resolves: the empty object, `{}`.
     */
    public async setRoomReadMarkersHttpRequest(
        roomId: string,
        rmEventId: string,
        rrEventId?: string,
        rpEventId?: string,
    ): Promise<EmptyObject> {
        const path = utils.encodeUri("/rooms/$roomId/read_markers", {
            $roomId: roomId,
        });

        const content: IContent = {
            [ReceiptType.FullyRead]: rmEventId,
            [ReceiptType.Read]: rrEventId,
        };

        if (
            (await this.doesServerSupportUnstableFeature("org.matrix.msc2285.stable")) ||
            (await this.isVersionSupported("v1.4"))
        ) {
            content[ReceiptType.ReadPrivate] = rpEventId;
        }

        return this.http.authedRequest(Method.Post, path, undefined, content);
    }

    /**
     * @returns Promise which resolves: A list of the user's current rooms
     * @returns Rejects: with an error response.
     */
    public getJoinedRooms(): Promise<IJoinedRoomsResponse> {
        const path = utils.encodeUri("/joined_rooms", {});
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Retrieve membership info. for a room.
     * @param roomId - ID of the room to get membership for
     * @returns Promise which resolves: A list of currently joined users
     *                                 and their profile data.
     * @returns Rejects: with an error response.
     */
    public getJoinedRoomMembers(roomId: string): Promise<IJoinedMembersResponse> {
        const path = utils.encodeUri("/rooms/$roomId/joined_members", {
            $roomId: roomId,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * @param params - Options for this request
     * @returns Promise which resolves: IPublicRoomsResponse
     * @returns Rejects: with an error response.
     */
    public publicRooms({
        server,
        limit,
        since,
        ...options
    }: IRoomDirectoryOptions = {}): Promise<IPublicRoomsResponse> {
        if (Object.keys(options).length === 0) {
            const queryParams: QueryDict = { server, limit, since };
            return this.http.authedRequest(Method.Get, "/publicRooms", queryParams);
        } else {
            const queryParams: QueryDict = { server };
            const body = {
                limit,
                since,
                ...options,
            };
            return this.http.authedRequest(Method.Post, "/publicRooms", queryParams, body);
        }
    }

    /**
     * Create an alias to room ID mapping.
     * @param alias - The room alias to create.
     * @param roomId - The room ID to link the alias to.
     * @returns Promise which resolves: an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public createAlias(alias: string, roomId: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        const data = {
            room_id: roomId,
        };
        return this.http.authedRequest(Method.Put, path, undefined, data);
    }

    /**
     * Delete an alias to room ID mapping. This alias must be on your local server,
     * and you must have sufficient access to do this operation.
     * @param alias - The room alias to delete.
     * @returns Promise which resolves: an empty object `{}`.
     * @returns Rejects: with an error response.
     */
    public deleteAlias(alias: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        return this.http.authedRequest(Method.Delete, path);
    }

    /**
     * Gets the local aliases for the room. Note: this includes all local aliases, unlike the
     * curated list from the m.room.canonical_alias state event.
     * @param roomId - The room ID to get local aliases for.
     * @returns Promise which resolves: an object with an `aliases` property, containing an array of local aliases
     * @returns Rejects: with an error response.
     */
    public getLocalAliases(roomId: string): Promise<{ aliases: string[] }> {
        const path = utils.encodeUri("/rooms/$roomId/aliases", { $roomId: roomId });
        const prefix = ClientPrefix.V3;
        return this.http.authedRequest(Method.Get, path, undefined, undefined, { prefix });
    }

    /**
     * Get room info for the given alias.
     * @param alias - The room alias to resolve.
     * @returns Promise which resolves: Object with room_id and servers.
     * @returns Rejects: with an error response.
     */
    public getRoomIdForAlias(alias: string): Promise<{ room_id: string; servers: string[] }> {
        // eslint-disable-line camelcase
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Get the visibility of a room in the current HS's room directory
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public getRoomDirectoryVisibility(roomId: string): Promise<{ visibility: Visibility }> {
        const path = utils.encodeUri("/directory/list/room/$roomId", {
            $roomId: roomId,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Set the visibility of a room in the current HS's room directory
     * @param visibility - "public" to make the room visible
     *                 in the public directory, or "private" to make
     *                 it invisible.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public setRoomDirectoryVisibility(roomId: string, visibility: Visibility): Promise<EmptyObject> {
        const path = utils.encodeUri("/directory/list/room/$roomId", {
            $roomId: roomId,
        });
        return this.http.authedRequest(Method.Put, path, undefined, { visibility });
    }

    /**
     * Query the user directory with a term matching user IDs, display names and domains.
     * @param options
     * @param options.term - the term with which to search.
     * @param options.limit - the maximum number of results to return. The server will apply a limit if unspecified.
     * @returns Promise which resolves: an array of results.
     */
    public searchUserDirectory({ term, limit }: { term: string; limit?: number }): Promise<IUserDirectoryResponse> {
        const body: Body = {
            search_term: term,
        };

        if (limit !== undefined) {
            body.limit = limit;
        }

        return this.http.authedRequest(Method.Post, "/user_directory/search", undefined, body);
    }

    /**
     * Upload a file to the media repository on the homeserver.
     *
     * @param file - The object to upload. On a browser, something that
     *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
     *   a a Buffer, String or ReadStream.
     *
     * @param opts -  options object
     *
     * @returns Promise which resolves to response object, or rejects with an error (usually a MatrixError).
     */
    public uploadContent(file: FileType, opts?: UploadOpts): Promise<UploadResponse> {
        return this.http.uploadContent(file, opts);
    }

    /**
     * Cancel a file upload in progress
     * @param upload - The object returned from uploadContent
     * @returns true if canceled, otherwise false
     */
    public cancelUpload(upload: Promise<UploadResponse>): boolean {
        return this.http.cancelUpload(upload);
    }

    /**
     * Get a list of all file uploads in progress
     * @returns Array of objects representing current uploads.
     * Currently in progress is element 0. Keys:
     *  - promise: The promise associated with the upload
     *  - loaded: Number of bytes uploaded
     *  - total: Total number of bytes to upload
     */
    public getCurrentUploads(): Upload[] {
        return this.http.getCurrentUploads();
    }

    /**
     * @param info - The kind of info to retrieve (e.g. 'displayname',
     * 'avatar_url').
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     */
    public getProfileInfo(
        userId: string,
        info?: string,
        // eslint-disable-next-line camelcase
    ): Promise<{ avatar_url?: string; displayname?: string }> {
        const path = info
            ? utils.encodeUri("/profile/$userId/$info", { $userId: userId, $info: info })
            : utils.encodeUri("/profile/$userId", { $userId: userId });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Determine if the server supports extended profiles, as described by MSC4133.
     *
     * @returns `true` if supported, otherwise `false`
     */
    public async doesServerSupportExtendedProfiles(): Promise<boolean> {
        return (
            (await this.isVersionSupported("v1.16")) ||
            (await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4133_EXTENDED_PROFILES)) ||
            (await this.doesServerSupportUnstableFeature(STABLE_MSC4133_EXTENDED_PROFILES))
        );
    }

    /**
     * Get the prefix used for extended profile requests.
     *
     * @returns The prefix for use with `authedRequest`
     */
    private async getExtendedProfileRequestPrefix(): Promise<string> {
        if (
            (await this.isVersionSupported("v1.16")) ||
            (await this.doesServerSupportUnstableFeature("uk.tcpip.msc4133.stable"))
        ) {
            return ClientPrefix.V3;
        }
        return "/_matrix/client/unstable/uk.tcpip.msc4133";
    }

    /**
     * Fetch a user's *extended* profile, which may include additional keys.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param userId The user ID to fetch the profile of.
     * @returns A set of keys to property values.
     *
     * @throws An error if the server does not support MSC4133.
     * @throws A M_NOT_FOUND error if the profile could not be found.
     */
    public async getExtendedProfile(userId: string): Promise<Record<string, unknown>> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        return this.http.authedRequest(
            Method.Get,
            utils.encodeUri("/profile/$userId", { $userId: userId }),
            undefined,
            undefined,
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        );
    }

    /**
     * Fetch a specific key from the user's *extended* profile.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param userId The user ID to fetch the profile of.
     * @param key The key of the property to fetch.
     * @returns The property value.
     *
     * @throws An error if the server does not support MSC4133.
     * @throws A M_NOT_FOUND error if the key was not set OR the profile could not be found.
     */
    public async getExtendedProfileProperty(userId: string, key: string): Promise<unknown> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        const profile = (await this.http.authedRequest(
            Method.Get,
            utils.encodeUri("/profile/$userId/$key", { $userId: userId, $key: key }),
            undefined,
            undefined,
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        )) as Record<string, unknown>;
        return profile[key];
    }

    /**
     * Set a property on your *extended* profile.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param key The key of the property to set.
     * @param value The value to set on the property.
     *
     * @throws An error if the server does not support MSC4133 OR the server disallows editing the user profile.
     */
    public async setExtendedProfileProperty(key: string, value: unknown): Promise<void> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        const userId = this.getUserId();

        await this.http.authedRequest(
            Method.Put,
            utils.encodeUri("/profile/$userId/$key", { $userId: userId, $key: key }),
            undefined,
            { [key]: value },
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        );
    }

    /**
     * Delete a property on your *extended* profile.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param key The key of the property to delete.
     *
     * @throws An error if the server does not support MSC4133 OR the server disallows editing the user profile.
     */
    public async deleteExtendedProfileProperty(key: string): Promise<void> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        const userId = this.getUserId();

        await this.http.authedRequest(
            Method.Delete,
            utils.encodeUri("/profile/$userId/$key", { $userId: userId, $key: key }),
            undefined,
            undefined,
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        );
    }

    /**
     * Update multiple properties on your *extended* profile. This will
     * merge with any existing keys.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param profile The profile object to merge with the existing profile.
     * @returns The newly merged profile.
     *
     * @throws An error if the server does not support MSC4133 OR the server disallows editing the user profile.
     */
    public async patchExtendedProfile(profile: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        const userId = this.getUserId();

        return this.http.authedRequest(
            Method.Patch,
            utils.encodeUri("/profile/$userId", { $userId: userId }),
            {},
            profile,
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        );
    }

    /**
     * Set multiple properties on your *extended* profile. This will completely
     * replace the existing profile, removing any unspecified keys.
     *
     * @see https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md
     * @param profile The profile object to set.
     *
     * @throws An error if the server does not support MSC4133 OR the server disallows editing the user profile.
     */
    public async setExtendedProfile(profile: Record<string, unknown>): Promise<void> {
        if (!(await this.doesServerSupportExtendedProfiles())) {
            throw new Error("Server does not support extended profiles");
        }
        const userId = this.getUserId();

        await this.http.authedRequest(
            Method.Put,
            utils.encodeUri("/profile/$userId", { $userId: userId }),
            {},
            profile,
            {
                prefix: await this.getExtendedProfileRequestPrefix(),
            },
        );
    }

    /**
     * @returns Promise which resolves to a list of the user's threepids.
     * @returns Rejects: with an error response.
     */
    public getThreePids(): Promise<{ threepids: IThreepid[] }> {
        return this.http.authedRequest(Method.Get, "/account/3pid");
    }

    /**
     * Add a 3PID to your homeserver account. This API does not use an identity
     * server, as the homeserver is expected to handle 3PID ownership validation.
     *
     * @param data - A object with 3PID validation data from having called
     * `account/3pid/<medium>/requestToken` on the homeserver.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public async addThreePidOnly(data: IAddThreePidOnlyBody): Promise<EmptyObject> {
        const path = "/account/3pid/add";
        return this.http.authedRequest(Method.Post, path, undefined, data);
    }

    /**
     * Bind a 3PID for discovery onto an identity server via the homeserver. The
     * identity server handles 3PID ownership validation and the homeserver records
     * the new binding to track where all 3PIDs for the account are bound.
     *
     * @param data - A object with 3PID validation data from having called
     * `validate/<medium>/requestToken` on the identity server. It should also
     * contain `id_server` and `id_access_token` fields as well.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public async bindThreePid(data: IBindThreePidBody): Promise<EmptyObject> {
        const path = "/account/3pid/bind";
        return this.http.authedRequest(Method.Post, path, undefined, data);
    }

    /**
     * Unbind a 3PID for discovery on an identity server via the homeserver. The
     * homeserver removes its record of the binding to keep an updated record of
     * where all 3PIDs for the account are bound.
     *
     * @param medium - The threepid medium (eg. 'email')
     * @param address - The threepid address (eg. 'bob\@example.com')
     *        this must be as returned by getThreePids.
     * @returns Promise which resolves: on success
     * @returns Rejects: with an error response.
     */
    public async unbindThreePid(
        medium: string,
        address: string,
        // eslint-disable-next-line camelcase
    ): Promise<{ id_server_unbind_result: IdServerUnbindResult }> {
        const path = "/account/3pid/unbind";
        const data = {
            medium,
            address,
            id_server: this.getIdentityServerUrl(true),
        };
        return this.http.authedRequest(Method.Post, path, undefined, data);
    }

    /**
     * @param medium - The threepid medium (eg. 'email')
     * @param address - The threepid address (eg. 'bob\@example.com')
     *        this must be as returned by getThreePids.
     * @returns Promise which resolves: The server response on success
     *     (generally the empty JSON object)
     * @returns Rejects: with an error response.
     */
    public deleteThreePid(
        medium: string,
        address: string,
        // eslint-disable-next-line camelcase
    ): Promise<{ id_server_unbind_result: IdServerUnbindResult }> {
        const path = "/account/3pid/delete";
        return this.http.authedRequest(Method.Post, path, undefined, { medium, address });
    }

    /**
     * Make a request to change your password.
     * @param newPassword - The new desired password.
     * @param logoutDevices - Should all sessions be logged out after the password change. Defaults to true.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public setPassword(authDict: AuthDict, newPassword: string, logoutDevices?: boolean): Promise<EmptyObject> {
        const path = "/account/password";
        const data = {
            auth: authDict,
            new_password: newPassword,
            logout_devices: logoutDevices,
        };

        return this.http.authedRequest<EmptyObject>(Method.Post, path, undefined, data);
    }

    /**
     * Gets all devices recorded for the logged-in user
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public getDevices(): Promise<{ devices: IMyDevice[] }> {
        return this.http.authedRequest(Method.Get, "/devices");
    }

    /**
     * Gets specific device details for the logged-in user
     * @param deviceId -  device to query
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public getDevice(deviceId: string): Promise<IMyDevice> {
        const path = utils.encodeUri("/devices/$device_id", {
            $device_id: deviceId,
        });
        return this.http.authedRequest(Method.Get, path);
    }

    /**
     * Update the given device
     *
     * @param deviceId -  device to update
     * @param body -       body of request
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    // eslint-disable-next-line camelcase
    public setDeviceDetails(deviceId: string, body: { display_name: string }): Promise<EmptyObject> {
        const path = utils.encodeUri("/devices/$device_id", {
            $device_id: deviceId,
        });

        return this.http.authedRequest(Method.Put, path, undefined, body);
    }

    /**
     * Delete the given device
     *
     * @param deviceId -  device to delete
     * @param auth - Optional. Auth data to supply for User-Interactive auth.
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public deleteDevice(deviceId: string, auth?: AuthDict): Promise<EmptyObject> {
        const path = utils.encodeUri("/devices/$device_id", {
            $device_id: deviceId,
        });

        const body: Body = {};

        if (auth) {
            body.auth = auth;
        }

        return this.http.authedRequest(Method.Delete, path, undefined, body);
    }

    /**
     * Delete multiple device
     *
     * @param devices - IDs of the devices to delete
     * @param auth - Optional. Auth data to supply for User-Interactive auth.
     * @returns Promise which resolves: result object
     * @returns Rejects: with an error response.
     */
    public deleteMultipleDevices(devices: string[], auth?: AuthDict): Promise<EmptyObject> {
        const body: Body = { devices };

        if (auth) {
            body.auth = auth;
        }

        const path = "/delete_devices";
        return this.http.authedRequest(Method.Post, path, undefined, body);
    }

    /**
     * Gets all pushers registered for the logged-in user
     *
     * @returns Promise which resolves: Array of objects representing pushers
     * @returns Rejects: with an error response.
     */
    public async getPushers(): Promise<{ pushers: IPusher[] }> {
        const response = await this.http.authedRequest<{ pushers: IPusher[] }>(Method.Get, "/pushers");

        // Migration path for clients that connect to a homeserver that does not support
        // MSC3881 yet, see https://github.com/matrix-org/matrix-spec-proposals/blob/kerry/remote-push-toggle/proposals/3881-remote-push-notification-toggling.md#migration
        if (!(await this.doesServerSupportUnstableFeature("org.matrix.msc3881"))) {
            response.pushers = response.pushers.map((pusher) => {
                if (!pusher.hasOwnProperty(PUSHER_ENABLED.name)) {
                    pusher[PUSHER_ENABLED.name] = true;
                }
                return pusher;
            });
        }

        return response;
    }

    /**
     * Adds a new pusher or updates an existing pusher
     *
     * @param pusher - Object representing a pusher
     * @returns Promise which resolves: Empty json object on success
     * @returns Rejects: with an error response.
     */
    public setPusher(pusher: IPusherRequest): Promise<EmptyObject> {
        const path = "/pushers/set";
        return this.http.authedRequest(Method.Post, path, undefined, pusher);
    }

    /**
     * Removes an existing pusher
     * @param pushKey - pushkey of pusher to remove
     * @param appId - app_id of pusher to remove
     * @returns Promise which resolves: Empty json object on success
     * @returns Rejects: with an error response.
     */
    public removePusher(pushKey: string, appId: string): Promise<EmptyObject> {
        const path = "/pushers/set";
        const body = {
            pushkey: pushKey,
            app_id: appId,
            kind: null, // marks pusher for removal
        };
        return this.http.authedRequest(Method.Post, path, undefined, body);
    }

    /**
     * Persists local notification settings
     * @returns Promise which resolves: an empty object
     * @returns Rejects: with an error response.
     */
    public setLocalNotificationSettings(
        deviceId: string,
        notificationSettings: LocalNotificationSettings,
    ): Promise<EmptyObject> {
        const key = `${LOCAL_NOTIFICATION_SETTINGS_PREFIX.name}.${deviceId}` as const;
        return this.setAccountData(key, notificationSettings);
    }

    /**
     * Get the push rules for the account from the server.
     * @returns Promise which resolves to the push rules.
     * @returns Rejects: with an error response.
     */
    public getPushRules(): Promise<IPushRules> {
        return this.http.authedRequest<IPushRules>(Method.Get, "/pushrules/").then((rules: IPushRules) => {
            this.setPushRules(rules);
            return this.pushRules!;
        });
    }

    /**
     * Update the push rules for the account. This should be called whenever
     * updated push rules are available.
     */
    public setPushRules(rules: IPushRules): void {
        // Fix-up defaults, if applicable.
        this.pushRules = PushProcessor.rewriteDefaultRules(this.logger, rules, this.getUserId()!);
        // Pre-calculate any necessary caches.
        this.pushProcessor.updateCachedPushRuleKeys(this.pushRules);
    }

    /**
     * @returns Promise which resolves: an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public addPushRule(
        scope: string,
        kind: PushRuleKind,
        ruleId: Exclude<string, RuleId>,
        body: Pick<IPushRule, "actions" | "conditions" | "pattern">,
    ): Promise<EmptyObject> {
        // NB. Scope not uri encoded because devices need the '/'
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(Method.Put, path, undefined, body);
    }

    /**
     * @returns Promise which resolves: an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public deletePushRule(scope: string, kind: PushRuleKind, ruleId: Exclude<string, RuleId>): Promise<EmptyObject> {
        // NB. Scope not uri encoded because devices need the '/'
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(Method.Delete, path);
    }

    /**
     * Enable or disable a push notification rule.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public setPushRuleEnabled(
        scope: string,
        kind: PushRuleKind,
        ruleId: RuleId | string,
        enabled: boolean,
    ): Promise<EmptyObject> {
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/enabled", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(Method.Put, path, undefined, { enabled: enabled });
    }

    /**
     * Set the actions for a push notification rule.
     * @returns Promise which resolves: to an empty object `{}`
     * @returns Rejects: with an error response.
     */
    public setPushRuleActions(
        scope: string,
        kind: PushRuleKind,
        ruleId: RuleId | string,
        actions: PushRuleAction[],
    ): Promise<EmptyObject> {
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/actions", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(Method.Put, path, undefined, { actions: actions });
    }

    /**
     * Perform a server-side search.
     * @param params
     * @param params.next_batch - the batch token to pass in the query string
     * @param params.body - the JSON object to pass to the request body.
     * @param abortSignal - optional signal used to cancel the http request.
     * @returns Promise which resolves to the search response object.
     * @returns Rejects: with an error response.
     */
    public search(
        { body, next_batch: nextBatch }: { body: ISearchRequestBody; next_batch?: string },
        abortSignal?: AbortSignal,
    ): Promise<ISearchResponse> {
        const queryParams: QueryDict = {};
        if (nextBatch) {
            queryParams.next_batch = nextBatch;
        }
        return this.http.authedRequest(Method.Post, "/search", queryParams, body, { abortSignal });
    }

    /**
     * Upload keys
     *
     * @param content -  body of upload request
     *
     * @param opts - this method no longer takes any opts,
     *  used to take opts.device_id but this was not removed from the spec as a redundant parameter
     *
     * @returns Promise which resolves: result object. Rejects: with
     *     an error response ({@link MatrixError}).
     */
    public uploadKeysRequest(content: IUploadKeysRequest, opts?: void): Promise<IKeysUploadResponse> {
        return this.http.authedRequest(Method.Post, "/keys/upload", undefined, content);
    }

    public uploadKeySignatures(content: KeySignatures): Promise<IUploadKeySignaturesResponse> {
        return this.http.authedRequest(Method.Post, "/keys/signatures/upload", undefined, content);
    }

    /**
     * Download device keys
     *
     * @param userIds -  list of users to get keys for
     *
     * @param token - sync token to pass in the query request, to help
     *   the HS give the most recent results
     *
     * @returns Promise which resolves: result object. Rejects: with
     *     an error response ({@link MatrixError}).
     */
    public downloadKeysForUsers(userIds: string[], { token }: { token?: string } = {}): Promise<IDownloadKeyResult> {
        const content: IQueryKeysRequest = {
            device_keys: {},
        };
        if (token !== undefined) {
            content.token = token;
        }
        userIds.forEach((u) => {
            content.device_keys[u] = [];
        });

        return this.http.authedRequest(Method.Post, "/keys/query", undefined, content);
    }

    /**
     * Claim one-time keys
     *
     * @param devices -  a list of [userId, deviceId] pairs
     *
     * @param keyAlgorithm -  desired key type
     *
     * @param timeout - the time (in milliseconds) to wait for keys from remote
     *     servers
     *
     * @returns Promise which resolves: result object. Rejects: with
     *     an error response ({@link MatrixError}).
     */
    public claimOneTimeKeys(
        devices: [string, string][],
        keyAlgorithm = "signed_curve25519",
        timeout?: number,
    ): Promise<IClaimOTKsResult> {
        const queries: Record<string, Record<string, string>> = {};

        if (keyAlgorithm === undefined) {
            keyAlgorithm = "signed_curve25519";
        }

        for (const [userId, deviceId] of devices) {
            const query = queries[userId] || {};
            safeSet(queries, userId, query);
            safeSet(query, deviceId, keyAlgorithm);
        }
        const content: IClaimKeysRequest = { one_time_keys: queries };
        if (timeout) {
            content.timeout = timeout;
        }
        const path = "/keys/claim";
        return this.http.authedRequest(Method.Post, path, undefined, content);
    }

    /**
     * Ask the server for a list of users who have changed their device lists
     * between a pair of sync tokens
     *
     *
     * @returns Promise which resolves: result object. Rejects: with
     *     an error response ({@link MatrixError}).
     */
    public getKeyChanges(oldToken: string, newToken: string): Promise<{ changed: string[]; left: string[] }> {
        const qps = {
            from: oldToken,
            to: newToken,
        };

        return this.http.authedRequest(Method.Get, "/keys/changes", qps);
    }

    public uploadDeviceSigningKeys(auth?: AuthDict, keys?: CrossSigningKeys): Promise<EmptyObject> {
        // API returns empty object
        const data = Object.assign({}, keys);
        if (auth) Object.assign(data, { auth });
        return this.http.authedRequest(Method.Post, "/keys/device_signing/upload", undefined, data, {
            prefix: ClientPrefix.Unstable,
        });
    }

    /**
     * Register with an identity server using the OpenID token from the user's
     * Homeserver, which can be retrieved via
     * {@link MatrixClient#getOpenIdToken}.
     *
     * Note that the `/account/register` endpoint (as well as IS authentication in
     * general) was added as part of the v2 API version.
     *
     * @returns Promise which resolves: with object containing an Identity
     * Server access token.
     * @returns Rejects: with an error response.
     */
    public registerWithIdentityServer(hsOpenIdToken: IOpenIDToken): Promise<{
        access_token: string;
        token: string;
    }> {
        if (!this.idBaseUrl) {
            throw new Error("No identity server base URL set");
        }

        const uri = this.http.getUrl("/account/register", undefined, IdentityPrefix.V2, this.idBaseUrl);
        return this.http.requestOtherUrl(Method.Post, uri, hsOpenIdToken);
    }

    /**
     * Requests an email verification token directly from an identity server.
     *
     * This API is used as part of binding an email for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param email - The email address to request a token for
     * @param clientSecret - A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param sendAttempt - If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another email.
     *                 To request another email to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param nextLink - Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param identityAccessToken - The `access_token` field of the identity
     * server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @returns Promise which resolves: TODO
     * @returns Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    public requestEmailToken(
        email: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
        identityAccessToken?: string,
    ): Promise<IRequestTokenResponse> {
        const params: Record<string, string> = {
            client_secret: clientSecret,
            email: email,
            send_attempt: sendAttempt?.toString(),
        };
        if (nextLink) {
            params.next_link = nextLink;
        }

        return this.http.idServerRequest<IRequestTokenResponse>(
            Method.Post,
            "/validate/email/requestToken",
            params,
            IdentityPrefix.V2,
            identityAccessToken,
        );
    }

    /**
     * Requests a MSISDN verification token directly from an identity server.
     *
     * This API is used as part of binding a MSISDN for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param phoneCountry - The ISO 3166-1 alpha-2 code for the country in
     *                 which phoneNumber should be parsed relative to.
     * @param phoneNumber - The phone number, in national or international
     *                 format
     * @param clientSecret - A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param sendAttempt - If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another SMS.
     *                 To request another SMS to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param nextLink - Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param identityAccessToken - The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @returns Promise which resolves to an object with a sid string
     * @returns Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    public requestMsisdnToken(
        phoneCountry: string,
        phoneNumber: string,
        clientSecret: string,
        sendAttempt: number,
        nextLink?: string,
        identityAccessToken?: string,
    ): Promise<IRequestMsisdnTokenResponse> {
        const params: Record<string, string> = {
            client_secret: clientSecret,
            country: phoneCountry,
            phone_number: phoneNumber,
            send_attempt: sendAttempt?.toString(),
        };
        if (nextLink) {
            params.next_link = nextLink;
        }

        return this.http.idServerRequest<IRequestMsisdnTokenResponse>(
            Method.Post,
            "/validate/msisdn/requestToken",
            params,
            IdentityPrefix.V2,
            identityAccessToken,
        );
    }

    /**
     * Submits a MSISDN token to the identity server
     *
     * This is used when submitting the code sent by SMS to a phone number.
     * The identity server has an equivalent API for email but the js-sdk does
     * not expose this, since email is normally validated by the user clicking
     * a link rather than entering a code.
     *
     * @param sid - The sid given in the response to requestToken
     * @param clientSecret - A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param msisdnToken - The MSISDN token, as entered by the user.
     * @param identityAccessToken - The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     * Some legacy identity servers had no authentication here.
     *
     * @returns Promise which resolves: Object, containing success boolean.
     * @returns Rejects: with an error response.
     * @throws Error if No identity server is set
     */
    public submitMsisdnToken(
        sid: string,
        clientSecret: string,
        msisdnToken: string,
        identityAccessToken: string | null,
    ): Promise<{ success: boolean }> {
        const params = {
            sid: sid,
            client_secret: clientSecret,
            token: msisdnToken,
        };

        return this.http.idServerRequest(
            Method.Post,
            "/validate/msisdn/submitToken",
            params,
            IdentityPrefix.V2,
            identityAccessToken ?? undefined,
        );
    }

    /**
     * Submits a MSISDN token to an arbitrary URL.
     *
     * This is used when submitting the code sent by SMS to a phone number in the
     * newer 3PID flow where the homeserver validates 3PID ownership (as part of
     * `requestAdd3pidMsisdnToken`). The homeserver response may include a
     * `submit_url` to specify where the token should be sent, and this helper can
     * be used to pass the token to this URL.
     *
     * @param url - The URL to submit the token to
     * @param sid - The sid given in the response to requestToken
     * @param clientSecret - A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param msisdnToken - The MSISDN token, as entered by the user.
     *
     * @returns Promise which resolves: Object, containing success boolean.
     * @returns Rejects: with an error response.
     */
    public submitMsisdnTokenOtherUrl(
        url: string,
        sid: string,
        clientSecret: string,
        msisdnToken: string,
    ): Promise<{ success: boolean }> {
        const params = {
            sid: sid,
            client_secret: clientSecret,
            token: msisdnToken,
        };
        return this.http.requestOtherUrl(Method.Post, url, params);
    }

    /**
     * Gets the V2 hashing information from the identity server. Primarily useful for
     * lookups.
     * @param identityAccessToken - The access token for the identity server.
     * @returns The hashing information for the identity server.
     */
    public getIdentityHashDetails(identityAccessToken: string): Promise<{
        /**
         * The algorithms the server supports. Must contain at least sha256.
         */
        algorithms: string[];
        /**
         * The pepper the client MUST use in hashing identifiers,
         * and MUST supply to the /lookup endpoint when performing lookups.
         */
        lookup_pepper: string;
    }> {
        return this.http.idServerRequest(
            Method.Get,
            "/hash_details",
            undefined,
            IdentityPrefix.V2,
            identityAccessToken,
        );
    }

    /**
     * Performs a hashed lookup of addresses against the identity server. This is
     * only supported on identity servers which have at least the version 2 API.
     * @param addressPairs - An array of 2 element arrays.
     * The first element of each pair is the address, the second is the 3PID medium.
     * Eg: `["email@example.org", "email"]`
     * @param identityAccessToken - The access token for the identity server.
     * @returns A collection of address mappings to
     * found MXIDs. Results where no user could be found will not be listed.
     */
    public async identityHashedLookup(
        addressPairs: [string, string][],
        identityAccessToken: string,
    ): Promise<{ address: string; mxid: string }[]> {
        const params: Record<string, string | string[]> = {
            // addresses: ["email@example.org", "10005550000"],
            // algorithm: "sha256",
            // pepper: "abc123"
        };

        // Get hash information first before trying to do a lookup
        const hashes = await this.getIdentityHashDetails(identityAccessToken);
        if (!hashes || !hashes["lookup_pepper"] || !hashes["algorithms"]) {
            throw new Error("Unsupported identity server: bad response");
        }

        params["pepper"] = hashes["lookup_pepper"];

        const localMapping: Record<string, string> = {
            // hashed identifier => plain text address
            // For use in this function's return format
        };

        // When picking an algorithm, we pick the hashed over no hashes
        if (hashes["algorithms"].includes("sha256")) {
            params["addresses"] = await Promise.all(
                addressPairs.map(async (p) => {
                    const addr = p[0].toLowerCase(); // lowercase to get consistent hashes
                    const med = p[1].toLowerCase();
                    const hashBuffer = await sha256(`${addr} ${med} ${params["pepper"]}`);
                    const hashed = encodeUnpaddedBase64Url(hashBuffer);

                    // Map the hash to a known (case-sensitive) address. We use the case
                    // sensitive version because the caller might be expecting that.
                    localMapping[hashed] = p[0];
                    return hashed;
                }),
            );
            params["algorithm"] = "sha256";
        } else if (hashes["algorithms"].includes("none")) {
            params["addresses"] = addressPairs.map((p) => {
                const addr = p[0].toLowerCase(); // lowercase to get consistent hashes
                const med = p[1].toLowerCase();
                const unhashed = `${addr} ${med}`;
                // Map the unhashed values to a known (case-sensitive) address. We use
                // the case-sensitive version because the caller might be expecting that.
                localMapping[unhashed] = p[0];
                return unhashed;
            });
            params["algorithm"] = "none";
        } else {
            throw new Error("Unsupported identity server: unknown hash algorithm");
        }

        const response = await this.http.idServerRequest<{
            mappings: { [address: string]: string };
        }>(Method.Post, "/lookup", params, IdentityPrefix.V2, identityAccessToken);

        if (!response?.["mappings"]) return []; // no results

        const foundAddresses: { address: string; mxid: string }[] = [];
        for (const hashed of Object.keys(response["mappings"])) {
            const mxid = response["mappings"][hashed];
            const plainAddress = localMapping[hashed];
            if (!plainAddress) {
                throw new Error("Identity server returned more results than expected");
            }

            foundAddresses.push({ address: plainAddress, mxid });
        }
        return foundAddresses;
    }

    /**
     * Looks up the public Matrix ID mapping for a given 3rd party
     * identifier from the identity server
     *
     * @param medium - The medium of the threepid, eg. 'email'
     * @param address - The textual address of the threepid
     * @param identityAccessToken - The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @returns Promise which resolves: A threepid mapping
     *                                 object or the empty object if no mapping
     *                                 exists
     * @returns Rejects: with an error response.
     */
    public async lookupThreePid(
        medium: string,
        address: string,
        identityAccessToken: string,
    ): Promise<
        | {
              address: string;
              medium: string;
              mxid: string;
          }
        | EmptyObject
    > {
        // Note: we're using the V2 API by calling this function, but our
        // function contract requires a V1 response. We therefore have to
        // convert it manually.
        const response = await this.identityHashedLookup([[address, medium]], identityAccessToken);
        const result = response.find((p) => p.address === address);
        if (!result) {
            return {};
        }

        const mapping = {
            address,
            medium,
            mxid: result.mxid,

            // We can't reasonably fill these parameters:
            // not_before
            // not_after
            // ts
            // signatures
        };

        return mapping;
    }

    /**
     * Looks up the public Matrix ID mappings for multiple 3PIDs.
     *
     * @param query - Array of arrays containing
     * [medium, address]
     * @param identityAccessToken - The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @returns Promise which resolves: Lookup results from IS.
     * @returns Rejects: with an error response.
     */
    public async bulkLookupThreePids(
        query: [string, string][],
        identityAccessToken: string,
    ): Promise<{
        threepids: [medium: string, address: string, mxid: string][];
    }> {
        // Note: we're using the V2 API by calling this function, but our
        // function contract requires a V1 response. We therefore have to
        // convert it manually.
        const response = await this.identityHashedLookup(
            // We have to reverse the query order to get [address, medium] pairs
            query.map((p) => [p[1], p[0]]),
            identityAccessToken,
        );

        const v1results: [medium: string, address: string, mxid: string][] = [];
        for (const mapping of response) {
            const originalQuery = query.find((p) => p[1] === mapping.address);
            if (!originalQuery) {
                throw new Error("Identity sever returned unexpected results");
            }

            v1results.push([
                originalQuery[0], // medium
                mapping.address,
                mapping.mxid,
            ]);
        }

        return { threepids: v1results };
    }

    /**
     * Get account info from the identity server. This is useful as a neutral check
     * to verify that other APIs are likely to approve access by testing that the
     * token is valid, terms have been agreed, etc.
     *
     * @param identityAccessToken - The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @returns Promise which resolves: an object with account info.
     * @returns Rejects: with an error response.
     */
    public getIdentityAccount(identityAccessToken: string): Promise<{ user_id: string }> {
        return this.http.idServerRequest(Method.Get, "/account", undefined, IdentityPrefix.V2, identityAccessToken);
    }

    /**
     * Send an event to a specific list of devices.
     * This is a low-level API that simply wraps the HTTP API
     * call to send to-device messages. We recommend using
     * queueToDevice() which is a higher level API.
     *
     * @param eventType -  type of event to send
     *    content to send. Map from user_id to device_id to content object.
     * @param txnId -     transaction id. One will be made up if not
     *    supplied.
     * @returns Promise which resolves: to an empty object `{}`
     */
    public sendToDevice(eventType: string, contentMap: SendToDeviceContentMap, txnId?: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/sendToDevice/$eventType/$txnId", {
            $eventType: eventType,
            $txnId: txnId ? txnId : this.makeTxnId(),
        });

        const body = {
            messages: utils.recursiveMapToObject(contentMap),
        };

        const targets = new Map<string, string[]>();

        for (const [userId, deviceMessages] of contentMap) {
            targets.set(userId, Array.from(deviceMessages.keys()));
        }

        this.logger.debug(`PUT ${path}`, targets);

        return this.http.authedRequest(Method.Put, path, undefined, body);
    }

    /**
     * This will encrypt the payload for all devices in the list and will queue it.
     * The type of the sent to-device message will be `m.room.encrypted`.
     * @param eventType - The type of event to send
     * @param devices - The list of devices to send the event to.
     * @param payload - The payload to send. This will be encrypted.
     * @returns Promise which resolves once queued there is no error feedback when sending fails.
     */
    public async encryptAndSendToDevice(
        eventType: string,
        devices: { userId: string; deviceId: string }[],
        payload: ToDevicePayload,
    ): Promise<void> {
        if (!this.cryptoBackend) {
            throw new Error("Cannot encrypt to device event, your client does not support encryption.");
        }
        const batch = await this.cryptoBackend.encryptToDeviceMessages(eventType, devices, payload);

        // TODO The batch mechanism removes all possibility to get error feedbacks..
        // We might want instead to do the API call directly and pass the errors back.
        await this.queueToDevice(batch);
    }

    /**
     * Sends events directly to specific devices using Matrix's to-device
     * messaging system. The batch will be split up into appropriately sized
     * batches for sending and stored in the store so they can be retried
     * later if they fail to send. Retries will happen automatically.
     * @param batch - The to-device messages to send
     */
    public queueToDevice(batch: ToDeviceBatch): Promise<void> {
        return this.toDeviceMessageQueue.queueBatch(batch);
    }

    /**
     * Get the third party protocols that can be reached using
     * this HS
     * @returns Promise which resolves to the result object
     */
    public getThirdpartyProtocols(): Promise<{ [protocol: string]: IProtocol }> {
        return this.http
            .authedRequest<Record<string, IProtocol>>(Method.Get, "/thirdparty/protocols")
            .then((response) => {
                // sanity check
                if (!response || typeof response !== "object") {
                    throw new Error(`/thirdparty/protocols did not return an object: ${response}`);
                }
                return response;
            });
    }

    /**
     * Get information on how a specific place on a third party protocol
     * may be reached.
     * @param protocol - The protocol given in getThirdpartyProtocols()
     * @param params - Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @returns Promise which resolves to the result object
     */
    public getThirdpartyLocation(
        protocol: string,
        params: { searchFields?: string[] },
    ): Promise<IThirdPartyLocation[]> {
        const path = utils.encodeUri("/thirdparty/location/$protocol", {
            $protocol: protocol,
        });

        return this.http.authedRequest(Method.Get, path, params);
    }

    /**
     * Get information on how a specific user on a third party protocol
     * may be reached.
     * @param protocol - The protocol given in getThirdpartyProtocols()
     * @param params - Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @returns Promise which resolves to the result object
     */
    public getThirdpartyUser(protocol: string, params?: QueryDict): Promise<IThirdPartyUser[]> {
        const path = utils.encodeUri("/thirdparty/user/$protocol", {
            $protocol: protocol,
        });

        return this.http.authedRequest(Method.Get, path, params);
    }

    public getTerms(serviceType: SERVICE_TYPES, baseUrl: string): Promise<Terms> {
        const url = this.termsUrlForService(serviceType, baseUrl);
        return this.http.requestOtherUrl(Method.Get, url);
    }

    public agreeToTerms(
        serviceType: SERVICE_TYPES,
        baseUrl: string,
        accessToken: string,
        termsUrls: string[],
    ): Promise<EmptyObject> {
        const url = this.termsUrlForService(serviceType, baseUrl);
        const headers = {
            Authorization: "Bearer " + accessToken,
        };
        return this.http.requestOtherUrl(
            Method.Post,
            url,
            {
                user_accepts: termsUrls,
            },
            { headers },
        );
    }

    /**
     * Reports an event as inappropriate to the server, which may then notify the appropriate people.
     * @param roomId - The room in which the event being reported is located.
     * @param eventId - The event to report.
     * @param score - The score to rate this content as where -100 is most offensive and 0 is inoffensive.
     * @param reason - The reason the content is being reported. May be blank.
     * @returns Promise which resolves to an empty object if successful
     */
    public reportEvent(roomId: string, eventId: string, score: number, reason: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/rooms/$roomId/report/$eventId", {
            $roomId: roomId,
            $eventId: eventId,
        });

        return this.http.authedRequest(Method.Post, path, undefined, { score, reason });
    }

    /**
     * Reports a room as inappropriate to the server, which may then notify the appropriate people.
     *
     * This API was introduced in Matrix v1.13.
     *
     * @param roomId - The room being reported.
     * @param reason - The reason the room is being reported. May be blank.
     * @returns Promise which resolves to an empty object if successful
     */
    public reportRoom(roomId: string, reason: string): Promise<EmptyObject> {
        const path = utils.encodeUri("/rooms/$roomId/report", {
            $roomId: roomId,
        });

        return this.http.authedRequest(Method.Post, path, undefined, { reason });
    }

    /**
     * Fetches or paginates a room hierarchy asmatrix-js-sdk/spec/unit/matrix-client.spec.ts defined by MSC2946.
     * Falls back gracefully to sourcing its data from `getSpaceSummary` if this API is not yet supported by the server.
     * @param roomId - The ID of the space-room to use as the root of the summary.
     * @param limit - The maximum number of rooms to return per page.
     * @param maxDepth - The maximum depth in the tree from the root room to return.
     * @param suggestedOnly - Whether to only return rooms with suggested=true.
     * @param fromToken - The opaque token to paginate a previous request.
     * @returns the response, with next_batch & rooms fields.
     */
    public getRoomHierarchy(
        roomId: string,
        limit?: number,
        maxDepth?: number,
        suggestedOnly = false,
        fromToken?: string,
    ): Promise<IRoomHierarchy> {
        const path = utils.encodeUri("/rooms/$roomId/hierarchy", {
            $roomId: roomId,
        });

        const queryParams: QueryDict = {
            suggested_only: String(suggestedOnly),
            max_depth: maxDepth?.toString(),
            from: fromToken,
            limit: limit?.toString(),
        };

        return this.http
            .authedRequest<IRoomHierarchy>(Method.Get, path, queryParams, undefined, {
                prefix: ClientPrefix.V1,
            })
            .catch((e) => {
                if (e.errcode === "M_UNRECOGNIZED") {
                    // fall back to the prefixed hierarchy API.
                    return this.http.authedRequest<IRoomHierarchy>(Method.Get, path, queryParams, undefined, {
                        prefix: "/_matrix/client/unstable/org.matrix.msc2946",
                    });
                }

                throw e;
            });
    }

    /**
     * Creates a new file tree space with the given name. The client will pick
     * defaults for how it expects to be able to support the remaining API offered
     * by the returned class.
     *
     * Note that this is UNSTABLE and may have breaking changes without notice.
     * @param name - The name of the tree space.
     * @returns Promise which resolves to the created space.
     */
    public async unstableCreateFileTree(name: string): Promise<MSC3089TreeSpace> {
        const { room_id: roomId } = await this.createRoom({
            name: name,
            preset: Preset.PrivateChat,
            power_level_content_override: {
                ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
                users: {
                    [this.getUserId()!]: 100,
                },
            },
            creation_content: {
                [RoomCreateTypeField]: RoomType.Space,
            },
            initial_state: [
                {
                    type: UNSTABLE_MSC3088_PURPOSE.name,
                    state_key: UNSTABLE_MSC3089_TREE_SUBTYPE.name,
                    content: {
                        [UNSTABLE_MSC3088_ENABLED.name]: true,
                    },
                },
                {
                    type: EventType.RoomEncryption,
                    state_key: "",
                    content: {
                        algorithm: "m.megolm.v1.aes-sha2",
                    },
                },
            ],
        });
        return new MSC3089TreeSpace(this, roomId);
    }

    /**
     * Gets a reference to a tree space, if the room ID given is a tree space. If the room
     * does not appear to be a tree space then null is returned.
     *
     * Note that this is UNSTABLE and may have breaking changes without notice.
     * @param roomId - The room ID to get a tree space reference for.
     * @returns The tree space, or null if not a tree space.
     */
    public unstableGetFileTreeSpace(roomId: string): MSC3089TreeSpace | null {
        const room = this.getRoom(roomId);
        if (room?.getMyMembership() !== KnownMembership.Join) return null;

        const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
        const purposeEvent = room.currentState.getStateEvents(
            UNSTABLE_MSC3088_PURPOSE.name,
            UNSTABLE_MSC3089_TREE_SUBTYPE.name,
        );

        if (!createEvent) throw new Error("Expected single room create event");

        if (!purposeEvent?.getContent()?.[UNSTABLE_MSC3088_ENABLED.name]) return null;
        if (createEvent.getContent()?.[RoomCreateTypeField] !== RoomType.Space) return null;

        return new MSC3089TreeSpace(this, roomId);
    }

    /**
     * Perform a single MSC3575 sliding sync request.
     * @param req - The request to make.
     * @param proxyBaseUrl - The base URL for the sliding sync proxy.
     * @param abortSignal - Optional signal to abort request mid-flight.
     * @returns The sliding sync response, or a standard error.
     * @throws on non 2xx status codes with an object with a field "httpStatus":number.
     */
    public slidingSync(
        req: MSC3575SlidingSyncRequest,
        proxyBaseUrl?: string,
        abortSignal?: AbortSignal,
    ): Promise<MSC3575SlidingSyncResponse> {
        const qps: QueryDict = {};
        if (req.pos) {
            qps.pos = req.pos;
            delete req.pos;
        }
        if (req.timeout) {
            qps.timeout = req.timeout;
            delete req.timeout;
        }
        const clientTimeout = req.clientTimeout;
        delete req.clientTimeout;
        return this.http.authedRequest<MSC3575SlidingSyncResponse>(Method.Post, "/sync", qps, req, {
            prefix: "/_matrix/client/unstable/org.matrix.simplified_msc3575",
            baseUrl: proxyBaseUrl,
            localTimeoutMs: clientTimeout,
            abortSignal,
        });
    }

    /**
     * A helper to determine thread support
     * @returns a boolean to determine if threads are enabled
     */
    public supportsThreads(): boolean {
        return this.clientOpts?.threadSupport || false;
    }

    /**
     * A helper to determine intentional mentions support
     * @returns a boolean to determine if intentional mentions are enabled on the server
     * @experimental
     */
    public supportsIntentionalMentions(): boolean {
        return this.canSupport.get(Feature.IntentionalMentions) !== ServerSupport.Unsupported;
    }

    /**
     * Fetches the summary of a room as defined by an initial version of MSC3266 and implemented in Synapse
     * Proposed at https://github.com/matrix-org/matrix-doc/pull/3266
     * @param roomIdOrAlias - The ID or alias of the room to get the summary of.
     * @param via - The list of servers which know about the room if only an ID was provided.
     */
    public async getRoomSummary(roomIdOrAlias: string, via?: string[]): Promise<RoomSummary> {
        const paramOpts = {
            prefix: "/_matrix/client/unstable/im.nheko.summary",
        };
        try {
            const path = utils.encodeUri("/summary/$roomid", { $roomid: roomIdOrAlias });
            return await this.http.authedRequest(Method.Get, path, { via }, undefined, paramOpts);
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_UNRECOGNIZED") {
                const path = utils.encodeUri("/rooms/$roomid/summary", { $roomid: roomIdOrAlias });
                return await this.http.authedRequest(Method.Get, path, { via }, undefined, paramOpts);
            } else {
                throw e;
            }
        }
    }

    /**
     * Processes a list of threaded events and adds them to their respective timelines
     * @param room - the room the adds the threaded events
     * @param threadedEvents - an array of the threaded events
     * @param toStartOfTimeline - the direction in which we want to add the events
     */
    public processThreadEvents(room: Room, threadedEvents: MatrixEvent[], toStartOfTimeline: boolean): void {
        room.processThreadedEvents(threadedEvents, toStartOfTimeline);
    }

    /**
     * Processes a list of thread roots and creates a thread model
     * @param room - the room to create the threads in
     * @param threadedEvents - an array of thread roots
     * @param toStartOfTimeline - the direction
     */
    public processThreadRoots(room: Room, threadedEvents: MatrixEvent[], toStartOfTimeline: boolean): void {
        if (!this.supportsThreads()) return;
        room.processThreadRoots(threadedEvents, toStartOfTimeline);
    }

    public processBeaconEvents(room?: Room, events?: MatrixEvent[]): void {
        this.processAggregatedTimelineEvents(room, events);
    }

    /**
     * Calls aggregation functions for event types that are aggregated
     * Polls and location beacons
     * @param room - room the events belong to
     * @param events - timeline events to be processed
     * @returns
     */
    public processAggregatedTimelineEvents(room?: Room, events?: MatrixEvent[]): void {
        if (!events?.length) return;
        if (!room) return;

        room.currentState.processBeaconEvents(events, this);
        room.processPollEvents(events);
    }

    /**
     * Fetches information about the user for the configured access token.
     */
    public async whoami(): Promise<IWhoamiResponse> {
        return this.http.authedRequest(Method.Get, "/account/whoami");
    }

    /**
     * Find the event_id closest to the given timestamp in the given direction.
     * @returns Resolves: A promise of an object containing the event_id and
     *    origin_server_ts of the closest event to the timestamp in the given direction
     * @returns Rejects: when the request fails (module:http-api.MatrixError)
     */
    public async timestampToEvent(
        roomId: string,
        timestamp: number,
        dir: Direction,
    ): Promise<TimestampToEventResponse> {
        const path = utils.encodeUri("/rooms/$roomId/timestamp_to_event", {
            $roomId: roomId,
        });
        const queryParams = {
            ts: timestamp.toString(),
            dir: dir,
        };

        try {
            return await this.http.authedRequest(Method.Get, path, queryParams, undefined, {
                prefix: ClientPrefix.V1,
            });
        } catch (err) {
            // Fallback to the prefixed unstable endpoint. Since the stable endpoint is
            // new, we should also try the unstable endpoint before giving up. We can
            // remove this fallback request in a year (remove after 2023-11-28).
            if (
                (<MatrixError>err).errcode === "M_UNRECOGNIZED" &&
                // XXX: The 400 status code check should be removed in the future
                // when Synapse is compliant with MSC3743.
                ((<MatrixError>err).httpStatus === 400 ||
                    // This the correct standard status code for an unsupported
                    // endpoint according to MSC3743. Not Found and Method Not Allowed
                    // both indicate that this endpoint+verb combination is
                    // not supported.
                    (<MatrixError>err).httpStatus === 404 ||
                    (<MatrixError>err).httpStatus === 405)
            ) {
                return await this.http.authedRequest(Method.Get, path, queryParams, undefined, {
                    prefix: "/_matrix/client/unstable/org.matrix.msc3030",
                });
            }

            throw err;
        }
    }

    /**
     * Discover and validate delegated auth configuration
     * - delegated auth issuer openid-configuration is reachable
     * - delegated auth issuer openid-configuration is configured correctly for us
     * Fetches /auth_metadata falling back to legacy implementation using /auth_issuer followed by
     * https://oidc-issuer.example.com/.well-known/openid-configuration and other files linked therein.
     * When successful, validated metadata is returned
     * @returns validated authentication metadata and optionally signing keys
     * @throws when delegated auth config is invalid or unreachable
     * @experimental - part of MSC2965
     */
    public async getAuthMetadata(): Promise<OidcClientConfig> {
        let authMetadata: unknown | undefined;
        try {
            authMetadata = await this.http.request<unknown>(Method.Get, "/auth_metadata", undefined, undefined, {
                prefix: ClientPrefix.Unstable + "/org.matrix.msc2965",
            });
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_UNRECOGNIZED") {
                // Fall back to older variant of MSC2965
                const { issuer } = await this.http.request<{
                    issuer: string;
                }>(Method.Get, "/auth_issuer", undefined, undefined, {
                    prefix: ClientPrefix.Unstable + "/org.matrix.msc2965",
                });
                return discoverAndValidateOIDCIssuerWellKnown(issuer);
            }
            throw e;
        }

        return validateAuthMetadataAndKeys(authMetadata);
    }
}

function getUnstableDelayQueryOpts(delayOpts: SendDelayedEventRequestOpts): QueryDict {
    return Object.fromEntries(
        Object.entries(delayOpts).map(([k, v]) => [`${UNSTABLE_MSC4140_DELAYED_EVENTS}.${k}`, v]),
    );
}

/**
 * recalculates an accurate notifications count on event decryption.
 * Servers do not have enough knowledge about encrypted events to calculate an
 * accurate notification_count
 */
export function fixNotificationCountOnDecryption(cli: MatrixClient, event: MatrixEvent): void {
    const ourUserId = cli.getUserId();
    const eventId = event.getId();

    const room = cli.getRoom(event.getRoomId());
    if (!room || !ourUserId || !eventId) return;

    // Due to threads, we can get relation events (eg. edits & reactions) that never get
    // added to a timeline and so cannot be found in their own room (their edit / reaction
    // still applies to the event it needs to, so it doesn't matter too much). However, if
    // we try to process notification about this event, we'll get very confused because we
    // won't be able to find the event in the room, so will assume it must be unread, even
    // if it's actually read. We therefore skip anything that isn't in the room. This isn't
    // *great*, so if we can fix the homeless events (eg. with MSC4023) then we should probably
    // remove this workaround.
    if (!room.findEventById(eventId)) {
        logger.info(`Decrypted event ${event.getId()} is not in room ${room.roomId}: ignoring`);
        return;
    }

    const isThreadEvent = !!event.threadRootId && !event.isThreadRoot;

    let hasReadEvent;
    if (isThreadEvent) {
        const thread = room.getThread(event.threadRootId);
        hasReadEvent = thread
            ? thread.hasUserReadEvent(ourUserId, eventId)
            : // If the thread object does not exist in the room yet, we don't
              // want to calculate notification for this event yet. We have not
              // restored the read receipts yet and can't accurately calculate
              // notifications at this stage.
              //
              // This issue can likely go away when MSC3874 is implemented
              true;
    } else {
        hasReadEvent = room.hasUserReadEvent(ourUserId, eventId);
    }

    if (hasReadEvent) {
        // If the event has been read, ignore it.
        return;
    }

    const actions = cli.getPushActionsForEvent(event, true);

    // Ensure the unread counts are kept up to date if the event is encrypted
    // We also want to make sure that the notification count goes up if we already
    // have encrypted events to avoid other code from resetting 'highlight' to zero.
    const newHighlight = !!actions?.tweaks?.highlight;

    if (newHighlight) {
        // TODO: Handle mentions received while the client is offline
        // See also https://github.com/vector-im/element-web/issues/9069
        const newCount = room.getUnreadCountForEventContext(NotificationCountType.Highlight, event) + 1;
        if (isThreadEvent) {
            room.setThreadUnreadNotificationCount(event.threadRootId, NotificationCountType.Highlight, newCount);
        } else {
            room.setUnreadNotificationCount(NotificationCountType.Highlight, newCount);
        }
    }

    // `notify` is used in practice for incrementing the total count
    const newNotify = !!actions?.notify;

    // The room total count is NEVER incremented by the server for encrypted rooms. We basically ignore
    // the server here as it's always going to tell us to increment for encrypted events.
    if (newNotify) {
        // Total count is used to typically increment a room notification counter, but not loudly highlight it.
        const newCount = room.getUnreadCountForEventContext(NotificationCountType.Total, event) + 1;
        if (isThreadEvent) {
            room.setThreadUnreadNotificationCount(event.threadRootId, NotificationCountType.Total, newCount);
        } else {
            room.setUnreadNotificationCount(NotificationCountType.Total, newCount);
        }
    }
}

/**
 * Given an event, figure out the thread ID we should use for it in a receipt.
 *
 * This will either be "main", or event.threadRootId. For the thread root, or
 * e.g. reactions to the thread root, this will be main. For events inside the
 * thread, or e.g. reactions to them, this will be event.threadRootId.
 *
 * (Exported for test.)
 */
export function threadIdForReceipt(event: MatrixEvent): string {
    return inMainTimelineForReceipt(event) ? MAIN_ROOM_TIMELINE : event.threadRootId!;
}

/**
 * a) True for non-threaded messages, thread roots and non-thread relations to thread roots.
 * b) False for messages with thread relations to the thread root.
 * c) False for messages with any kind of relation to a message from case b.
 *
 * Note: true for redactions of messages that are in threads. Redacted messages
 * are not really in threads (because their relations are gone), so if they look
 * like they are in threads, that is a sign of a bug elsewhere. (At time of
 * writing, this bug definitely exists - messages are not moved to another
 * thread when they are redacted.)
 *
 * @returns true if this event is considered to be in the main timeline as far
 *               as receipts are concerned.
 */
export function inMainTimelineForReceipt(event: MatrixEvent): boolean {
    if (!event.threadRootId) {
        // Not in a thread: then it is in the main timeline
        return true;
    }

    if (event.isThreadRoot) {
        // Thread roots are in the main timeline. Note: the spec is ambiguous (or
        // wrong) on this - see
        // https://github.com/matrix-org/matrix-spec-proposals/pull/4037
        return true;
    }

    if (!event.isRelation()) {
        // If it's not related to anything, it can't be related via a chain of
        // relations to a thread root.
        //
        // Note: this is a bug, because how does it have a threadRootId if it is
        // neither a thread root, nor related to one?
        logger.warn(`Event is not a relation or a thread root, but still has a threadRootId! id=${event.getId()}`);
        return true;
    }

    if (event.isRelation(THREAD_RELATION_TYPE.name)) {
        // It's a message in a thread - definitely not in the main timeline.
        return false;
    }

    const isRelatedToRoot = event.relationEventId === event.threadRootId;

    // If it's related to the thread root (and we already know it's not a thread
    // relation) then it's in the main timeline. If it's related to something
    // else, then it's in the thread (because it has a thread ID).
    return isRelatedToRoot;
}
