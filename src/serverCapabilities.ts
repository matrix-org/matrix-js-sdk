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

import { IHttpOpts, MatrixHttpApi, Method } from "./http-api";
import { logger } from "./logger";

// How often we update the server capabilities.
// 6 hours - an arbitrary value, but they should change very infrequently.
const CAPABILITIES_CACHE_MS = 6 * 60 * 60 * 1000;

// How long we want before retrying if we couldn't fetch
const CAPABILITIES_RETRY_MS = 30 * 1000;

export interface ICapability {
    enabled: boolean;
}

export interface IChangePasswordCapability extends ICapability {}

export interface IThreadsCapability extends ICapability {}

export interface IGetLoginTokenCapability extends ICapability {}

export interface ISetDisplayNameCapability extends ICapability {}

export interface ISetAvatarUrlCapability extends ICapability {}

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
}

type CapabilitiesResponse = {
    capabilities: Capabilities;
};

/**
 * Manages storing and periodically refreshing the server capabilities.
 */
export class ServerCapabilities {
    private capabilities?: Capabilities;
    private retryTimeout?: ReturnType<typeof setTimeout>;
    private refreshTimeout?: ReturnType<typeof setInterval>;

    public constructor(private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>) {}

    /**
     * Starts periodically fetching the server capabilities.
     */
    public start(): void {
        this.poll().then();
    }

    /**
     * Stops the service
     */
    public stop(): void {
        this.clearTimeouts();
    }

    /**
     * Returns the cached capabilities, or undefined if none are cached.
     * @returns the current capabilities, if any.
     */
    public getCachedCapabilities(): Capabilities | undefined {
        return this.capabilities;
    }

    /**
     * Fetches the latest server capabilities from the homeserver and returns them, or rejects
     * on failure.
     */
    public fetchCapabilities = async (): Promise<Capabilities> => {
        const resp = await this.http.authedRequest<CapabilitiesResponse>(Method.Get, "/capabilities");
        this.capabilities = resp["capabilities"];
        return this.capabilities;
    };

    private poll = async (): Promise<void> => {
        try {
            await this.fetchCapabilities();
            this.clearTimeouts();
            this.refreshTimeout = setTimeout(this.poll, CAPABILITIES_CACHE_MS);
            logger.debug("Fetched new server capabilities");
        } catch (e) {
            this.clearTimeouts();
            const howLong = Math.floor(CAPABILITIES_RETRY_MS + Math.random() * 5000);
            this.retryTimeout = setTimeout(this.poll, howLong);
            logger.warn(`Failed to refresh capabilities: retrying in ${howLong}ms`, e);
        }
    };

    private clearTimeouts(): void {
        if (this.refreshTimeout) {
            clearInterval(this.refreshTimeout);
            this.refreshTimeout = undefined;
        }
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = undefined;
        }
    }
}
