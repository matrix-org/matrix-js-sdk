import {
    KeysBackupRequest,
    KeysClaimRequest,
    KeysQueryRequest,
    KeysUploadRequest,
    RoomMessageRequest,
    SignatureUploadRequest,
    SigningKeysUploadRequest,
    ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import { IHttpOpts, MatrixHttpApi, Method } from "../http-api";
import { QueryDict } from "../utils";
import { ToDeviceMessageId } from "../@types/event";
import { logger } from "../logger";
import { AuthDict, UIAuthCallback } from "../interactive-auth";
import { UIAResponse } from "../matrix";

type SdkRequest =
    | KeysUploadRequest
    | KeysQueryRequest
    | KeysClaimRequest
    | KeysBackupRequest
    | RoomMessageRequest
    | SignatureUploadRequest
    | ToDeviceRequest
    | SigningKeysUploadRequest;

export class RequestSender {
    public constructor(private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>) {}

    /**
     * Creates an HTTP request for the given SDK request object and optional UIA callback.
     * The method and path of the HTTP request is determined based on the type of the SDK request object.
     *
     * @param request The SDK request object to create an HTTP request for.
     * @param uiaCallback An optional UIA callback to use for interactive authentication.
     * @returns A promise that resolves with the HTTP response body as a string.
     */
    public async createHttpRequest<T>(request: SdkRequest, uiaCallback?: UIAuthCallback<T>): Promise<string> {
        let respPromise: Promise<string>;

        if (request instanceof KeysUploadRequest) {
            respPromise = this.rawJsonRequest(Method.Post, "/_matrix/client/v3/keys/upload", {}, request.body);
        } else if (request instanceof KeysQueryRequest) {
            respPromise = this.rawJsonRequest(Method.Post, "/_matrix/client/v3/keys/query", {}, request.body);
        } else if (request instanceof KeysClaimRequest) {
            respPromise = this.rawJsonRequest(Method.Post, "/_matrix/client/v3/keys/claim", {}, request.body);
        } else if (request instanceof KeysBackupRequest) {
            respPromise = this.rawJsonRequest(
                Method.Put,
                "/_matrix/client/v3/room_keys/keys",
                { version: request.version },
                request.body,
            );
        } else if (request instanceof RoomMessageRequest) {
            const path =
                `/_matrix/client/v3/rooms/${encodeURIComponent(request.room_id)}/send/` +
                `${encodeURIComponent(request.event_type)}/${encodeURIComponent(request.txn_id)}`;
            respPromise = this.rawJsonRequest(Method.Put, path, {}, request.body);
        } else if (request instanceof SignatureUploadRequest) {
            respPromise = this.rawJsonRequest(
                Method.Post,
                "/_matrix/client/v3/keys/signatures/upload",
                {},
                request.body,
            );
        } else if (request instanceof ToDeviceRequest) {
            respPromise = this.sendToDeviceRequest(request);
        } else if (request instanceof SigningKeysUploadRequest) {
            respPromise = this.makeRequestWithUIA(
                Method.Post,
                "/_matrix/client/v3/keys/device_signing/upload",
                {},
                request.body,
                uiaCallback,
            );
        } else {
            respPromise = Promise.reject("Invalid request type");
        }

        return respPromise;
    }

    private async makeRequestWithUIA<T>(
        method: Method,
        path: string,
        queryParams: QueryDict,
        body: string,
        uiaCallback: UIAuthCallback<T> | undefined,
    ): Promise<string> {
        if (!uiaCallback) {
            return await this.rawJsonRequest(method, path, queryParams, body);
        }

        const parsedBody = JSON.parse(body);
        const makeRequest = async (auth: AuthDict | null): Promise<UIAResponse<T>> => {
            const newBody: Record<string, any> = {
                ...parsedBody,
            };
            if (auth !== null) {
                newBody.auth = auth;
            }
            const resp = await this.rawJsonRequest(method, path, queryParams, JSON.stringify(newBody));
            return JSON.parse(resp) as T;
        };

        return uiaCallback(makeRequest).then((resp) => JSON.stringify(resp));
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
        return await this.rawJsonRequest(Method.Put, path, {}, request.body);
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
