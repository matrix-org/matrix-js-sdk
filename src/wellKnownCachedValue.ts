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

import { PollingCachedValue } from "./pollingCachedValue.ts";
import { ClientEvent, type IClientWellKnown, type MatrixClient } from "./client.ts";
import { type Logger } from "./logger.ts";
import { AutoDiscovery } from "./autodiscovery.ts";

/**
 * Builds a cache for the well-known configuration of the given client.
 */
export function createWellKnownCachedValue(client: MatrixClient, logger: Logger): PollingCachedValue<IClientWellKnown> {
    return new PollingCachedValue({
        name: "WellKnown",
        logger,
        // No expiration by default
        ttlMillis: undefined,
        fetch: () => AutoDiscovery.getRawClientConfig(client.getDomain() ?? undefined),
        onValueCached: (wellKnown) => client.emit(ClientEvent.ClientWellKnown, wellKnown),
    });
}
