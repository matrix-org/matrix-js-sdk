/*
Copyright 2025 New Vector Ltd

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

import { type Transport } from "./types.ts";

export interface LivekitTransportConfig extends Transport {
    type: "livekit";
    livekit_service_url: string;
}

export const isLivekitTransportConfig = (object: any): object is LivekitTransportConfig =>
    object.type === "livekit" && "livekit_service_url" in object;

export interface LivekitTransport extends LivekitTransportConfig {
    livekit_alias: string;
}

export const isLivekitTransport = (object: any): object is LivekitTransport =>
    isLivekitTransportConfig(object) && "livekit_alias" in object;

/**
 * @deprecated, this is just needed for the old focus active / focus fields of a call membership.
 * Not needed for new implementations.
 */
export interface LivekitFocusSelection extends Transport {
    type: "livekit";
    focus_selection: "oldest_membership" | "multi_sfu";
}
/**
 * @deprecated see LivekitFocusSelection
 */
export const isLivekitFocusSelection = (object: any): object is LivekitFocusSelection =>
    object.type === "livekit" && "focus_selection" in object;
