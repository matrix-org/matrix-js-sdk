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

import { OlmMachine, CrossSigningStatus } from "@matrix-org/matrix-sdk-crypto-wasm";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { BootstrapCrossSigningOpts } from "../crypto-api";
import { logger } from "../logger";
import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { UIAuthCallback } from "../interactive-auth";
import { ServerSideSecretStorage } from "../secret-storage";

/** Manages the cross-signing keys for our own user.
 *
 * @internal
 */
export class CrossSigningIdentity {
    public constructor(
        private readonly olmMachine: OlmMachine,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
        private readonly secretStorage: ServerSideSecretStorage,
    ) {}

    /**
     * Initialise our cross-signing keys by creating new keys if they do not exist, and uploading to the server
     */
    public async bootstrapCrossSigning(opts: BootstrapCrossSigningOpts): Promise<void> {
        if (opts.setupNewCrossSigning) {
            await this.resetCrossSigning(opts.authUploadDeviceSigningKeys);
            return;
        }

        const olmDeviceStatus: CrossSigningStatus = await this.olmMachine.crossSigningStatus();

        // Try to fetch cross signing keys from the secret storage
        const masterKeyFromSecretStorage = await this.secretStorage.get("m.cross_signing.master");
        const selfSigningKeyFromSecretStorage = await this.secretStorage.get("m.cross_signing.self_signing");
        const userSigningKeyFromSecretStorage = await this.secretStorage.get("m.cross_signing.user_signing");
        const privateKeysInSecretStorage = Boolean(
            masterKeyFromSecretStorage && selfSigningKeyFromSecretStorage && userSigningKeyFromSecretStorage,
        );

        const olmDeviceHasKeys =
            olmDeviceStatus.hasMaster && olmDeviceStatus.hasUserSigning && olmDeviceStatus.hasSelfSigning;

        // Log all relevant state for easier parsing of debug logs.
        logger.log("bootStrapCrossSigning: starting", {
            setupNewCrossSigning: opts.setupNewCrossSigning,
            olmDeviceHasMaster: olmDeviceStatus.hasMaster,
            olmDeviceHasUserSigning: olmDeviceStatus.hasUserSigning,
            olmDeviceHasSelfSigning: olmDeviceStatus.hasSelfSigning,
            privateKeysInSecretStorage,
        });

        if (olmDeviceHasKeys) {
            if (!privateKeysInSecretStorage) {
                // the device has the keys but they are not in 4S, so update it
                logger.log("bootStrapCrossSigning: Olm device has private keys: exporting to secret storage");
                await this.exportCrossSigningKeysToStorage();
            } else {
                logger.log("bootStrapCrossSigning: Olm device has private keys and they are saved in 4S, do nothing");
            }
        } /* (!olmDeviceHasKeys) */ else {
            if (privateKeysInSecretStorage) {
                // they are in 4S, so import from there
                logger.log(
                    "bootStrapCrossSigning: Cross-signing private keys not found locally, but they are available " +
                        "in secret storage, reading storage and caching locally",
                );
                await this.olmMachine.importCrossSigningKeys(
                    masterKeyFromSecretStorage,
                    selfSigningKeyFromSecretStorage,
                    userSigningKeyFromSecretStorage,
                );

                // Get the current device
                const device: RustSdkCryptoJs.Device = await this.olmMachine.getDevice(
                    this.olmMachine.userId,
                    this.olmMachine.deviceId,
                );

                // Sign the device with our cross-signing key and upload the signature
                const request: RustSdkCryptoJs.SignatureUploadRequest = await device.verify();
                await this.outgoingRequestProcessor.makeOutgoingRequest(request);
            } else {
                logger.log(
                    "bootStrapCrossSigning: Cross-signing private keys not found locally or in secret storage, creating new keys",
                );
                await this.resetCrossSigning(opts.authUploadDeviceSigningKeys);
            }
        }

        // TODO: we might previously have bootstrapped cross-signing but not completed uploading the keys to the
        //   server -- in which case we should call OlmDevice.bootstrap_cross_signing. How do we know?
        logger.log("bootStrapCrossSigning: complete");
    }

    /** Reset our cross-signing keys
     *
     * This method will:
     *   * Tell the OlmMachine to create new keys
     *   * Upload the new public keys and the device signature to the server
     *   * Upload the private keys to SSSS, if it is set up
     */
    private async resetCrossSigning(authUploadDeviceSigningKeys?: UIAuthCallback<void>): Promise<void> {
        // XXX: We must find a way to make this atomic, currently if the user does not remember his account password
        // or 4S passphrase/key the process will fail in a bad state, with keys rotated but not uploaded or saved in 4S.
        const outgoingRequests: Array<OutgoingRequest> = await this.olmMachine.bootstrapCrossSigning(true);

        // If 4S is configured we need to udpate it.
        if (await this.secretStorage.hasKey()) {
            // Update 4S before uploading cross-signing keys, to stay consistent with legacy that asks
            // 4S passphrase before asking for account password.
            // Ultimately should be made atomic and resistent to forgotten password/passphrase.
            await this.exportCrossSigningKeysToStorage();
        }
        logger.log("bootStrapCrossSigning: publishing keys to server");
        for (const req of outgoingRequests) {
            await this.outgoingRequestProcessor.makeOutgoingRequest(req, authUploadDeviceSigningKeys);
        }
    }

    /**
     * Extract the cross-signing keys from the olm machine and save them to secret storage, if it is configured
     *
     * (If secret storage is *not* configured, we assume that the export will happen when it is set up)
     */
    private async exportCrossSigningKeysToStorage(): Promise<void> {
        const exported: RustSdkCryptoJs.CrossSigningKeyExport | null = await this.olmMachine.exportCrossSigningKeys();
        /* istanbul ignore else (this function is only called when we know the olm machine has keys) */
        if (exported?.masterKey) {
            this.secretStorage.store("m.cross_signing.master", exported.masterKey);
        } else {
            logger.error(`Cannot export MSK to secret storage, private key unknown`);
        }
        if (exported?.self_signing_key) {
            this.secretStorage.store("m.cross_signing.self_signing", exported.self_signing_key);
        } else {
            logger.error(`Cannot export SSK to secret storage, private key unknown`);
        }
        if (exported?.userSigningKey) {
            this.secretStorage.store("m.cross_signing.user_signing", exported.userSigningKey);
        } else {
            logger.error(`Cannot export USK to secret storage, private key unknown`);
        }
    }
}
