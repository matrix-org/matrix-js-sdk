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

import { MemoryCryptoStore } from "./crypto/store/memory-crypto-store.js";
import { MemoryStore } from "./store/memory.js";
import { MatrixScheduler } from "./scheduler.js";
import { MatrixClient, ICreateClientOpts } from "./client.js";
import { RoomWidgetClient, ICapabilities } from "./embedded.js";
import { CryptoStore } from "./crypto/store/base.js";

export * from "./client.js";
export * from "./serverCapabilities.js";
export * from "./embedded.js";
export * from "./http-api/index.js";
export * from "./autodiscovery.js";
export * from "./sync-accumulator.js";
export * from "./errors.js";
export * from "./base64.js";
export * from "./models/beacon.js";
export * from "./models/event.js";
export * from "./models/room.js";
export * from "./models/event-timeline.js";
export * from "./models/event-timeline-set.js";
export * from "./models/poll.js";
export * from "./models/room-member.js";
export * from "./models/room-state.js";
export * from "./models/thread.js";
export * from "./models/typed-event-emitter.js";
export * from "./models/user.js";
export * from "./models/device.js";
export * from "./models/search-result.js";
export * from "./oidc/index.js";
export * from "./scheduler.js";
export * from "./filter.js";
export * from "./timeline-window.js";
export * from "./interactive-auth.js";
export * from "./service-types.js";
export * from "./store/memory.js";
export * from "./store/indexeddb.js";
export * from "./crypto/store/memory-crypto-store.js";
export * from "./crypto/store/localStorage-crypto-store.js";
export * from "./crypto/store/indexeddb-crypto-store.js";
export type { OutgoingRoomKeyRequest } from "./crypto/store/base.js";
export * from "./content-repo.js";
export * from "./@types/common.js";
export * from "./@types/uia.js";
export * from "./@types/event.js";
export * from "./@types/PushRules.js";
export * from "./@types/partials.js";
export * from "./@types/requests.js";
export * from "./@types/search.js";
export * from "./@types/beacon.js";
export * from "./@types/topic.js";
export * from "./@types/location.js";
export * from "./@types/threepids.js";
export * from "./@types/auth.js";
export * from "./@types/polls.js";
export * from "./@types/local_notifications.js";
export * from "./@types/registration.js";
export * from "./@types/read_receipts.js";
export * from "./@types/crypto.js";
export * from "./@types/extensible_events.js";
export * from "./@types/IIdentityServerProvider.js";
export * from "./models/room-summary.js";
export * from "./models/event-status.js";
export type { RoomSummary } from "./client.js";
export * as ContentHelpers from "./content-helpers.js";
export * as SecretStorage from "./secret-storage.js";
export type { ICryptoCallbacks } from "./crypto/index.js"; // used to be located here
export { createNewMatrixCall, CallEvent } from "./webrtc/call.js";
export type { MatrixCall } from "./webrtc/call.js";
export {
    GroupCall,
    GroupCallEvent,
    GroupCallIntent,
    GroupCallState,
    GroupCallType,
    GroupCallStatsReportEvent,
} from "./webrtc/groupCall.js";
export { CryptoEvent } from "./crypto/index.js";
export { SyncState, SetPresence } from "./sync.js";
export type { ISyncStateData as SyncStateData } from "./sync.js";
export { SlidingSyncEvent } from "./sliding-sync.js";
export { MediaHandlerEvent } from "./webrtc/mediaHandler.js";
export { CallFeedEvent } from "./webrtc/callFeed.js";
export { StatsReport } from "./webrtc/stats/statsReport.js";
export { Relations, RelationsEvent } from "./models/relations.js";
export { TypedEventEmitter } from "./models/typed-event-emitter.js";
export { LocalStorageErrors } from "./store/local-storage-events-emitter.js";
export { IdentityProviderBrand, SSOAction } from "./@types/auth.js";
export type { ISSOFlow as SSOFlow, LoginFlow } from "./@types/auth.js";
export type { IHierarchyRelation as HierarchyRelation, IHierarchyRoom as HierarchyRoom } from "./@types/spaces.js";
export { LocationAssetType } from "./@types/location.js";

/**
 * Types supporting cryptography.
 *
 * The most important is {@link Crypto.CryptoApi}, an instance of which can be retrieved via
 * {@link MatrixClient.getCrypto}.
 */
export * as Crypto from "./crypto-api/index.js";

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
