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

import { logger } from "../../logger";
import { sleep } from "../../utils";
import { ClientRendezvousFailureReason, MSC4108FailureReason, RendezvousFailureListener } from "..";
import { MatrixClient, Method } from "../../matrix";
import { ClientPrefix } from "../../http-api";

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * insecure rendezvous session protocol.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4108RendezvousSession {
    public url?: string;
    private readonly client?: MatrixClient;
    private readonly fallbackRzServer?: string;
    private readonly fetchFn?: typeof global.fetch;
    private readonly onFailure?: RendezvousFailureListener;
    private etag?: string;
    private expiresAt?: Date;
    private expiresTimer?: ReturnType<typeof setTimeout>;
    private _cancelled = false;
    private _ready = false;

    public constructor({
        onFailure,
        url,
        fetchFn,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        url: string;
    });
    public constructor({
        onFailure,
        client,
        fallbackRzServer,
        fetchFn,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        client?: MatrixClient;
        fallbackRzServer?: string;
    });
    public constructor({
        fetchFn,
        onFailure,
        url,
        client,
        fallbackRzServer,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        url?: string;
        client?: MatrixClient;
        fallbackRzServer?: string;
    }) {
        this.fetchFn = fetchFn;
        this.onFailure = onFailure;
        this.client = client;
        this.fallbackRzServer = fallbackRzServer;
        this.url = url;
    }

    /**
     * Returns whether the channel is ready to be used.
     */
    public get ready(): boolean {
        return this._ready;
    }

    /**
     * Returns whether the channel has been cancelled.
     */
    public get cancelled(): boolean {
        return this._cancelled;
    }

    private fetch(resource: URL | string, options?: RequestInit): ReturnType<typeof global.fetch> {
        if (this.fetchFn) {
            return this.fetchFn(resource, options);
        }
        return global.fetch(resource, options);
    }

    private async getPostEndpoint(): Promise<string | undefined> {
        if (this.client) {
            try {
                if (await this.client.doesServerSupportUnstableFeature("org.matrix.msc4108")) {
                    return this.client.http
                        .getUrl("/org.matrix.msc4108/rendezvous", undefined, ClientPrefix.Unstable)
                        .toString();
                }
            } catch (err) {
                logger.warn("Failed to get unstable features", err);
            }
        }

        return this.fallbackRzServer;
    }

    /**
     * Sends data via the rendezvous channel.
     * @param data the payload to send
     */
    public async send(data: string): Promise<void> {
        if (this._cancelled) {
            return;
        }
        const method = this.url ? Method.Put : Method.Post;
        const uri = this.url ?? (await this.getPostEndpoint());

        if (!uri) {
            throw new Error("Invalid rendezvous URI");
        }

        const headers: Record<string, string> = { "content-type": "text/plain" };

        // if we didn't create the rendezvous channel, we need to fetch the first etag if needed
        if (!this.etag && this.url) {
            await this.receive();
        }

        if (this.etag) {
            headers["if-match"] = this.etag;
        }

        logger.info(`=> ${method} ${uri} with ${data} if-match: ${this.etag}`);

        const res = await this.fetch(uri, { method, headers, body: data, redirect: "follow" });
        if (res.status === 404) {
            return this.cancel(ClientRendezvousFailureReason.Unknown);
        }
        this.etag = res.headers.get("etag") ?? undefined;

        logger.info(`Received etag: ${this.etag}`);

        if (method === Method.Post) {
            const expires = res.headers.get("expires");
            if (expires) {
                if (this.expiresTimer) {
                    clearTimeout(this.expiresTimer);
                    this.expiresTimer = undefined;
                }
                this.expiresAt = new Date(expires);
                this.expiresTimer = setTimeout(() => {
                    this.expiresTimer = undefined;
                    this.cancel(ClientRendezvousFailureReason.Expired);
                }, this.expiresAt.getTime() - Date.now());
            }
            // MSC4108: we expect a JSON response with a rendezvous URL
            const json = await res.json();
            if (typeof json.url !== "string") {
                throw new Error("No rendezvous URL given");
            }
            this.url = json.url;
            this._ready = true;
        }
    }

    /**
     * Receives data from the rendezvous channel.
     * @return the returned promise won't resolve until new data is acquired or the channel is closed either by the server or the other party.
     */
    public async receive(): Promise<string | undefined> {
        if (!this.url) {
            throw new Error("Rendezvous not set up");
        }
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this._cancelled) {
                return undefined;
            }

            const headers: Record<string, string> = {};
            if (this.etag) {
                headers["if-none-match"] = this.etag;
            }

            logger.info(`=> GET ${this.url} if-none-match: ${this.etag}`);
            const poll = await this.fetch(this.url, { method: Method.Get, headers });

            if (poll.status === 404) {
                await this.cancel(ClientRendezvousFailureReason.Unknown);
                return undefined;
            }

            // rely on server expiring the channel rather than checking ourselves

            const etag = poll.headers.get("etag") ?? undefined;
            if (poll.headers.get("content-type") !== "text/plain") {
                this.etag = etag;
            } else if (poll.status === 200) {
                if (!etag) {
                    // Some browsers & extensions block the ETag header for anti-tracking purposes
                    // We try and detect this so the client can give the user a somewhat helpful message
                    await this.cancel(ClientRendezvousFailureReason.ETagMissing);
                    return undefined;
                }

                this.etag = etag;
                const text = await poll.text();
                logger.info(`Received: ${text} with etag ${this.etag}`);
                return text;
            }
            await sleep(1000);
        }
    }

    /**
     * Cancels the rendezvous channel.
     * If the reason is user_declined or user_cancelled then the channel will also be closed.
     * @param reason the reason to cancel with
     */
    public async cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void> {
        if (this._cancelled) return;
        if (this.expiresTimer) {
            clearTimeout(this.expiresTimer);
            this.expiresTimer = undefined;
        }

        if (
            reason === ClientRendezvousFailureReason.Unknown &&
            this.expiresAt &&
            this.expiresAt.getTime() < Date.now()
        ) {
            reason = ClientRendezvousFailureReason.Expired;
        }

        this._cancelled = true;
        this._ready = false;
        this.onFailure?.(reason);

        if (reason === ClientRendezvousFailureReason.UserDeclined || reason === MSC4108FailureReason.UserCancelled) {
            await this.close();
        }
    }

    /**
     * Closes the rendezvous channel.
     */
    public async close(): Promise<void> {
        if (this.expiresTimer) {
            clearTimeout(this.expiresTimer);
            this.expiresTimer = undefined;
        }

        if (!this.url) return;
        try {
            await this.fetch(this.url, { method: Method.Delete });
        } catch (e) {
            logger.warn(e);
        }
    }
}
