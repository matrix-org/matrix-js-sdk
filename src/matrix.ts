/*
Copyright 2015-2022 The Matrix.org Foundation C.I.C.

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

import { WidgetApi } from "matrix-widget-api";

import { MemoryCryptoStore } from "./crypto/store/memory-crypto-store";
import { MemoryStore } from "./store/memory";
import { MatrixScheduler } from "./scheduler";
import { MatrixClient, ICreateClientOpts } from "./client";
import { RoomWidgetClient, ICapabilities } from "./embedded";
import { CryptoStore } from "./crypto/store/base";

export * from "./client";
export * from "./serverCapabilities";
export * from "./embedded";
export * from "./http-api";
export * from "./autodiscovery";
export * from "./sync-accumulator";
export * from "./errors";
export * from "./base64";
export * from "./models/beacon";
export * from "./models/event";
export * from "./models/room";
export * from "./models/event-timeline";
export * from "./models/event-timeline-set";
export * from "./models/poll";
export * from "./models/room-member";
export * from "./models/room-state";
export * from "./models/thread";
export * from "./models/typed-event-emitter";
export * from "./models/user";
export * from "./models/device";
export * from "./models/search-result";
export * from "./oidc";
export * from "./scheduler";
export * from "./filter";
export * from "./timeline-window";
export * from "./interactive-auth";
export * from "./service-types";
export * from "./store/memory";
export * from "./store/indexeddb";
export * from "./crypto/store/memory-crypto-store";
export * from "./crypto/store/localStorage-crypto-store";
export * from "./crypto/store/indexeddb-crypto-store";
export type { OutgoingRoomKeyRequest } from "./crypto/store/base";
export * from "./content-repo";
export * from "./@types/common";
export * from "./@types/uia";
export * from "./@types/event";
export * from "./@types/PushRules";
export * from "./@types/partials";
export * from "./@types/requests";
export * from "./@types/search";
export * from "./@types/beacon";
export * from "./@types/topic";
export * from "./@types/location";
export * from "./@types/threepids";
export * from "./@types/auth";
export * from "./@types/polls";
export * from "./@types/local_notifications";
export * from "./@types/registration";
export * from "./@types/read_receipts";
export * from "./@types/crypto";
export * from "./@types/extensible_events";
export * from "./@types/IIdentityServerProvider";
export * from "./models/room-summary";
export * from "./models/event-status";
export type { RoomSummary } from "./client";
export * as ContentHelpers from "./content-helpers";
export * as SecretStorage from "./secret-storage";
export type { ICryptoCallbacks } from "./crypto"; // used to be located here
export { createNewMatrixCall, CallEvent } from "./webrtc/call";
export type { MatrixCall } from "./webrtc/call";
export {
    GroupCall,
    GroupCallEvent,
    GroupCallIntent,
    GroupCallState,
    GroupCallType,
    GroupCallStatsReportEvent,
} from "./webrtc/groupCall";
export { CryptoEvent } from "./crypto";
export { SyncState, SetPresence } from "./sync";
export type { ISyncStateData as SyncStateData } from "./sync";
export { SlidingSyncEvent } from "./sliding-sync";
export { MediaHandlerEvent } from "./webrtc/mediaHandler";
export { CallFeedEvent } from "./webrtc/callFeed";
export { StatsReport } from "./webrtc/stats/statsReport";
export { Relations, RelationsEvent } from "./models/relations";
export { TypedEventEmitter } from "./models/typed-event-emitter";
export { LocalStorageErrors } from "./store/local-storage-events-emitter";
export { IdentityProviderBrand, SSOAction } from "./@types/auth";
export type { ISSOFlow as SSOFlow, LoginFlow } from "./@types/auth";
export type { IHierarchyRelation as HierarchyRelation, IHierarchyRoom as HierarchyRoom } from "./@types/spaces";
export { LocationAssetType } from "./@types/location";

/**
 * Types supporting cryptography.
 *
 * The most important is {@link Crypto.CryptoApi}, an instance of which can be retrieved via
 * {@link MatrixClient.getCrypto}.
 */
export * as Crypto from "./crypto-api";

let cryptoStoreFactory = (): CryptoStore => new MemoryCryptoStore();

/**
 * Configure a different factory to be used for creating crypto stores
 *
 * @param fac - a function which will return a new `CryptoStore`
 */
export function setCryptoStoreFactory(fac: () => CryptoStore): void {
    cryptoStoreFactory = fac;
}

function amendClientOpts(opts: ICreateClientOpts): ICreateClientOpts {
    opts.store =
        opts.store ??
        new MemoryStore({
            localStorage: global.localStorage,
        });
    opts.scheduler = opts.scheduler ?? new MatrixScheduler();
    opts.cryptoStore = opts.cryptoStore ?? cryptoStoreFactory();

    return opts;
}

/**
 * Construct a Matrix Client. Similar to {@link MatrixClient}
 * except that the 'request', 'store' and 'scheduler' dependencies are satisfied.
 * @param opts - The configuration options for this client. These configuration
 * options will be passed directly to {@link MatrixClient}.
 *
 * @returns A new matrix client.
 * @see {@link MatrixClient} for the full list of options for
 * `opts`.
 */
export function createClient(opts: ICreateClientOpts): MatrixClient {
    return new MatrixClient(amendClientOpts(opts));
}

/**
 * Construct a Matrix Client that works in a widget.
 * This client has a subset of features compared to a full client.
 * It uses the widget-api to communicate with matrix. (widget \<-\> client \<-\> homeserver)
 * @returns A new matrix client with a subset of features.
 * @param opts - The configuration options for this client. These configuration
 * options will be passed directly to {@link MatrixClient}.
 * @param widgetApi - The widget api to use for communication.
 * @param capabilities - The capabilities the widget client will request.
 * @param roomId - The room id the widget is associated with.
 * @param sendContentLoaded - Whether to send a content loaded widget action immediately after initial setup.
 *   Set to `false` if the widget uses `waitForIFrameLoad=true` (in this case the client does not expect a content loaded action at all),
 *   or if the the widget wants to send the `ContentLoaded` action at a later point in time after the initial setup.
 */
export function createRoomWidgetClient(
    widgetApi: WidgetApi,
    capabilities: ICapabilities,
    roomId: string,
    opts: ICreateClientOpts,
    sendContentLoaded = true,
): MatrixClient {
    return new RoomWidgetClient(widgetApi, capabilities, roomId, amendClientOpts(opts), sendContentLoaded);
}
