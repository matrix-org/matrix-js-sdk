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

import fetch from 'cross-fetch';

import { logger } from '../../logger';
import { sleep } from '../../utils';
import { BaseRendezvousTransport } from "./baseTransport";
import { RendezvousCancellationFunction, RendezvousCancellationReason } from '../cancellationReason';
import { RendezvousTransportDetails } from '../transport';
import { getRequest, MatrixClient, PREFIX_UNSTABLE } from '../../matrix';

export interface SimpleHttpRendezvousTransportDetails extends RendezvousTransportDetails {
    type: 'http.v1';
    uri: string;
}

export class SimpleHttpRendezvousTransport extends BaseRendezvousTransport {
    private uri?: string;
    private etag?: string;
    private expiresAt?: Date;

    constructor(
        public onCancelled?: RendezvousCancellationFunction,
        private client?: MatrixClient,
        private hsUrl?: string,
        private fallbackRzServer?: string,
        rendezvousUri?: string,
    ) {
        super(onCancelled);
        this.uri = rendezvousUri;
        this.ready = !!this.uri;
    }

    async details(): Promise<SimpleHttpRendezvousTransportDetails> {
        return {
            type: 'http.v1',
            uri: this.uri,
        };
    }

    private async getPostEndpoint(): Promise<string | undefined> {
        if (!this.client && this.hsUrl) {
            this.client = new MatrixClient({
                baseUrl: this.hsUrl,
                request: getRequest(),
            });
        }

        if (this.client) {
            try {
                // eslint-disable-next-line camelcase
                const { unstable_features } = await this.client.getVersions();
                // eslint-disable-next-line camelcase
                if (unstable_features?.['org.matrix.msc3886']) {
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

        logger.info(`Sending data: ${JSON.stringify(data)} as ${data} to ${uri}`);

        const headers = this.etag ? { 'if-match': this.etag } : {};
        const res = await fetch(uri, { method,
            headers: { 'content-type': contentType, ...headers },
            body: data,
        });
        if (res.status === 404) {
            return this.cancel(RendezvousCancellationReason.Unknown);
        }
        this.etag = res.headers.get("etag");

        logger.info(`Posted data to ${uri} new etag ${this.etag}`);

        if (method === 'POST') {
            const location = res.headers.get('location');
            if (!location) {
                throw new Error('No rendezvous URI given');
            }
            if (res.headers.has('expires')) {
                this.expiresAt = new Date(res.headers.get('expires'));
            }
            // resolve location header which could be relative or absolute
            this.uri = new URL(location, `${res.url}${res.url.endsWith('/') ? '' : '/'}`).href;
            this.ready =true;
        }
    }

    async receive(): Promise<any> {
        if (!this.uri) {
            throw new Error('Rendezvous not set up');
        }
        let done = false;
        while (!done) {
            if (this.cancelled) {
                return;
            }
            logger.debug(`Polling: ${this.uri} after etag ${this.etag}`);
            const headers = this.etag ? { 'if-none-match': this.etag } : {};
            const poll = await fetch(this.uri, { method: "GET", headers });

            logger.debug(`Received polling response: ${poll.status} from ${this.uri}`);
            if (poll.status === 404) {
                return await this.cancel(RendezvousCancellationReason.Unknown);
            }

            // rely on server expiring the channel rather than checking ourselves

            if (poll.headers.get('content-type') !== 'application/json') {
                this.etag = poll.headers.get("etag");
            } else if (poll.status === 200) {
                this.etag = poll.headers.get("etag");
                const data = await poll.json();
                logger.info(`Received data: ${JSON.stringify(data)} from ${this.uri} with etag ${this.etag}`);
                return data;
            }

            done = false;
            await sleep(1000);
        }
    }

    async cancel(reason: RendezvousCancellationReason) {
        if (reason === RendezvousCancellationReason.Unknown &&
            this.expiresAt && this.expiresAt.getTime() < Date.now()) {
            reason = RendezvousCancellationReason.Expired;
        }

        await super.cancel(reason);

        if (this.uri && reason === RendezvousCancellationReason.UserDeclined) {
            try {
                logger.info(`Deleting channel: ${this.uri}`);
                await fetch(this.uri, { method: "DELETE" });
            } catch (e) {
                logger.warn(e);
            }
        }
    }
}
