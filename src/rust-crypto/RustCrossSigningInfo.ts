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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { CrossSigningInfo } from "../crypto-api/CrossSigningInfo";
import { CrossSigningKey, CrossSigningKeyInfo } from "../crypto-api";

/**
 * Implementation of {@link CrossSigningInfo}
 */
export class RustCrossSigningInfo implements CrossSigningInfo {
    /**
     * Create an instance of {@link RustCrossSigningInfo} for the given user
     *
     * @param userId -
     * @param olmMachine - the `OlmMachine` from the underlying rust crypto sdk
     */
    public static async getCrossSigningInfo(
        userId: string,
        olmMachine: RustSdkCryptoJs.OlmMachine,
    ): Promise<CrossSigningInfo | null> {
        const userIdentity: RustSdkCryptoJs.UserIdentity | undefined = await olmMachine.getIdentity(
            new RustSdkCryptoJs.UserId(userId),
        );

        return userIdentity ? new RustCrossSigningInfo(userIdentity) : null;
    }

    /**
     * Information about a user's cross-signing keys
     *
     * @param userIdentity - rust user identity
     */
    public constructor(public readonly userIdentity: RustSdkCryptoJs.UserIdentity) {}

    /**
     * Implementation of {@link CrossSigningKeyInfo#getId}
     *
     * `crossSigningKeyType` has `master` as default value
     */
    public getId(crossSigningKeyType = CrossSigningKey.Master): string | null {
        let key: string;
        switch (crossSigningKeyType) {
            case CrossSigningKey.Master:
                key = this.userIdentity.masterKey;
                break;
            case CrossSigningKey.SelfSigning:
                key = this.userIdentity.selfSigningKey;
                break;
            default:
                // Unknown type or userSigningKey.
                // userSigningKey is not available in UserIdentity.
                return null;
        }

        const parsedKey: CrossSigningKeyInfo = JSON.parse(key);
        // `keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
        // We assume only a single key, and we want the bare form without type
        // prefix, so we select the values.
        return Object.values(parsedKey.keys)[0];
    }
}
