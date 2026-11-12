/*
Copyright 2024 The Matrix.org Foundation C.I.C.
Copyright 2026 Element Creations Ltd.

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

import { QrCodeIntent } from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    ClientRendezvousFailureReason,
    type MSC4108FailureReason,
    RendezvousError,
    type RendezvousFailureListener,
} from "../index.ts";
import { type MSC4388RendezvousSession } from "../transports/MSC4388RendezvousSession.ts";
import { logger } from "../../logger.ts";
import { type MSC4108v2025Payload } from "../MSC4108v2025SignInWithQR.ts";
import {
    type EstablishedHpkeChannel,
    HpkeRecipientChannel,
    type UnidirectionalRecipientChannel,
} from "./MSC4388HpkeChannel.ts";
import { encodeMSC4388QrCode, MSC4388QrCodeIntent, QR_CODE_PREFIX_UNSTABLE } from "./MSC4388QrCode.ts";

// TODO: temp function for formatting additional authentication data for debugging purposes
function formatAAD(aad: Uint8Array): string {
    return Array.from(aad)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Prototype of the unstable [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4388)
 * secure rendezvous session protocol.
 *
 * The secure channel and QR code format are implemented by {@link HpkeRecipientChannel} and
 * {@link encodeMSC4388QrCode} rather than by `@matrix-org/matrix-sdk-crypto-wasm`.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4388SecureChannel {
    /** Holds our ephemeral key pair. Created by {@link generateCode}. */
    private recipientChannel?: HpkeRecipientChannel;
    private establishedChannel?: EstablishedHpkeChannel;
    private connected = false;
    /**
     * The base URL exactly as encoded in the QR code, which is what MSC4388 requires in the additional authentication
     * data. Set by {@link generateCode}.
     */
    private qrCodeBaseUrl?: string;

    public constructor(
        private readonly rendezvousSession: MSC4388RendezvousSession,
        public readonly intent: QrCodeIntent,
        public onFailure?: RendezvousFailureListener,
    ) {}

    /**
     * Generate a QR code for the current session, with the {@link intent} given to the constructor.
     */
    public async generateCode(): Promise<Uint8Array> {
        const { id, baseUrl } = this.rendezvousSession;

        if (!id) {
            throw new Error("No rendezvous session ID");
        }

        if (!baseUrl) {
            throw new Error("No rendezvous session base URL");
        }
        this.recipientChannel ??= await HpkeRecipientChannel.create();
        this.qrCodeBaseUrl = baseUrl;
        return encodeMSC4388QrCode({
            prefix: QR_CODE_PREFIX_UNSTABLE,
            intent:
                this.intent === QrCodeIntent.Login ? MSC4388QrCodeIntent.NewDevice : MSC4388QrCodeIntent.ExistingDevice,
            publicKey: this.recipientChannel.publicKey,
            rendezvousId: id,
            baseUrl: this.qrCodeBaseUrl,
        });
    }

    private getAdditionalAuthenticationDataForSend(): Uint8Array {
        if (!this.qrCodeBaseUrl) {
            throw new Error("QR code not generated");
        }
        return this.rendezvousSession.getAdditionalAuthenticationDataForSend(this.qrCodeBaseUrl);
    }

    private getAdditionalAuthenticationDataForReceive(): Uint8Array {
        if (!this.qrCodeBaseUrl) {
            throw new Error("QR code not generated");
        }
        return this.rendezvousSession.getAdditionalAuthenticationDataForReceive(this.qrCodeBaseUrl);
    }

    /**
     * Returns the check code for the secure channel or undefined if not generated yet.
     */
    public getCheckCode(): string | undefined {
        // in this version of the MSC there is never a leading zero
        return this.establishedChannel?.checkCode;
    }

    /**
     * Connects and establishes a secure channel with the other device.
     */
    public async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Channel already connected");
        }

        // We are device G: the generating device

        // wait for the other side to send us their public key
        logger.info("Waiting for LoginInitiateMessage");
        const loginInitiateMessage = await this.rendezvousSession.receive();
        if (!loginInitiateMessage) {
            throw new Error("No response from other device");
        }

        logger.info("Received LoginInitiateMessage");

        let unidirectionalChannel: UnidirectionalRecipientChannel;
        let candidateLoginInitiateMessage: string;
        const receiveAad = this.getAdditionalAuthenticationDataForReceive();
        if (!this.recipientChannel) {
            throw new Error("QR code not generated");
        }
        logger.info(`Decrypting payload with AAD: ${formatAAD(receiveAad)}`);
        try {
            ({ channel: unidirectionalChannel, message: candidateLoginInitiateMessage } =
                await this.recipientChannel.establishChannel(loginInitiateMessage, receiveAad));
        } catch (e) {
            // the message could not be parsed or decrypted: either it wasn't sent by a device that scanned our QR
            // code, or it is bound to a different rendezvous session
            logger.warn("Failed to establish secure channel from LoginInitiateMessage", e);
            throw new RendezvousError(
                "Invalid response from other device",
                ClientRendezvousFailureReason.InsecureChannelDetected,
            );
        }

        // Verify LoginInitiateMessage
        if (candidateLoginInitiateMessage !== "MATRIX_QR_CODE_LOGIN_INITIATE") {
            throw new RendezvousError(
                "Invalid response from other device",
                ClientRendezvousFailureReason.InsecureChannelDetected,
            );
        }
        logger.info("LoginInitiateMessage received");

        const aad = this.getAdditionalAuthenticationDataForSend();
        logger.info(`Sending LoginOkMessage with AAD: ${formatAAD(aad)}`);
        const { channel, initialResponse: loginOkMessage } = await unidirectionalChannel.establishBidirectionalChannel(
            "MATRIX_QR_CODE_LOGIN_OK",
            aad,
        );

        await this.rendezvousSession.send(loginOkMessage);

        this.establishedChannel = channel;

        // Step 5 is complete. We, device G, don't yet trust the channel

        // next step will be for the user to confirm the check code on the other device

        this.connected = true;
    }

    private async decrypt(ciphertext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        const aad = this.getAdditionalAuthenticationDataForReceive();
        logger.info(`Decrypting payload with AAD: ${formatAAD(aad)}`);
        try {
            return await this.establishedChannel.open(ciphertext, aad);
        } catch (e) {
            // a payload that doesn't decrypt was not sealed by the other device with the expected sequence token
            logger.warn("Failed to decrypt payload from secure channel", e);
            throw new RendezvousError(
                "Failed to decrypt payload from other device",
                ClientRendezvousFailureReason.InsecureChannelDetected,
            );
        }
    }

    private async encrypt(plaintext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        const aad = this.getAdditionalAuthenticationDataForSend();
        logger.info(`Encrypting payload with AAD: ${formatAAD(aad)}`);

        return this.establishedChannel.seal(plaintext, aad);
    }

    /**
     * Sends a payload securely to the other device.
     * @param payload the payload to encrypt and send
     */
    public async secureSend<T extends MSC4108v2025Payload>(payload: T): Promise<void> {
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
    public async secureReceive<T extends MSC4108v2025Payload>(): Promise<Partial<T> | undefined> {
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
