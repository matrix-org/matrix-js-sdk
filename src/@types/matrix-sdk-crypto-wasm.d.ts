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

import type * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

declare module "@matrix-org/matrix-sdk-crypto-wasm" {
    interface OlmMachine {
        importSecretsBundle(bundle: RustSdkCryptoJs.SecretsBundle): Promise<void>;
        exportSecretsBundle(): Promise<RustSdkCryptoJs.SecretsBundle>;
    }

    interface SecretsBundle {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        to_json(): Promise<{
            cross_signing: {
                master_key: string;
                self_signing_key: string;
                user_signing_key: string;
            };
            backup?: {
                algorithm: string;
                key: string;
                backup_version: string;
            };
        }>;
    }

    interface Device {
        requestVerification(methods?: any[]): [RustSdkCryptoJs.VerificationRequest, RustSdkCryptoJs.ToDeviceRequest];
    }
}
