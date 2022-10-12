/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { logger } from '../../logger';
import { sleep } from '../../utils';
import { RendezvousFailureListener, RendezvousFailureReason } from '../cancellationReason';
import { RendezvousTransport, RendezvousTransportDetails } from '../transport';
import { MatrixClient } from '../../matrix';
import { PREFIX_UNSTABLE } from '../../http-api';

export interface SimpleHttpRendezvousTransportDetails extends RendezvousTransportDetails {
    type: 'http.v1';
    uri: string;
}

/**
 * Implementation of the unstable [MSC3886](https://github.com/matrix-org/matrix-spec-proposals/pull/3886)
 * simple HTTP rendezvous protocol.
 */
export class SimpleHttpRendezvousTransport implements RendezvousTransport {
    ready = false;
    cancelled = false;
    private uri?: string;
    private etag?: string;
    private expiresAt?: Date;
    public onFailure?: RendezvousFailureListener;
    private client?: MatrixClient;
    private hsUrl?: string;
    private fallbackRzServer?: string;

    private static fetch(resource: URL | string, options?: RequestInit): ReturnType<typeof global.fetch> {
        if (this.fetchFn) {
            return this.fetchFn(resource, options);
        }
        return global.fetch(resource, options);
    }

    private static fetchFn?: typeof global.fetch;

    public static setFetchFn(fetchFn: typeof global.fetch): void {
        SimpleHttpRendezvousTransport.fetchFn = fetchFn;
    }

    constructor({
        onFailure,
        client,
        hsUrl,
        fallbackRzServer,
        rendezvousUri,
    }: {
        onFailure?: RendezvousFailureListener;
        client?: MatrixClient;
        hsUrl?: string;
        fallbackRzServer?: string;
        rendezvousUri?: string;
    }) {
        this.onFailure = onFailure;
        this.client = client;
        this.hsUrl = hsUrl;
        this.fallbackRzServer = fallbackRzServer;
        this.uri = rendezvousUri;
        this.ready = !!this.uri;
    }

    async details(): Promise<SimpleHttpRendezvousTransportDetails> {
        if (!this.uri) {
            throw new Error('Rendezvous not set up');
        }

        return {
            type: 'http.v1',
            uri: this.uri,
        };
    }

    private async getPostEndpoint(): Promise<string | undefined> {
        if (!this.client && this.hsUrl) {
            this.client = new MatrixClient({
                baseUrl: this.hsUrl,
            });
        }

        if (this.client) {
            try {
                if (await this.client.doesServerSupportUnstableFeature('org.matrix.msc3886')) {
                    return `${this.client.baseUrl}${PREFIX_UNSTABLE}/org.matrix.msc3886/rendezvous`;
                }
            } catch (err) {
                logger.warn('Failed to get unstable features', err);
            }
        }

        return this.fallbackRzServer;
    }

    async send(contentType: string, data: any) {
        if (this.cancelled) {
            return;
        }
        const method = this.uri ? "PUT" : "POST";
        const uri = this.uri ?? await this.getPostEndpoint();

        if (!uri) {
            throw new Error('Invalid rendezvous URI');
        }

        logger.debug(`Sending data: ${data} to ${uri}`);

        const headers: Record<string, string> = { 'content-type': contentType };
        if (this.etag) {
            headers['if-match'] = this.etag;
        }

        const res = await SimpleHttpRendezvousTransport.fetch(uri, { method,
            headers,
            body: data,
        });
        if (res.status === 404) {
            return this.cancel(RendezvousFailureReason.Unknown);
        }
        this.etag = res.headers.get("etag") ?? undefined;

        logger.debug(`Posted data to ${uri} new etag ${this.etag}`);

        if (method === 'POST') {
            const location = res.headers.get('location');
            if (!location) {
                throw new Error('No rendezvous URI given');
            }
            const expires = res.headers.get('expires');
            if (expires) {
                this.expiresAt = new Date(expires);
            }
            // we would usually expect the final `url` to be set by a proper fetch implementation.
            // however, if a polyfill based on XHR is used it won't be set, we we use existing URI as fallback
            const baseUrl = res.url ?? uri;
            // resolve location header which could be relative or absolute
            this.uri = new URL(location, `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}`).href;
            this.ready =true;
        }
    }

    async receive(): Promise<any> {
        if (!this.uri) {
            throw new Error('Rendezvous not set up');
        }
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this.cancelled) {
                return;
            }
            logger.debug(`Polling: ${this.uri} after etag ${this.etag}`);
            const headers: Record<string, string> = {};
            if (this.etag) {
                headers['if-none-match'] = this.etag;
            }
            const poll = await SimpleHttpRendezvousTransport.fetch(this.uri, { method: "GET", headers });

            logger.debug(`Received polling response: ${poll.status} from ${this.uri}`);
            if (poll.status === 404) {
                return this.cancel(RendezvousFailureReason.Unknown);
            }

            // rely on server expiring the channel rather than checking ourselves

            if (poll.headers.get('content-type') !== 'application/json') {
                this.etag = poll.headers.get("etag") ?? undefined;
            } else if (poll.status === 200) {
                this.etag = poll.headers.get("etag") ?? undefined;
                const data = await poll.json();
                logger.debug(`Received data: ${JSON.stringify(data)} from ${this.uri} with etag ${this.etag}`);
                return data;
            }
            await sleep(1000);
        }
    }

    async cancel(reason: RendezvousFailureReason) {
        if (reason === RendezvousFailureReason.Unknown &&
            this.expiresAt && this.expiresAt.getTime() < Date.now()) {
            reason = RendezvousFailureReason.Expired;
        }

        this.cancelled = true;
        this.ready = false;
        this.onFailure?.(reason);

        if (this.uri && reason === RendezvousFailureReason.UserDeclined) {
            try {
                logger.debug(`Deleting channel: ${this.uri}`);
                await SimpleHttpRendezvousTransport.fetch(this.uri, { method: "DELETE" });
            } catch (e) {
                logger.warn(e);
            }
        }
    }
}
