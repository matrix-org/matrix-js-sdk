/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { CrossSigningInfo as ICrossSigningInfo } from "../crypto-api/CrossSigningInfo";
import { CrossSigningKey } from "../crypto-api";
import { IHttpOpts, MatrixHttpApi, Method } from "../http-api";
import { IDownloadKeyResult, Keys } from "../client";

/**
 * Implementation of {@link ICrossSigningInfo}
 */
export class CrossSigningInfo implements ICrossSigningInfo {
    /**
     * Create an instance of {@link CrossSigningInfo} for the given user
     *
     * @param userId - the owner of the cross signing info
     * @param http - http interface
     */
    public static async create(
        userId: string,
        http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    ): Promise<CrossSigningInfo | null> {
        const queryBody = {
            device_keys: {
                [userId]: [],
            },
        };

        const keyResult = await http.authedRequest<IDownloadKeyResult>(
            Method.Post,
            "/_matrix/client/v3/keys/query",
            undefined,
            queryBody,
            {
                prefix: "",
            },
        );

        const getPubKey = (keys: Keys): string => {
            // `keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
            // We assume only a single key, and we want the bare form without type
            // prefix, so we select the values.
            return Object.values(keys.keys)[0];
        };

        if (!keyResult.master_keys?.[userId]) return null;
        const masterKey = getPubKey(keyResult.master_keys[userId]);

        if (!keyResult.self_signing_keys?.[userId]) return null;
        const selfSigningKey = getPubKey(keyResult.self_signing_keys[userId]);

        if (!keyResult.user_signing_keys?.[userId]) return null;
        const userSigningKey = getPubKey(keyResult.user_signing_keys[userId]);

        return new CrossSigningInfo({ masterKey, selfSigningKey, userSigningKey });
    }

    /**
     * Information about a user's cross-signing keys
     *
     * @param crossSigningKeys - user's cross-signing keys
     */
    public constructor(
        public readonly crossSigningKeys: { masterKey: string; selfSigningKey: string; userSigningKey: string },
    ) {}

    /**
     * Implementation of {@link CrossSigningKeyInfo#getId}
     *
     * `crossSigningKeyType` has `master` as default value
     */
    public getId(crossSigningKeyType = CrossSigningKey.Master): string | null {
        switch (crossSigningKeyType) {
            case CrossSigningKey.Master:
                return this.crossSigningKeys.masterKey;
            case CrossSigningKey.SelfSigning:
                return this.crossSigningKeys.selfSigningKey;
            case CrossSigningKey.UserSigning:
                return this.crossSigningKeys.userSigningKey;
            default:
                // Unknown type
                return null;
        }
    }
}
