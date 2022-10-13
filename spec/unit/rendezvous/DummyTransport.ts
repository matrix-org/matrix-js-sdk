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

import {
    RendezvousFailureListener,
    RendezvousFailureReason,
    RendezvousTransport,
    RendezvousTransportDetails,
} from "../../../src/rendezvous";
import { sleep } from '../../../src/utils';

export class DummyTransport implements RendezvousTransport {
    otherParty?: DummyTransport;
    etag?: string;
    data = null;

    ready = false;

    constructor(private mockDetails: RendezvousTransportDetails) {}
    onCancelled?: RendezvousFailureListener;

    details(): Promise<RendezvousTransportDetails> {
        return Promise.resolve(this.mockDetails);
    }

    async send(contentType: string, data: any): Promise<void> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (!this.etag || this.otherParty?.etag === this.etag) {
                this.data = data;
                this.etag = Math.random().toString();
                return;
            }
            await sleep(100);
        }
    }

    async receive(): Promise<any> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (!this.etag || this.otherParty?.etag !== this.etag) {
                this.etag = this.otherParty?.etag;
                return this.otherParty?.data ? JSON.parse(this.otherParty.data) : undefined;
            }
            await sleep(100);
        }
    }

    cancel(reason: RendezvousFailureReason): Promise<void> {
        throw new Error("Method not implemented.");
    }
}
