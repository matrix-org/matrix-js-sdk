/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import * as Rust from "@matrix-org/matrix-sdk-crypto-wasm";

import { FakeHomeserver, type OutgoingRequestLike, type ToDeviceEvent } from "./fakeHomeserver.ts";

export const TEST_ROOM_ID = "!bench:localhost";

const SENDER_USER_ID = "@alice:localhost";
const RECIPIENT_USER_ID = "@bob:localhost";

/** `drainOutgoingRequests` gives up after this many rounds rather than spinning forever. */
const MAX_DRAIN_ROUNDS = 32;

/**
 * Hard cap matrix-sdk-crypto puts on how many events a single outbound megolm session may encrypt.
 *
 * `OutboundGroupSession::expired` clamps `rotation_period_msgs` to at most 10,000 whatever the encryption
 * settings ask for, and `GroupSessionManager::encrypt` asserts the session has not expired, so going over
 * panics the wasm module rather than returning an error.
 */
const MAX_MESSAGES_PER_SESSION = 10_000;

let wasmInit: Promise<void> | undefined;

export function initWasm(): Promise<void> {
    return (wasmInit ??= Rust.initAsync());
}

/** Encryption settings tuned so a session is never rotated out from under a benchmark. */
export function benchEncryptionSettings(): Rust.EncryptionSettings {
    const settings = new Rust.EncryptionSettings();
    settings.algorithm = Rust.EncryptionAlgorithm.MegolmV1AesSha2;
    settings.historyVisibility = Rust.HistoryVisibility.Shared;
    // Cross-signing is out of scope here, so share with every device regardless of trust.
    settings.sharingStrategy = Rust.CollectStrategy.allDevices();
    settings.rotationPeriod = 7n * 24n * 60n * 60n * 1_000_000n;
    // Silently clamped to MAX_MESSAGES_PER_SESSION upstream, hence rotatingEncryptor.
    settings.rotationPeriodMessages = BigInt(MAX_MESSAGES_PER_SESSION);
    return settings;
}

function decryptionSettings(): Rust.DecryptionSettings {
    return new Rust.DecryptionSettings(Rust.TrustRequirement.Untrusted);
}

/** An `OlmMachine` plus the plumbing needed to exchange requests with {@link FakeHomeserver}. */
export class BenchMachine {
    private constructor(
        public readonly machine: Rust.OlmMachine,
        public readonly userId: string,
        public readonly deviceId: string,
        private readonly hs: FakeHomeserver,
    ) {}

    public static async create(hs: FakeHomeserver, userId: string, deviceId: string): Promise<BenchMachine> {
        await initWasm();
        const machine = await Rust.OlmMachine.initialize(new Rust.UserId(userId), new Rust.DeviceId(deviceId));
        const benchMachine = new BenchMachine(machine, userId, deviceId, hs);
        await benchMachine.drainOutgoingRequests();
        return benchMachine;
    }

    /** Answers every pending outgoing request until the machine has nothing left to say. */
    public async drainOutgoingRequests(): Promise<void> {
        for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
            const requests = await this.machine.outgoingRequests();
            if (requests.length === 0) return;
            for (const request of requests) {
                await this.send(request as unknown as OutgoingRequestLike);
            }
        }
        throw new Error(`${this.deviceId} still has outgoing requests after ${MAX_DRAIN_ROUNDS} rounds`);
    }

    private async send(request: OutgoingRequestLike): Promise<void> {
        const response = this.hs.handle(this, request);
        await this.machine.markRequestAsSent(request.id, request.type, response);
    }

    /** Starts tracking the given users and resolves their device lists. */
    public async trackUsers(userIds: string[]): Promise<void> {
        await this.machine.updateTrackedUsers(userIds.map((userId) => new Rust.UserId(userId)));
        await this.drainOutgoingRequests();
    }

    /** Claims one-time keys so there is an Olm session with every device of the given users. */
    public async establishOlmSessions(userIds: string[]): Promise<void> {
        const request = await this.machine.getMissingSessions(userIds.map((userId) => new Rust.UserId(userId)));
        if (request) await this.send(request as unknown as OutgoingRequestLike);
    }

    /** Shares the room key and dispatches the resulting to-device requests. */
    public async shareRoomKey(
        roomId: string,
        userIds: string[],
        settings: Rust.EncryptionSettings = benchEncryptionSettings(),
    ): Promise<number> {
        const requests = await this.machine.shareRoomKey(
            new Rust.RoomId(roomId),
            userIds.map((userId) => new Rust.UserId(userId)),
            settings,
        );
        for (const request of requests) {
            await this.send(request as unknown as OutgoingRequestLike);
        }
        return requests.length;
    }

    /** Throws away the current outbound group session, so the next share creates a new one. */
    public async invalidateRoomKey(roomId: string): Promise<void> {
        await this.machine.invalidateGroupSession(new Rust.RoomId(roomId));
    }

    /** Feeds everything queued for this device into the machine. */
    public async receivePendingToDevice(): Promise<Rust.ProcessedToDeviceEvent[]> {
        return await this.receiveToDevice(this.hs.takeInbox(this.userId, this.deviceId));
    }

    public async receiveToDevice(events: ToDeviceEvent[]): Promise<Rust.ProcessedToDeviceEvent[]> {
        return await this.machine.receiveSyncChanges(
            JSON.stringify(events),
            new Rust.DeviceLists(),
            new Map([["signed_curve25519", this.hs.oneTimeKeyCount(this.userId, this.deviceId)]]),
            undefined,
            decryptionSettings(),
        );
    }

    public async encryptRoomEvent(roomId: string, eventType: string, content: string): Promise<string> {
        return await this.machine.encryptRoomEvent(new Rust.RoomId(roomId), eventType, content);
    }

    public async decryptRoomEvent(roomId: string, event: string): Promise<Rust.DecryptedRoomEvent> {
        return await this.machine.decryptRoomEvent(event, new Rust.RoomId(roomId), decryptionSettings());
    }

    public close(): void {
        this.machine.close();
    }
}

/** Wraps encrypted content in the event envelope `decryptRoomEvent` expects, mirroring the SDK's own shape. */
export function wireEvent(sender: string, encryptedContent: string, index: number): string {
    return JSON.stringify({
        event_id: `$bench-${index}`,
        type: "m.room.encrypted",
        sender,
        content: JSON.parse(encryptedContent),
        origin_server_ts: 1_600_000_000_000 + index,
    });
}

/**
 * Registers device keys and one-time keys for extra devices, then discards the machines that produced them.
 *
 * Only the published keys matter for key-sharing benchmarks, and keeping hundreds of live `OlmMachine`s
 * around costs far more memory than it buys.
 */
export async function registerExtraDevices(hs: FakeHomeserver, userId: string, count: number): Promise<void> {
    const existing = hs.deviceIds(userId).length;
    for (let i = 0; i < count; i++) {
        const machine = await BenchMachine.create(hs, userId, `BENCHDEV${existing + i}`);
        machine.close();
    }
}

export interface RoomFixtureOptions {
    /** Recipient devices kept alive so they can receive keys and decrypt. */
    liveRecipients?: number;
    /** Extra recipient devices that only exist as published keys. */
    extraDevices?: number;
}

export interface RoomFixture {
    hs: FakeHomeserver;
    sender: BenchMachine;
    recipients: BenchMachine[];
    roomId: string;
    recipientUserId: string;
    deviceCount: number;
}

/**
 * Builds a sender and a set of recipient devices with device lists resolved and Olm sessions established,
 * ready for room-key sharing.
 */
export async function createRoomFixture({
    liveRecipients = 1,
    extraDevices = 0,
}: RoomFixtureOptions = {}): Promise<RoomFixture> {
    const hs = new FakeHomeserver();

    const sender = await BenchMachine.create(hs, SENDER_USER_ID, "SENDERDEVICE");

    const recipients: BenchMachine[] = [];
    for (let i = 0; i < liveRecipients; i++) {
        recipients.push(await BenchMachine.create(hs, RECIPIENT_USER_ID, `LIVEDEV${i}`));
    }
    await registerExtraDevices(hs, RECIPIENT_USER_ID, extraDevices);

    await sender.trackUsers([RECIPIENT_USER_ID]);
    await sender.establishOlmSessions([RECIPIENT_USER_ID]);

    for (const recipient of recipients) {
        await recipient.trackUsers([SENDER_USER_ID]);
    }

    return {
        hs,
        sender,
        recipients,
        roomId: TEST_ROOM_ID,
        recipientUserId: RECIPIENT_USER_ID,
        deviceCount: hs.deviceIds(RECIPIENT_USER_ID).length,
    };
}

/** Shares the room key from the sender and delivers it to every live recipient. */
export async function shareAndDeliverRoomKey(fixture: RoomFixture): Promise<void> {
    await fixture.sender.shareRoomKey(fixture.roomId, [fixture.recipientUserId]);
    for (const recipient of fixture.recipients) {
        await recipient.receivePendingToDevice();
    }
}

/**
 * An `encryptRoomEvent` that rotates the room key before the outbound session reaches
 * {@link MAX_MESSAGES_PER_SESSION}, which a benchmark loop otherwise blows through in seconds.
 *
 * Rotation costs one slow call in every {@link MAX_MESSAGES_PER_SESSION}, so it lands well under the
 * run-to-run noise floor, and the count is tracked per encrypt rather than per batch so it cannot drift.
 */
export function rotatingEncryptor(fixture: RoomFixture): (content: string) => Promise<string> {
    let remaining = 0;
    return async (content) => {
        if (remaining === 0) {
            await fixture.sender.invalidateRoomKey(fixture.roomId);
            await shareAndDeliverRoomKey(fixture);
            remaining = MAX_MESSAGES_PER_SESSION - 1;
        }
        remaining--;
        return await fixture.sender.encryptRoomEvent(fixture.roomId, "m.room.message", content);
    };
}
