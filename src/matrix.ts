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

import { MemoryCryptoStore } from "./crypto/store/memory-crypto-store.ts";
import { MemoryStore } from "./store/memory.ts";
import { MatrixScheduler } from "./scheduler.ts";
import { MatrixClient, ICreateClientOpts } from "./client.ts";
import { RoomWidgetClient, ICapabilities } from "./embedded.ts";
import { CryptoStore } from "./crypto/store/base.ts";

export * from "./client.ts";
export * from "./serverCapabilities.ts";
export * from "./embedded.ts";
export * from "./http-api/index.ts";
export * from "./autodiscovery.ts";
export * from "./sync-accumulator.ts";
export * from "./errors.ts";
export * from "./base64.ts";
export * from "./models/beacon.ts";
export * from "./models/event.ts";
export * from "./models/room.ts";
export * from "./models/event-timeline.ts";
export * from "./models/event-timeline-set.ts";
export * from "./models/poll.ts";
export * from "./models/room-member.ts";
export * from "./models/room-state.ts";
export * from "./models/thread.ts";
export * from "./models/typed-event-emitter.ts";
export * from "./models/user.ts";
export * from "./models/device.ts";
export * from "./models/search-result.ts";
export * from "./oidc/index.ts";
export * from "./scheduler.ts";
export * from "./filter.ts";
export * from "./timeline-window.ts";
export * from "./interactive-auth.ts";
export * from "./service-types.ts";
export * from "./store/memory.ts";
export * from "./store/indexeddb.ts";
export * from "./crypto/store/memory-crypto-store.ts";
export * from "./crypto/store/localStorage-crypto-store.ts";
export * from "./crypto/store/indexeddb-crypto-store.ts";
export type { OutgoingRoomKeyRequest } from "./crypto/store/base.ts";
export * from "./content-repo.ts";
export * from "./@types/common.ts";
export * from "./@types/uia.ts";
export * from "./@types/event.ts";
export * from "./@types/PushRules.ts";
export * from "./@types/partials.ts";
export * from "./@types/requests.ts";
export * from "./@types/search.ts";
export * from "./@types/beacon.ts";
export * from "./@types/topic.ts";
export * from "./@types/location.ts";
export * from "./@types/threepids.ts";
export * from "./@types/auth.ts";
export * from "./@types/polls.ts";
export * from "./@types/local_notifications.ts";
export * from "./@types/registration.ts";
export * from "./@types/read_receipts.ts";
export * from "./@types/crypto.ts";
export * from "./@types/extensible_events.ts";
export * from "./@types/IIdentityServerProvider.ts";
export * from "./models/room-summary.ts";
export * from "./models/event-status.ts";
export type { RoomSummary } from "./client.ts";
export * as ContentHelpers from "./content-helpers.ts";
export * as SecretStorage from "./secret-storage.ts";
export type { ICryptoCallbacks } from "./crypto/index.ts"; // used to be located here
export { createNewMatrixCall, CallEvent } from "./webrtc/call.ts";
export type { MatrixCall } from "./webrtc/call.ts";
export {
    GroupCall,
    GroupCallEvent,
    GroupCallIntent,
    GroupCallState,
    GroupCallType,
    GroupCallStatsReportEvent,
} from "./webrtc/groupCall.ts";
export { CryptoEvent } from "./crypto/index.ts";
export { SyncState, SetPresence } from "./sync.ts";
export type { ISyncStateData as SyncStateData } from "./sync.ts";
export { SlidingSyncEvent } from "./sliding-sync.ts";
export { MediaHandlerEvent } from "./webrtc/mediaHandler.ts";
export { CallFeedEvent } from "./webrtc/callFeed.ts";
export { StatsReport } from "./webrtc/stats/statsReport.ts";
export { Relations, RelationsEvent } from "./models/relations.ts";
export { TypedEventEmitter } from "./models/typed-event-emitter.ts";
export { LocalStorageErrors } from "./store/local-storage-events-emitter.ts";
export { IdentityProviderBrand, SSOAction } from "./@types/auth.ts";
export type { ISSOFlow as SSOFlow, LoginFlow } from "./@types/auth.ts";
export type { IHierarchyRelation as HierarchyRelation, IHierarchyRoom as HierarchyRoom } from "./@types/spaces.ts";
export { LocationAssetType } from "./@types/location.ts";

/**
 * Types supporting cryptography.
 *
 * The most important is {@link Crypto.CryptoApi}, an instance of which can be retrieved via
 * {@link MatrixClient.getCrypto}.
 */
export * as Crypto from "./crypto-api/index.ts";

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
