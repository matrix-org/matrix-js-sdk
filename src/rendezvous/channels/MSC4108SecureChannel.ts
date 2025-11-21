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

import {
    type Curve25519PublicKey,
    Ecies,
    type EstablishedEcies,
    QrCodeData,
    type QrCodeIntent,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    ClientRendezvousFailureReason,
    MSC4108FailureReason,
    type MSC4108Payload,
    RendezvousError,
    type RendezvousFailureListener,
} from "../index.ts";
import { type MSC4108RendezvousSession } from "../transports/MSC4108RendezvousSession.ts";
import { logger } from "../../logger.ts";

/**
 * Prototype of the unstable [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * secure rendezvous session protocol.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 * Imports @matrix-org/matrix-sdk-crypto-wasm so should be async-imported to avoid bundling the WASM into the main bundle.
 */
export class MSC4108SecureChannel {
    private readonly secureChannel: Ecies;
    private establishedChannel?: EstablishedEcies;
    private connected = false;

    public constructor(
        private rendezvousSession: MSC4108RendezvousSession,
        public intent: QrCodeIntent,
        private theirPublicKey?: Curve25519PublicKey,
        public onFailure?: RendezvousFailureListener,
    ) {
        this.secureChannel = new Ecies();
    }

    /**
     * Generate a QR code for the current session.
     * @param mode the mode to generate the QR code in, either `Login` or `Reciprocate`.
     */
    public async generateCode(): Promise<Uint8Array> {
        const { id, baseUrl } = this.rendezvousSession;

        if (!id) {
            throw new Error("No rendezvous session ID");
        }

        if (!baseUrl) {
            throw new Error("No rendezvous session base URL");
        }

        return new QrCodeData(this.secureChannel.public_key(), id, baseUrl, this.intent).toBytes();
    }

    /**
     * Returns the check code for the secure channel or undefined if not generated yet.
     */
    public getCheckCode(): string | undefined {
        const x = this.establishedChannel?.check_code();

        if (!x) {
            return undefined;
        }
        return Array.from(x.as_bytes())
            .map((b) => `${b % 10}`)
            .join("");
    }

    /**
     * Connects and establishes a secure channel with the other device.
     */
    public async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Channel already connected");
        }

        if (this.theirPublicKey) {
            // We are device S: the scanning device

            // Secure Channel step 4. Device S sends the initial message
            {
                const result = this.secureChannel.establish_outbound_channel(
                    this.theirPublicKey,
                    "MATRIX_QR_CODE_LOGIN_INITIATE",
                );
                this.establishedChannel = result.channel;
                logger.info("Sending LoginInitiateMessage");
                // send LoginInitiateMessage
                await this.rendezvousSession.send(result.initial_message);
            }

            // Secure Channel step 6. Verification by Device S
            {
                logger.info("Waiting for LoginOkMessage");
                const ciphertext = await this.rendezvousSession.receive();

                if (!ciphertext) {
                    throw new RendezvousError(
                        "No response from other device",
                        MSC4108FailureReason.UnexpectedMessageReceived,
                    );
                }
                const candidateLoginOkMessage = await this.decrypt(ciphertext);

                // Verify LoginOkMessage
                if (candidateLoginOkMessage !== "MATRIX_QR_CODE_LOGIN_OK") {
                    throw new RendezvousError(
                        "Invalid response from other device",
                        ClientRendezvousFailureReason.InsecureChannelDetected,
                    );
                }

                // Step 6 is now complete. We, device S, trusts the channel
            }
        } else {
            // We are device G: the generating device

            // wait for the other side to send us their public key
            logger.info("Waiting for LoginInitiateMessage");
            const loginInitiateMessage = await this.rendezvousSession.receive();
            if (!loginInitiateMessage) {
                throw new Error("No response from other device");
            }

            const { channel, message: candidateLoginInitiateMessage } =
                this.secureChannel.establish_inbound_channel(loginInitiateMessage);
            this.establishedChannel = channel;

            // Verify LoginInitiateMessage
            if (candidateLoginInitiateMessage !== "MATRIX_QR_CODE_LOGIN_INITIATE") {
                throw new RendezvousError(
                    "Invalid response from other device",
                    ClientRendezvousFailureReason.InsecureChannelDetected,
                );
            }
            logger.info("LoginInitiateMessage received");

            logger.info("Sending LoginOkMessage");
            const loginOkMessage = await this.encrypt("MATRIX_QR_CODE_LOGIN_OK");
            await this.rendezvousSession.send(loginOkMessage);

            // Step 5 is complete. We, device G, don't yet trust the channel

            // next step will be for the user to confirm the check code on the other device
        }

        this.connected = true;
    }

    private async decrypt(ciphertext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.decrypt(ciphertext);
    }

    private async encrypt(plaintext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.encrypt(plaintext);
    }

    /**
     * Sends a payload securely to the other device.
     * @param payload the payload to encrypt and send
     */
    public async secureSend<T extends MSC4108Payload>(payload: T): Promise<void> {
        if (!this.connected) {
            throw new Error("Channel closed");
        }

        const stringifiedPayload = JSON.stringify(payload);
        logger.debug(`=> {"type": ${JSON.stringify(payload.type)}, ...}`);

        await this.rendezvousSession.send(await this.encrypt(stringifiedPayload));
    }

    /**
     * Receives an encrypted payload from the other device and decrypts it.
     */
    public async secureReceive<T extends MSC4108Payload>(): Promise<Partial<T> | undefined> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        const ciphertext = await this.rendezvousSession.receive();
        if (!ciphertext) {
            return undefined;
        }
        const plaintext = await this.decrypt(ciphertext);
        const json = JSON.parse(plaintext);

        logger.debug(`<= {"type": ${JSON.stringify(json.type)}, ...}`);
        return json as Partial<T> | undefined;
    }

    /**
     * Closes the secure channel.
     */
    public async close(): Promise<void> {
        await this.rendezvousSession.close();
    }

    /**
     * Cancels the secure channel.
     * @param reason the reason for the cancellation
     */
    public async cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void> {
        try {
            await this.rendezvousSession.cancel(reason);
            this.onFailure?.(reason);
        } finally {
            await this.close();
        }
    }

    /**
     * Returns whether the rendezvous session has been cancelled.
     */
    public get cancelled(): boolean {
        return this.rendezvousSession.cancelled;
    }
}
