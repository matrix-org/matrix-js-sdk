/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { CapabilityPoller } from "./capabilityPoller.ts";
import { type IHttpOpts, type MatrixHttpApi, Method } from "./http-api/index.ts";
import type { Logger } from "./logger.ts";

export interface ICapability {
    enabled: boolean;
}

export interface IChangePasswordCapability extends ICapability {}

export interface IThreadsCapability extends ICapability {}

export interface IGetLoginTokenCapability extends ICapability {}

export interface ISetDisplayNameCapability extends ICapability {}

export interface ISetAvatarUrlCapability extends ICapability {}

export interface IProfileFieldsCapability extends ICapability {}

export enum RoomVersionStability {
    Stable = "stable",
    Unstable = "unstable",
}

export interface IRoomVersionsCapability {
    default: string;
    available: Record<string, RoomVersionStability>;
}

/**
 * A representation of the capabilities advertised by a homeserver as defined by
 * [Capabilities negotiation](https://spec.matrix.org/v1.6/client-server-api/#get_matrixclientv3capabilities).
 */
export interface Capabilities {
    [key: string]: any;
    "m.change_password"?: IChangePasswordCapability;
    "m.room_versions"?: IRoomVersionsCapability;
    "io.element.thread"?: IThreadsCapability;
    "m.get_login_token"?: IGetLoginTokenCapability;
    "org.matrix.msc3882.get_login_token"?: IGetLoginTokenCapability;
    "m.set_displayname"?: ISetDisplayNameCapability;
    "m.set_avatar_url"?: ISetAvatarUrlCapability;
    "uk.tcpip.msc4133.profile_fields"?: IProfileFieldsCapability;
    /**
     * Since Matrix v1.16
     */
    "m.profile_fields"?: IProfileFieldsCapability;
}

type CapabilitiesResponse = {
    capabilities: Capabilities;
};

/**
 * Manages storing and periodically refreshing the server capabilities.
 */
export class ServerCapabilities extends CapabilityPoller<Capabilities> {
    public constructor(logger: Logger, http: MatrixHttpApi<IHttpOpts & { onlyData: true }>) {
        super(logger, http, "server capabilities");
    }
    /**
     * Fetches the latest server capabilities from the homeserver and returns them, or rejects
     * on failure.
     */
    public fetch = async (): Promise<Capabilities> => {
        const resp = await this.http.authedRequest<CapabilitiesResponse>(Method.Get, "/capabilities");
        this.cached = resp["capabilities"];
        return this.cached;
    };
}
