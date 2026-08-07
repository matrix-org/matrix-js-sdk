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

import { ClientPollingCachedValue } from "./clientPollingCachedValue.ts";
import { type Transport } from "./matrixrtc/index.ts";
import { ClientEvent, type MatrixClient } from "./client.ts";
import { type Logger } from "./logger.ts";
import { MatrixError } from "./http-api/index.ts";

const TRANSPORT_CACHE_TTL_MILLISECONDS = 1000 * 60 * 60 * 24; // 1 day

/**
 * Caches the rtc/transport discovery end-point for the client
 */
export class RTCTransportsCachedValue extends ClientPollingCachedValue<Transport[]> {
    public constructor(client: MatrixClient, logger: Logger) {
        super("RTCTransports", client, TRANSPORT_CACHE_TTL_MILLISECONDS, logger);
    }

    protected fetch(client: MatrixClient): Promise<Transport[]> {
        return this.client._unstable_getRTCTransports();
    }

    protected valueCached(value: Transport[]): void {
        super.valueCached(value);
        this.client.emit(ClientEvent.RtcTransportsUpdated, value);
    }

    protected shouldCacheError(error: any): boolean {
        // If the end point is not supported by the homeserver it will be a 404 error.
        // This is a final error, it can be cached, no need to retry everytime.
        // It will retry when ttl has expired.
        return error instanceof MatrixError && error.httpStatus === 404;
    }
}
