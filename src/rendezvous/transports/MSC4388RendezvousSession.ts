/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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
import { type MatrixClient, Method } from "../../matrix.ts";
import { ClientPrefix, MatrixError } from "../../http-api/index.ts";

const API_PREFIX = "/io.element.msc4388/rendezvous";

/**
 * Prototype of the unstable [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * insecure rendezvous session protocol.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4388RendezvousSession {
    /**
     * The rendezvous session ID.
     */
    public id?: string;
    private readonly client: MatrixClient;
    private readonly onFailure?: RendezvousFailureListener;
    private sequenceToken?: string;
    private lastSequenceTokenSent?: string;
    private lastSequenceTokenReceived?: string;
    private expiresAt?: Date;
    private expiresTimer?: ReturnType<typeof setTimeout>;
    private _cancelled = false;
    private _ready = false;

    /**
     * The server base URL for client-server connections.
     */
    public readonly baseUrl: string;

    /**
     * For use when you are wishing to generate a QR code. The client may be authenticated or not.
     */
    public constructor({ onFailure, client }: { onFailure?: RendezvousFailureListener; client: MatrixClient }) {
        this.onFailure = onFailure;
        this.client = client;
        // we parse to a URL to get consistency of / at end of it
        this.baseUrl = new URL(client.baseUrl).href;
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

    /**
     * Sends data via the rendezvous channel.
     * @param data the payload to send
     */
    public async send(data: string): Promise<void> {
        if (this._cancelled) {
            return;
        }
        const requestBody: {
            data: string;
            sequence_token?: string;
        } = { data };

        if (this.sequenceToken) {
            requestBody.sequence_token = this.sequenceToken;
        }

        try {
            const responseBody = await this.client.http.authedRequest<{
                id?: string;
                sequence_token: string;
                expires_in_ms: number;
            }>(
                this.id ? Method.Put : Method.Post,
                this.id ? `${API_PREFIX}/${this.id}` : API_PREFIX,
                undefined,
                requestBody,
                {
                    prefix: ClientPrefix.Unstable,
                },
            );

            // irrespective of whether we created the rendezvous channel, store the sequence token
            this.sequenceToken = responseBody.sequence_token;
            this.lastSequenceTokenSent = this.sequenceToken;

            logger.info(`Received new sequence_token after send: ${this.sequenceToken}`);

            if (!this.id) {
                const { expires_in_ms: expiresInMs, id } = responseBody;
                if (typeof expiresInMs !== "number") {
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
                this.expiresAt = new Date(Date.now() + expiresInMs);
                this.expiresTimer = setTimeout(() => {
                    this.expiresTimer = undefined;
                    this.cancel(ClientRendezvousFailureReason.Expired);
                }, this.expiresAt.getTime() - Date.now());

                // store session details:
                this.id = id;

                this._ready = true;
            }
        } catch (e) {
            if (e instanceof MatrixError) {
                if (e.httpStatus === 404) {
                    return this.cancel(ClientRendezvousFailureReason.Unknown);
                }
                if (e.httpStatus === 409) {
                    logger.error("Concurrent write detected");
                    return this.cancel(ClientRendezvousFailureReason.Unknown);
                }
            }
        }
    }

    /**
     * Receives data from the rendezvous channel.
     * @return the returned promise won't resolve until new data is acquired or the channel is closed either by the server or the other party.
     */
    public async receive(): Promise<string | undefined> {
        if (!this.id) {
            throw new Error("Rendezvous not set up");
        }
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this._cancelled) {
                return undefined;
            }

            try {
                const body = await this.client.http.request<{ data?: string; sequence_token?: string }>(
                    Method.Get,
                    `${API_PREFIX}/${this.id}`,
                    undefined,
                    undefined,
                    {
                        prefix: ClientPrefix.Unstable,
                    },
                );

                // rely on server expiring the channel rather than checking ourselves

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

                if (body.sequence_token !== this.sequenceToken) {
                    // we have new data
                    this.sequenceToken = body.sequence_token;
                    this.lastSequenceTokenReceived = this.sequenceToken;
                    logger.info(`Received: ${body.data} with sequence_token ${this.sequenceToken}`);
                    return body.data;
                }
                await sleep(1000);
            } catch (e) {
                if (e instanceof MatrixError) {
                    if (e.httpStatus === 404) {
                        await this.cancel(ClientRendezvousFailureReason.Unknown);
                        return undefined;
                    }
                }
            }
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
    }

    public getAdditionalAuthenticationDataForSend(): string {
        if (!this.baseUrl || !this.id || !this.lastSequenceTokenReceived) {
            throw new Error("Rendezvous session not ready");
        }
        return this.baseUrl + this.id + this.lastSequenceTokenReceived;
    }

    public getAdditionalAuthenticationDataForReceive(): string {
        if (!this.baseUrl || !this.id || !this.lastSequenceTokenSent) {
            throw new Error("Rendezvous session not ready");
        }
        return this.baseUrl + this.id + this.lastSequenceTokenSent;
    }
}
