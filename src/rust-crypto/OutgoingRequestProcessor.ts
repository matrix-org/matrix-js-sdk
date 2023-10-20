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
    OlmMachine,
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    RoomMessageRequest,
    SignatureUploadRequest,
    ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import { logger } from "../logger";
import { RequestSender } from "./RequestSender";

/**
 * Union type for all the request types returned by `OlmMachine.outgoingRequests`.
 *
 * @internal
 */
export type OutgoingRequest =
    | KeysUploadRequest
    | KeysQueryRequest
    | KeysClaimRequest
    | KeysBackupRequest
    | RoomMessageRequest
    | SignatureUploadRequest
    | ToDeviceRequest;

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
    public constructor(private readonly olmMachine: OlmMachine, public readonly requestSender: RequestSender) {}

    /**
     * Should be called at the end of each sync to process all the outgoing requests (`olmMachine.outgoingRequests()`).
     * This will send them all off, and mark them as sent in the olm machine.
     * If some requests fail, they will be retried on the next sync, and a log will describe the failure.
     *
     * @param requests - The outgoing requests to process.
     */
    public async processOutgoingRequests(requests: OutgoingRequest[]): Promise<void> {
        await Promise.all(
            requests.map(async (request) => {
                const { id, type } = request;
                try {
                    const resp = await this.requestSender.createHttpRequest(request);
                    if (id) {
                        await this.olmMachine.markRequestAsSent(id, type, resp);
                    }
                } catch (e) {
                    logger.error(`processOutgoingRequests: Failed to send outgoing request ${type}`, e);
                }
            }),
        );
    }

    /**
     * Use when you need to send a request directly and out of band of a sync.
     * If the request has an `id`, it will be marked as sent in the olm machine.
     *
     * In case of error it will be bubbled up, it's the caller responability to handle it.
     *
     * @param request - The request to send.
     * @returns the response body as a string.
     * @throws if the request fails.
     */
    public async sendOutgoingRequest(request: OutgoingRequest): Promise<string> {
        const { id, type } = request;
        const resp = await this.requestSender.createHttpRequest(request);
        if (id) {
            await this.olmMachine.markRequestAsSent(id, type, resp);
        }
        return resp;
    }
}
