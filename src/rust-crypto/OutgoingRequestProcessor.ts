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

import {
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    OlmMachine,
    PutDehydratedDeviceRequest,
    RoomMessageRequest,
    SignatureUploadRequest,
    ToDeviceRequest,
    UploadSigningKeysRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import { logger } from "../logger";
import { calculateRetryBackoff, IHttpOpts, MatrixHttpApi, Method } from "../http-api";
import { logDuration, QueryDict, sleep } from "../utils";
import { AuthDict, UIAuthCallback } from "../interactive-auth";
import { UIAResponse } from "../@types/uia";
import { ToDeviceMessageId } from "../@types/event";
import { UnstablePrefix as DehydrationUnstablePrefix } from "./DehydratedDeviceManager";

/**
 * Common interface for all the request types returned by `OlmMachine.outgoingRequests`.
 *
 * @internal
 */
export interface OutgoingRequest {
    readonly id: string | undefined;
    readonly type: number;
}

/**
 * OutgoingRequestManager: turns `OutgoingRequest`s from the rust sdk into HTTP requests
 *
 * We have one of these per `RustCrypto` (and hence per `MatrixClient`), not that it does anything terribly complicated.
 * It's responsible for:
 *
 *   * holding the reference to the `MatrixHttpApi`
 *   * turning `OutgoingRequest`s from the rust backend into HTTP requests, and sending them
 *   * sending the results of such requests back to the rust backend.
 *
 * @internal
 */
export class OutgoingRequestProcessor {
    public constructor(
        private readonly olmMachine: OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    ) {}

    public async makeOutgoingRequest<T>(
        msg: OutgoingRequest | UploadSigningKeysRequest | PutDehydratedDeviceRequest,
        uiaCallback?: UIAuthCallback<T>,
    ): Promise<void> {
        let resp: string;

        /* refer https://docs.rs/matrix-sdk-crypto/0.6.0/matrix_sdk_crypto/requests/enum.OutgoingRequests.html
         * for the complete list of request types
         */
        if (msg instanceof KeysUploadRequest) {
            resp = await this.requestWithRetry(Method.Post, "/_matrix/client/v3/keys/upload", {}, msg.body);
        } else if (msg instanceof KeysQueryRequest) {
            resp = await this.requestWithRetry(Method.Post, "/_matrix/client/v3/keys/query", {}, msg.body);
        } else if (msg instanceof KeysClaimRequest) {
            resp = await this.requestWithRetry(Method.Post, "/_matrix/client/v3/keys/claim", {}, msg.body);
        } else if (msg instanceof SignatureUploadRequest) {
            resp = await this.requestWithRetry(Method.Post, "/_matrix/client/v3/keys/signatures/upload", {}, msg.body);
        } else if (msg instanceof KeysBackupRequest) {
            resp = await this.requestWithRetry(
                Method.Put,
                "/_matrix/client/v3/room_keys/keys",
                { version: msg.version },
                msg.body,
            );
        } else if (msg instanceof ToDeviceRequest) {
            resp = await this.sendToDeviceRequest(msg);
        } else if (msg instanceof RoomMessageRequest) {
            const path =
                `/_matrix/client/v3/rooms/${encodeURIComponent(msg.room_id)}/send/` +
                `${encodeURIComponent(msg.event_type)}/${encodeURIComponent(msg.txn_id)}`;
            resp = await this.requestWithRetry(Method.Put, path, {}, msg.body);
        } else if (msg instanceof UploadSigningKeysRequest) {
            await this.makeRequestWithUIA(
                Method.Post,
                "/_matrix/client/v3/keys/device_signing/upload",
                {},
                msg.body,
                uiaCallback,
            );
            // SigningKeysUploadRequest does not implement OutgoingRequest and does not need to be marked as sent.
            return;
        } else if (msg instanceof PutDehydratedDeviceRequest) {
            const path = DehydrationUnstablePrefix + "/dehydrated_device";
            await this.rawJsonRequest(Method.Put, path, {}, msg.body);
            // PutDehydratedDeviceRequest does not implement OutgoingRequest and does not need to be marked as sent.
            return;
        } else {
            logger.warn("Unsupported outgoing message", Object.getPrototypeOf(msg));
            resp = "";
        }

        if (msg.id) {
            try {
                await logDuration(logger, `Mark Request as sent ${msg.type}`, async () => {
                    await this.olmMachine.markRequestAsSent(msg.id!, msg.type, resp);
                });
            } catch (e) {
                // Ignore errors which are caused by the olmMachine having been freed. The exact error message depends
                // on whether we are using a release or develop build of rust-sdk-crypto-wasm.
                if (
                    e instanceof Error &&
                    (e.message === "Attempt to use a moved value" || e.message === "null pointer passed to rust")
                ) {
                    logger.log(`Ignoring error '${e.message}': client is likely shutting down`);
                } else {
                    throw e;
                }
            }
        } else {
            logger.trace(`Outgoing request type:${msg.type} does not have an ID`);
        }
    }

    /**
     * Send the HTTP request for a `ToDeviceRequest`
     *
     * @param request - request to send
     * @returns JSON-serialized body of the response, if successful
     */
    private async sendToDeviceRequest(request: ToDeviceRequest): Promise<string> {
        // a bit of extra logging, to help trace to-device messages through the system
        const parsedBody: { messages: Record<string, Record<string, Record<string, any>>> } = JSON.parse(request.body);

        const messageList = [];
        for (const [userId, perUserMessages] of Object.entries(parsedBody.messages)) {
            for (const [deviceId, message] of Object.entries(perUserMessages)) {
                messageList.push(`${userId}/${deviceId} (msgid ${message[ToDeviceMessageId]})`);
            }
        }

        logger.info(
            `Sending batch of to-device messages. type=${request.event_type} txnid=${request.txn_id}`,
            messageList,
        );

        const path =
            `/_matrix/client/v3/sendToDevice/${encodeURIComponent(request.event_type)}/` +
            encodeURIComponent(request.txn_id);
        return await this.requestWithRetry(Method.Put, path, {}, request.body);
    }

    private async makeRequestWithUIA<T>(
        method: Method,
        path: string,
        queryParams: QueryDict,
        body: string,
        uiaCallback: UIAuthCallback<T> | undefined,
    ): Promise<string> {
        if (!uiaCallback) {
            return await this.requestWithRetry(method, path, queryParams, body);
        }

        const parsedBody = JSON.parse(body);
        const makeRequest = async (auth: AuthDict | null): Promise<UIAResponse<T>> => {
            const newBody: Record<string, any> = {
                ...parsedBody,
            };
            if (auth !== null) {
                newBody.auth = auth;
            }
            const resp = await this.requestWithRetry(method, path, queryParams, JSON.stringify(newBody));
            return JSON.parse(resp) as T;
        };

        const resp = await uiaCallback(makeRequest);
        return JSON.stringify(resp);
    }

    private async requestWithRetry(
        method: Method,
        path: string,
        queryParams: QueryDict,
        body: string,
    ): Promise<string> {
        let currentRetryCount = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                return await this.rawJsonRequest(method, path, queryParams, body);
            } catch (e) {
                currentRetryCount++;
                const backoff = calculateRetryBackoff(e, currentRetryCount, true);
                if (backoff < 0) {
                    // Max number of retries reached, or error is not retryable. rethrow the error
                    throw e;
                }
                // wait for the specified time and then retry the request
                await sleep(backoff);
            }
        }
    }

    private async rawJsonRequest(method: Method, path: string, queryParams: QueryDict, body: string): Promise<string> {
        const opts = {
            // inhibit the JSON stringification and parsing within HttpApi.
            json: false,

            // nevertheless, we are sending, and accept, JSON.
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },

            // we use the full prefix
            prefix: "",
        };

        return await this.http.authedRequest<string>(method, path, queryParams, body, opts);
    }
}
