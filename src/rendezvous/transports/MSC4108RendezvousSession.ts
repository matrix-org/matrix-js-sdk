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

import { logger } from "../../logger.ts";
import { sleep } from "../../utils.ts";
import { ClientRendezvousFailureReason, MSC4108FailureReason, type RendezvousFailureListener } from "../index.ts";
import { MatrixClient, Method } from "../../matrix.ts";
import { ClientPrefix } from "../../http-api/index.ts";

async function testAndBuildPostEndpoint(client: MatrixClient): Promise<string | undefined> {
    try {
        if (await client.doesServerSupportUnstableFeature("io.element.msc4108")) {
            return client.http.getUrl("/io.element.msc4108/rendezvous", undefined, ClientPrefix.Unstable).toString();
        }
    } catch (err) {
        logger.warn("Failed to get unstable features", err);
    }
    return undefined;
}

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * insecure rendezvous session protocol.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4108RendezvousSession {
    /**
     * The rendezvous session ID.
     */
    public id?: string;
    /**
     * The server base URL for client-server connections.
     */
    public baseUrl?: string;
    /**
     * The full rendezvous URL (i.e. base URL + path + ID) for convenience.
     */
    private url?: string;
    private readonly client?: MatrixClient;
    private readonly fallbackRzServerBaseUrl?: string;
    private readonly onFailure?: RendezvousFailureListener;
    private sequenceToken?: string;
    private expiresAt?: Date;
    private expiresTimer?: ReturnType<typeof setTimeout>;
    private _cancelled = false;
    private _ready = false;

    /**
     * For use when you have scanned a QR code.
     */
    public constructor({
        onFailure,
        id,
        baseUrl,
    }: {
        onFailure?: RendezvousFailureListener;
        id: string;
        baseUrl: string;
    });
    /**
     * For use when you are wishing to generate a QR code. The client may be authenticated or not.
     */
    public constructor({ onFailure, client }: { onFailure?: RendezvousFailureListener; client: MatrixClient });
    public constructor({
        onFailure,
        id,
        baseUrl,
        client,
        fallbackRzServerBaseUrl,
    }: {
        onFailure?: RendezvousFailureListener;
        client?: MatrixClient;
        id?: string;
        baseUrl?: string;
        fallbackRzServerBaseUrl?: string;
    }) {
        this.onFailure = onFailure;
        this.client = client;
        this.fallbackRzServerBaseUrl = fallbackRzServerBaseUrl;
        this.id = id;
        this.baseUrl = baseUrl;
        if (id && baseUrl) {
            this.url = `${baseUrl.replace(/\/+$/, "")}/_matrix/client/unstable/io.element.msc4108/rendezvous/${id}`;
        }
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

    private async getPostEndpoint(): Promise<string | undefined> {
        if (this.client) {
            const candidateEndpoint = await testAndBuildPostEndpoint(this.client);
            if (candidateEndpoint) {
                this.baseUrl = this.client.baseUrl;
                return candidateEndpoint;
            }
        }

        if (this.fallbackRzServerBaseUrl) {
            // build a temp client to test the fallback server
            const tempClient = new MatrixClient({ baseUrl: this.fallbackRzServerBaseUrl });
            try {
                const candidateEndpoint = await testAndBuildPostEndpoint(tempClient);
                if (candidateEndpoint) {
                    this.baseUrl = this.fallbackRzServerBaseUrl;
                    return candidateEndpoint;
                }
            } finally {
                tempClient.stopClient();
            }
        }

        return undefined;
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

        const requestBody: {
            data: string;
            sequence_token?: string;
        } = { data };

        // if we didn't create the rendezvous channel, we need to fetch the first sequence_token if needed
        if (!this.sequenceToken && this.url) {
            await this.receive();
        }

        if (this.sequenceToken) {
            requestBody.sequence_token = this.sequenceToken;
        }

        logger.info(`=> ${method} ${uri} with ${data} sequence_token: ${this.sequenceToken}`);

        // TODO: if POST then optionally add auth
        const res = await fetch(uri, {
            method,
            body: JSON.stringify(requestBody),
            headers: { "Content-Type": "application/json" },
        });
        if (res.status === 404) {
            return this.cancel(ClientRendezvousFailureReason.Unknown);
        }

        if (res.status === 409) {
            logger.error("Concurrent write detected");
            return this.cancel(ClientRendezvousFailureReason.Unknown);
        }

        // MSC4108: we expect a JSON response
        const responseBody: { id?: string; sequence_token: string; expires_ts?: number } = await res.json();

        // irrespective of whether we created the rendezvous channel, store the sequence token
        this.sequenceToken = responseBody.sequence_token;

        logger.info(`Received new sequence_token: ${this.sequenceToken}`);

        if (method === Method.Post) {
            const { expires_ts: expires, id } = responseBody;
            if (typeof expires !== "number") {
                throw new Error("No rendezvous expiry given");
            }
            if (typeof id !== "string") {
                throw new Error("No rendezvous ID given");
            }

            // set up expiry timer
            if (this.expiresTimer) {
                clearTimeout(this.expiresTimer);
                this.expiresTimer = undefined;
            }
            this.expiresAt = new Date(expires);
            this.expiresTimer = setTimeout(() => {
                this.expiresTimer = undefined;
                this.cancel(ClientRendezvousFailureReason.Expired);
            }, this.expiresAt.getTime() - Date.now());

            // store session details:
            this.id = id;
            this.url = `${uri}/${id}`;

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

            logger.info(`=> GET ${this.url} existing sequence_token: ${this.sequenceToken}`);
            const poll = await fetch(this.url, { method: Method.Get });

            if (poll.status === 404) {
                await this.cancel(ClientRendezvousFailureReason.Unknown);
                return undefined;
            }

            // rely on server expiring the channel rather than checking ourselves

            const body: { data?: string; sequence_token?: string } = await poll.json();

            if (!body.sequence_token) {
                logger.error("No sequence_token in response");
                await this.cancel(ClientRendezvousFailureReason.Unknown);
                return undefined;
            }

            if (typeof body.data !== "string") {
                logger.error("No data in response");
                await this.cancel(ClientRendezvousFailureReason.Unknown);
                return undefined;
            }

            logger.info(`=> Received sequence_token: ${this.sequenceToken}`);

            if (body.sequence_token !== this.sequenceToken) {
                // we have new data
                this.sequenceToken = body.sequence_token;
                logger.info(`Received: ${body.data} with sequence_token ${this.sequenceToken}`);
                return body.data;
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
            await fetch(this.url, { method: Method.Delete });
        } catch (e) {
            logger.warn(e);
        }
    }
}
