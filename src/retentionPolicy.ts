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

import { CapabilityPoller } from "./capabilityPoller.ts";
import { ClientPrefix, IHttpOpts, MatrixHttpApi, Method } from "./http-api/index.ts";
import { Logger } from "./logger.ts";

export interface RetentionConfigurationResponse {
    policies?: Record<
        string,
        {
            max_lifetime?: number;
            min_lifetime?: number;
        }
    >;
    limits?: {
        min_lifetime?: {
            min?: number;
            max?: number;
        };
        max_lifetime?: {
            min?: number;
            max?: number;
        };
    };
}

/**
 * Manages storing and periodically refreshing the server capabilities.
 */
export class RetentionPolicyService extends CapabilityPoller<RetentionConfigurationResponse> {
    public constructor(logger: Logger, http: MatrixHttpApi<IHttpOpts & { onlyData: true }>) {
        super(logger, http, "retention policy");
    }
    /**
     * Fetches the latest server capabilities from the homeserver and returns them, or rejects
     * on failure.
     */
    public fetch = async (): Promise<RetentionConfigurationResponse> => {
        const resp = await this.http.authedRequest<RetentionConfigurationResponse>(
            Method.Get,
            "/retention/configuration",
            undefined,
            undefined,
            {
                prefix: `${ClientPrefix.Unstable}/org.matrix.msc1763`,
            },
        );
        this.cached = resp;
        return this.cached;
    };
}
