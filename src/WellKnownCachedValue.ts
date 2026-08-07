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
import { ClientEvent, type IClientWellKnown, type MatrixClient } from "./client.ts";
import { type Logger } from "./logger.ts";
import { AutoDiscovery } from "./autodiscovery.ts";

/**
 * Caches the well-known configuration for the client
 */
export class WellKnownCachedValue extends ClientPollingCachedValue<IClientWellKnown> {
    public constructor(client: MatrixClient, logger: Logger) {
        super("WellKnown", client, undefined /*No expiration by default*/, logger);
    }

    protected fetch(client: MatrixClient): Promise<IClientWellKnown> {
        return AutoDiscovery.getRawClientConfig(client.getDomain() ?? undefined);
    }

    protected valueCached(value: IClientWellKnown): void {
        super.valueCached(value);
        this.client.emit(ClientEvent.ClientWellKnown, value);
    }
}
