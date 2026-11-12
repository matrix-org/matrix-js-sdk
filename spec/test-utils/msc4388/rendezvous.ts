/*
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

/*
 * Test implementations of both ends of the rendezvous session API from
 * [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4388): an in-memory homeserver, and the device
 * which scans the QR code (Device S).
 *
 * These are written from the text of the MSC and deliberately share no code with `src/rendezvous/transports`, so that
 * they are an independent check of it (e.g. of how the additional authentication data is put together).
 */

import {
    type Established,
    type Implementation,
    type QrCodeContents,
    type UnidirectionalSender,
} from "./implementations.ts";

/** The unstable prefix of the rendezvous API. */
const RENDEZVOUS_PATH = "/_matrix/client/unstable/io.element.msc4388/rendezvous";
/** The unstable value of the `M_CONCURRENT_WRITE` error code. */
const CONCURRENT_WRITE_ERRCODE = "IO_ELEMENT_MSC4388_CONCURRENT_WRITE";

/** `EncodeStringAsBytes8` from the MSC. */
function encodeStringAsBytes8(input: string): number[] {
    const utf8 = new TextEncoder().encode(input);
    if (utf8.length > 0xff) {
        throw new Error("String is too long");
    }
    return [utf8.length, ...utf8];
}

/**
 * ```
 * Aad := EncodeStringAsBytes8(BaseUrl) || EncodeStringAsBytes8(RendezvousId) || EncodeStringAsBytes8(SequenceToken)
 * ```
 */
export function buildAdditionalAuthenticationData(
    baseUrl: string,
    rendezvousId: string,
    sequenceToken: string,
): Uint8Array {
    return Uint8Array.from([baseUrl, rendezvousId, sequenceToken].flatMap(encodeStringAsBytes8));
}

/** A random string that is acceptable as an opaque identifier. */
function randomId(): string {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
}

interface RendezvousSession {
    data: string;
    sequenceToken: string;
    /** The response recorded for each `{txnId}` of a successful `PUT`. */
    transactions: Map<string, { sequence_token: string }>;
}

/**
 * An in-memory homeserver which implements only the rendezvous session API.
 */
export class FakeRendezvousServer {
    private readonly sessions = new Map<string, RendezvousSession>();
    private sequenceTokenCounter = 0;

    /** Every request that the server has handled, for making assertions on. */
    public readonly requests: { method: string; path: string; body?: any; status: number }[] = [];

    /**
     * @param baseUrl - the base URL that the server is reachable at, with or without a trailing `/`
     */
    public constructor(public readonly baseUrl: string) {}

    /** The current payload and sequence token of a rendezvous session. */
    public getSession(rendezvousId: string): { data: string; sequenceToken: string } | undefined {
        const session = this.sessions.get(rendezvousId);
        return session && { data: session.data, sequenceToken: session.sequenceToken };
    }

    /** Sequence tokens are opaque, so make them something that a client can't do arithmetic on. */
    private nextSequenceToken(): string {
        return `st${++this.sequenceTokenCounter}_${randomId().slice(0, 8)}`;
    }

    /** An implementation of `fetch()` which is served by this homeserver. */
    public readonly fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const { origin, pathname } = new URL(request.url);
        const bodyText = await request.text();

        let body: any;
        let response: { status: number; body: object };
        if (!`${origin}${pathname}`.startsWith(this.baseUrl.replace(/\/+$/, "") + RENDEZVOUS_PATH)) {
            response = { status: 404, body: { errcode: "M_UNRECOGNIZED", error: "Unrecognised request" } };
        } else {
            try {
                body = bodyText ? JSON.parse(bodyText) : undefined;
                const path = pathname.slice(pathname.indexOf(RENDEZVOUS_PATH) + RENDEZVOUS_PATH.length);
                response = this.handle(request.method, path.split("/").slice(1), body);
            } catch {
                response = { status: 400, body: { errcode: "M_NOT_JSON", error: "Request body is not JSON" } };
            }
        }

        this.requests.push({ method: request.method, path: pathname, body, status: response.status });
        return new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
        });
    };

    private handle(method: string, [rendezvousId, txnId]: string[], body: any): { status: number; body: object } {
        const notFound = { status: 404, body: { errcode: "M_NOT_FOUND", error: "Unknown rendezvous session" } };
        const badJson = { status: 400, body: { errcode: "M_BAD_JSON", error: "Missing or invalid field" } };
        const expiresInMs = 300000;

        if (method === "POST" && rendezvousId === undefined) {
            if (typeof body?.data !== "string") return badJson;
            const id = randomId();
            const session = { data: body.data, sequenceToken: this.nextSequenceToken(), transactions: new Map() };
            this.sessions.set(id, session);
            return { status: 200, body: { id, sequence_token: session.sequenceToken, expires_in_ms: expiresInMs } };
        }

        const session = rendezvousId === undefined ? undefined : this.sessions.get(rendezvousId);

        if (method === "GET" && txnId === undefined) {
            if (!session) return notFound;
            return {
                status: 200,
                body: { data: session.data, sequence_token: session.sequenceToken, expires_in_ms: expiresInMs },
            };
        }

        if (method === "PUT" && txnId !== undefined) {
            if (!session) return notFound;
            // a recorded transaction is replayed before the request body is validated
            const recorded = session.transactions.get(txnId);
            if (recorded) return { status: 200, body: recorded };
            if (typeof body?.data !== "string" || typeof body?.sequence_token !== "string") return badJson;
            if (body.sequence_token !== session.sequenceToken) {
                return {
                    status: 409,
                    body: { errcode: CONCURRENT_WRITE_ERRCODE, error: "Sequence token does not match" },
                };
            }
            session.data = body.data;
            session.sequenceToken = this.nextSequenceToken();
            const responseBody = { sequence_token: session.sequenceToken };
            session.transactions.set(txnId, responseBody);
            return { status: 200, body: responseBody };
        }

        if (method === "DELETE" && txnId === undefined) {
            if (!session) return notFound;
            this.sessions.delete(rendezvousId);
            return { status: 200, body: {} };
        }

        return { status: 404, body: { errcode: "M_UNRECOGNIZED", error: "Unrecognised request" } };
    }
}

/**
 * Device S: the device which scans the QR code.
 *
 * This implements the scanning device's side of the secure channel establishment (steps 4 and 6 of the MSC) and the
 * `SecureSend` and `SecureReceive` operations, on top of the rendezvous session API.
 */
export class ScanningDevice {
    /** The contents of the scanned QR code, as decoded by the implementation. */
    public readonly qrCode: QrCodeContents;
    /** The sequence token of the payload currently in the rendezvous session, as far as this device knows. */
    private sequenceToken?: string;
    private pendingChannel?: UnidirectionalSender;
    private channel?: Established;

    /**
     * @param implementation - the implementation of the QR code format and secure channel that the device uses
     * @param qrCodeBytes - the binary string read from the QR code
     * @param fetchFn - the `fetch()` to make requests to the homeserver with
     */
    public constructor(
        private readonly implementation: Implementation,
        qrCodeBytes: Uint8Array,
        private readonly fetchFn: typeof globalThis.fetch,
    ) {
        this.qrCode = implementation.decodeQrCode(qrCodeBytes);
    }

    /** The **CheckCode** to be shown to the user, once the channel has been established. */
    public get checkCode(): string | undefined {
        return this.channel?.checkCode;
    }

    /** The additional authentication data for a payload which replaces the one with the given sequence token. */
    private aad(sequenceToken: string): Uint8Array {
        // n.b. the base URL is used exactly as the implementation says it appears in the QR code
        return buildAdditionalAuthenticationData(this.qrCode.baseUrl, this.qrCode.rendezvousId, sequenceToken);
    }

    private async request<T>(method: "GET" | "PUT", pathSuffix = "", body?: object): Promise<T> {
        // the base URL in the QR code may or may not have a trailing slash
        const baseUrl = this.qrCode.baseUrl.replace(/\/+$/, "");
        const url = `${baseUrl}${RENDEZVOUS_PATH}/${encodeURIComponent(this.qrCode.rendezvousId)}${pathSuffix}`;
        const response = await this.fetchFn(url, {
            method,
            ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        const responseBody = await response.json();
        if (!response.ok) {
            throw new Error(`${method} failed with ${response.status} ${responseBody.errcode}: must abort`);
        }
        return responseBody;
    }

    private get(): Promise<{ data: string; sequence_token: string }> {
        return this.request("GET");
    }

    /** Sends a payload, replacing the one with the sequence token that we hold. */
    private async put(data: string): Promise<void> {
        // transaction IDs are shared with the other device, so use 128 random bits
        const txnId = randomId();
        const response = await this.request<{ sequence_token: string }>("PUT", `/${txnId}`, {
            sequence_token: this.sequenceToken,
            data,
        });
        this.sequenceToken = response.sequence_token;
    }

    /**
     * Waits for a new payload: one with a sequence token that differs from the one that we hold.
     *
     * @returns the payload, and the sequence token of the payload which it replaced
     */
    private async receive(): Promise<{ data: string; replacedSequenceToken: string }> {
        for (let attempt = 0; attempt < 100; attempt++) {
            const { data, sequence_token: sequenceToken } = await this.get();
            if (sequenceToken !== this.sequenceToken) {
                const replacedSequenceToken = this.sequenceToken!;
                this.sequenceToken = sequenceToken;
                return { data, replacedSequenceToken };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out waiting for a payload from the other device");
    }

    /**
     * Step 4 of the establishment: sends the **LoginInitiateMessage**.
     */
    public async sendLoginInitiate(): Promise<void> {
        const { data, sequence_token: sequenceToken } = await this.get();
        if (data !== "") {
            throw new Error("Rendezvous session has already been written to: must abort");
        }
        this.sequenceToken = sequenceToken;

        this.pendingChannel = await this.implementation.establishSender(
            this.qrCode.publicKey,
            "MATRIX_QR_CODE_LOGIN_INITIATE",
            this.aad(sequenceToken),
        );
        await this.put(this.pendingChannel.message);
    }

    /**
     * Step 6 of the establishment: receives and verifies the **LoginOkMessage**.
     *
     * @returns the **CheckCode** to be shown to the user
     */
    public async receiveLoginOk(): Promise<string> {
        if (!this.pendingChannel) {
            throw new Error("LoginInitiateMessage has not been sent");
        }
        const { data, replacedSequenceToken } = await this.receive();
        const { initialResponse, channel } = await this.pendingChannel.complete(data, this.aad(replacedSequenceToken));
        if (initialResponse !== "MATRIX_QR_CODE_LOGIN_OK") {
            throw new Error("Unexpected response from other device: must abort");
        }
        this.pendingChannel = undefined;
        this.channel = channel;
        return channel.checkCode;
    }

    /** `SecureSend`: sends a JSON payload to the other device over the secure channel. */
    public async secureSend(payload: object): Promise<void> {
        if (!this.channel) {
            throw new Error("Secure channel has not been established");
        }
        await this.put(await this.channel.seal(JSON.stringify(payload), this.aad(this.sequenceToken!)));
    }

    /** `SecureReceive`: waits for a JSON payload from the other device over the secure channel. */
    public async secureReceive(): Promise<any> {
        if (!this.channel) {
            throw new Error("Secure channel has not been established");
        }
        const { data, replacedSequenceToken } = await this.receive();
        return JSON.parse(await this.channel.open(data, this.aad(replacedSequenceToken)));
    }
}
