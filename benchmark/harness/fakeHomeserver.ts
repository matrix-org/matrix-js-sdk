/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { RequestType } from "@matrix-org/matrix-sdk-crypto-wasm";

/** A to-device event as `OlmMachine.receiveSyncChanges` expects to find it. */
export interface ToDeviceEvent {
    sender: string;
    type: string;
    content: Record<string, unknown>;
}

/** The shape shared by every member of the wasm `OutgoingRequest` union. */
export interface OutgoingRequestLike {
    readonly id: string;
    readonly type: RequestType;
    readonly body: string;
    readonly event_type?: string;
}

export interface RequestSender {
    readonly userId: string;
    readonly deviceId: string;
}

type Json = Record<string, any>;

const addressOf = (userId: string, deviceId: string): string => `${userId}|${deviceId}`;

/**
 * An in-memory stand-in for the parts of the homeserver that `OlmMachine` talks to.
 *
 * It exists so benchmarks can wire several machines together without HTTP, JSON schema validation or
 * a sync loop in the way. Only the endpoints the crypto layer actually calls are implemented, and only
 * as far as the machines need them to behave.
 */
export class FakeHomeserver {
    /** userId -> deviceId -> signed device keys, as returned by `/keys/query`. */
    private readonly devices = new Map<string, Map<string, Json>>();
    /** address -> keyId -> one-time key; entries are removed as they are claimed. */
    private readonly oneTimeKeys = new Map<string, Json>();
    /** address -> keyId -> fallback key; reusable, so claims never run dry at scale. */
    private readonly fallbackKeys = new Map<string, Json>();
    /** address -> pending to-device events. */
    private readonly inboxes = new Map<string, ToDeviceEvent[]>();

    public handle(sender: RequestSender, request: OutgoingRequestLike): string {
        switch (request.type) {
            case RequestType.KeysUpload:
                return this.keysUpload(sender, JSON.parse(request.body));
            case RequestType.KeysQuery:
                return this.keysQuery(JSON.parse(request.body));
            case RequestType.KeysClaim:
                return this.keysClaim(JSON.parse(request.body));
            case RequestType.ToDevice:
                return this.sendToDevice(sender, request.event_type!, JSON.parse(request.body));
            case RequestType.SignatureUpload:
                return JSON.stringify({ failures: {} });
            case RequestType.RoomMessage:
                return JSON.stringify({ event_id: `$${request.id}` });
            case RequestType.KeysBackup:
                return JSON.stringify({ etag: "1", count: 0 });
            default:
                throw new Error(`FakeHomeserver: unhandled outgoing request type ${request.type}`);
        }
    }

    /** Removes and returns everything queued for a device. */
    public takeInbox(userId: string, deviceId: string): ToDeviceEvent[] {
        const address = addressOf(userId, deviceId);
        const events = this.inboxes.get(address) ?? [];
        this.inboxes.set(address, []);
        return events;
    }

    /**
     * Drops every queued to-device event.
     *
     * A benchmark that shares room keys thousands of times without a recipient draining them would
     * otherwise grow the inboxes without bound, and the resulting memory pressure shows up as drift.
     */
    public clearInboxes(): void {
        this.inboxes.clear();
    }

    public oneTimeKeyCount(userId: string, deviceId: string): number {
        return Object.keys(this.oneTimeKeys.get(addressOf(userId, deviceId)) ?? {}).length;
    }

    public deviceIds(userId: string): string[] {
        return [...(this.devices.get(userId)?.keys() ?? [])];
    }

    private keysUpload(sender: RequestSender, body: Json): string {
        if (body.device_keys) {
            const keys: Json = body.device_keys;
            let userDevices = this.devices.get(keys.user_id);
            if (!userDevices) {
                userDevices = new Map();
                this.devices.set(keys.user_id, userDevices);
            }
            userDevices.set(keys.device_id, keys);
        }

        const address = addressOf(sender.userId, sender.deviceId);
        if (body.one_time_keys) {
            this.oneTimeKeys.set(address, { ...this.oneTimeKeys.get(address), ...body.one_time_keys });
        }
        if (body.fallback_keys) {
            this.fallbackKeys.set(address, { ...this.fallbackKeys.get(address), ...body.fallback_keys });
        }

        // Reporting the true remaining count is what stops the machine from uploading more every round.
        return JSON.stringify({
            one_time_key_counts: { signed_curve25519: this.oneTimeKeyCount(sender.userId, sender.deviceId) },
        });
    }

    private keysQuery(body: Json): string {
        const deviceKeys: Json = {};

        for (const [userId, requested] of Object.entries<string[]>(body.device_keys ?? {})) {
            const userDevices = this.devices.get(userId);
            if (!userDevices) continue;

            // An empty array means "every device this user has".
            const wanted = requested.length === 0 ? [...userDevices.keys()] : requested;
            const forUser: Json = {};
            for (const deviceId of wanted) {
                const keys = userDevices.get(deviceId);
                if (keys) forUser[deviceId] = keys;
            }
            deviceKeys[userId] = forUser;
        }

        return JSON.stringify({
            device_keys: deviceKeys,
            failures: {},
            master_keys: {},
            self_signing_keys: {},
            user_signing_keys: {},
        });
    }

    private keysClaim(body: Json): string {
        const oneTimeKeys: Json = {};

        for (const [userId, devices] of Object.entries<Json>(body.one_time_keys ?? {})) {
            for (const deviceId of Object.keys(devices)) {
                const claimed = this.claimOneTimeKey(userId, deviceId);
                if (!claimed) continue;
                oneTimeKeys[userId] ??= {};
                oneTimeKeys[userId][deviceId] = claimed;
            }
        }

        return JSON.stringify({ one_time_keys: oneTimeKeys, failures: {} });
    }

    private claimOneTimeKey(userId: string, deviceId: string): Json | undefined {
        const address = addressOf(userId, deviceId);

        const pool = this.oneTimeKeys.get(address);
        const keyId = pool && Object.keys(pool)[0];
        if (pool && keyId !== undefined) {
            const key = pool[keyId];
            delete pool[keyId];
            return { [keyId]: key };
        }

        const fallback = this.fallbackKeys.get(address);
        const fallbackKeyId = fallback && Object.keys(fallback)[0];
        if (fallback && fallbackKeyId !== undefined) {
            return { [fallbackKeyId]: fallback[fallbackKeyId] };
        }

        return undefined;
    }

    private sendToDevice(sender: RequestSender, eventType: string, body: Json): string {
        for (const [userId, byDevice] of Object.entries<Json>(body.messages ?? {})) {
            for (const [deviceId, content] of Object.entries<Json>(byDevice)) {
                const targets = deviceId === "*" ? this.deviceIds(userId) : [deviceId];
                for (const target of targets) {
                    const address = addressOf(userId, target);
                    const inbox = this.inboxes.get(address) ?? [];
                    inbox.push({ sender: sender.userId, type: eventType, content });
                    this.inboxes.set(address, inbox);
                }
            }
        }

        return JSON.stringify({});
    }
}
