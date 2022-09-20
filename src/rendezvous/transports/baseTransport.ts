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

import { logger } from "../../logger";
import { RendezvousCancellationFunction, RendezvousCancellationReason } from "../cancellationReason";
import { RendezvousTransport, RendezvousTransportDetails } from "../transport";

export abstract class BaseRendezvousTransport implements RendezvousTransport {
    ready = false;
    cancelled = false;

    constructor(private onCancelled: RendezvousCancellationFunction) {}

    abstract details(): Promise<RendezvousTransportDetails>;

    abstract send(contentType: string, data: any): Promise<void>;

    abstract receive(): Promise<any>;

    async cancel(reason: RendezvousCancellationReason) {
        this.cancelled = true;
        this.ready = false;

        logger.info(reason);
        logger.info('onCancelled');
        this.onCancelled(reason);
    }
}
