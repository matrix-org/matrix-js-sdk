/*
Copyright 2026 Element Creations Ltd.

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
import { ClientPrefix, ConnectionError, MatrixError } from "../../http-api/index.ts";

const API_PREFIX = "/io.element.msc4388/rendezvous";

/** How long to wait between polls of the rendezvous session, and before retrying after a transient error. */
const POLL_INTERVAL_MS = 1000;

/**
 * Implements `EncodeStringAsBytes8` from MSC4388: one byte giving the length in bytes of the UTF-8 encoding of the
 * input, followed by the UTF-8 encoding of the input.
 *
 * @param input the string to encode, which must be at most 255 bytes when UTF-8 encoded
 * @returns the MSC4388 `EncodeStringAsBytes8` encoding of the input. Exported for testing.
 * @internal
 */
export function encodeStringAsBytes8(input: string): Uint8Array {
    const utf8 = new TextEncoder().encode(input);
    if (utf8.length > 255) {
        throw new Error(`Cannot encode string of ${utf8.length} bytes as additional authentication data`);
    }
    const result = new Uint8Array(1 + utf8.length);
    result[0] = utf8.length;
    result.set(utf8, 1);
    return result;
}

/**
 * Normalises a homeserver base URL to the form used in the MSC4388 QR code so that the additional authentication
 * data computed by both devices is identical. This matches `matrix-sdk-crypto`: the URL is parsed and serialised,
 * and a trailing slash is dropped when the path is just `/`.
 */
function normaliseBaseUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    return url.pathname === "/" ? url.href.replace(/\/$/, "") : url.href;
}

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
    public onFailure?: RendezvousFailureListener;
    private sequenceToken?: string;
    private lastSequenceTokenSent?: string;
    private lastSequenceTokenReceived?: string;
    private expiresAt?: Date;
    private expiresTimer?: ReturnType<typeof setTimeout>;
    private _cancelled = false;
    private _ready = false;

    /**
     * The server base URL for client-server connections, normalised to the form used in the QR code and in the
     * additional authentication data of the secure channel.
     */
    public readonly baseUrl: string;

    /**
     * For use when you are wishing to generate a QR code. The client may be authenticated or not.
     */
    public constructor({ onFailure, client }: { onFailure?: RendezvousFailureListener; client: MatrixClient }) {
        this.onFailure = onFailure;
        this.client = client;
        this.baseUrl = normaliseBaseUrl(client.baseUrl);
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

        const txnId = this.client.makeTxnId();

        try {
            const responseBody = await this.client.http.authedRequest<{
                id?: string;
                sequence_token: string;
                expires_in_ms: number;
            }>(
                this.id ? Method.Put : Method.Post,
                this.id ? `${API_PREFIX}/${this.id}/${txnId}` : API_PREFIX,
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
                    // the session has expired or been cancelled by the other side
                    return this.cancel(ClientRendezvousFailureReason.Unknown);
                }
                if (e.httpStatus === 409) {
                    // M_CONCURRENT_WRITE: the other device wrote before reading our previous payload. MSC4388 allows
                    // a GET and retry, but the secure channel protocol layered on top is strictly ping-pong so this
                    // means the two devices are out of step and the session cannot be recovered.
                    logger.error("Concurrent write detected");
                    return this.cancel(ClientRendezvousFailureReason.Unknown);
                }
            }
            // anything else (e.g. 413, 429, network failure) means the payload was not sent and the caller must know
            throw e;
        }
    }

    /**
     * Receives data from the rendezvous channel.
     * @returns the returned promise won't resolve until new data is acquired or the channel is closed either by the server or the other party.
     */
    public async receive(): Promise<string | undefined> {
        if (!this.id) {
            throw new Error("Rendezvous not set up");
        }
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
                await sleep(POLL_INTERVAL_MS);
            } catch (e) {
                if (e instanceof MatrixError) {
                    if (e.httpStatus === 404) {
                        // the session has expired or been cancelled by the other side
                        await this.cancel(ClientRendezvousFailureReason.Unknown);
                        return undefined;
                    }
                    if (e.httpStatus === 429) {
                        const retryAfterMs = e.getRetryAfterMs() ?? POLL_INTERVAL_MS;
                        logger.warn(`Rate limited polling rendezvous session, retrying in ${retryAfterMs}ms`);
                        await sleep(retryAfterMs);
                        continue;
                    }
                    if (e.httpStatus !== undefined && e.httpStatus >= 500) {
                        logger.warn(`Server error ${e.httpStatus} polling rendezvous session, retrying`);
                        await sleep(POLL_INTERVAL_MS);
                        continue;
                    }
                    // any other client error (e.g. 403 M_FORBIDDEN) is not going to be fixed by retrying
                    logger.error("Unexpected error polling rendezvous session", e);
                    await this.cancel(ClientRendezvousFailureReason.Unknown);
                    return undefined;
                }
                if (e instanceof ConnectionError) {
                    logger.warn("Connection error polling rendezvous session, retrying", e);
                    await sleep(POLL_INTERVAL_MS);
                    continue;
                }
                throw e;
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

    /**
     * Builds the additional authentication data for the secure channel as defined in MSC4388:
     * `EncodeStringAsBytes8(BaseUrl) || EncodeStringAsBytes8(RendezvousId) || EncodeStringAsBytes8(SequenceToken)`
     */
    private buildAdditionalAuthenticationData(sequenceToken: string): Uint8Array {
        if (!this.id) {
            throw new Error("Rendezvous session not ready");
        }
        const parts = [this.baseUrl, this.id, sequenceToken].map(encodeStringAsBytes8);
        const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            result.set(part, offset);
            offset += part.length;
        }
        return result;
    }

    /**
     * The additional authentication data to use when sealing a payload to send over the secure channel.
     * Per MSC4388 the sequence token is the one from the last payload that we received.
     */
    public getAdditionalAuthenticationDataForSend(): Uint8Array {
        if (!this.lastSequenceTokenReceived) {
            throw new Error("Rendezvous session not ready");
        }
        return this.buildAdditionalAuthenticationData(this.lastSequenceTokenReceived);
    }

    /**
     * The additional authentication data to use when opening a payload received over the secure channel.
     * Per MSC4388 the sequence token is the one returned by the last `PUT` (or initial `POST`) that we made.
     */
    public getAdditionalAuthenticationDataForReceive(): Uint8Array {
        if (!this.lastSequenceTokenSent) {
            throw new Error("Rendezvous session not ready");
        }
        return this.buildAdditionalAuthenticationData(this.lastSequenceTokenSent);
    }
}
