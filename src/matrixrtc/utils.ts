/*
Copyright 2025-2026 The Matrix.org Foundation C.I.C.

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

import { getEncryptionKeyMapKey, type CallMembershipIdentityParts } from "./EncryptionManager.ts";
import type { InboundEncryptionSession, EncryptionKeyMapKey, RtcSlotEventContent, SlotDescription } from "./types.ts";
import type { Room } from "../models/room.ts";
import { EventTimeline } from "../models/event-timeline.ts";
import { EventType } from "../@types/event.ts";

/**
 * Detects when a key for a given index is outdated.
 */
export class OutdatedKeyFilter {
    // Map of participantId -> keyIndex -> timestamp
    private tsBuffer: Map<EncryptionKeyMapKey, Map<number, number>> = new Map();

    /**
     * Check if there is a recent key with the same keyId (index) and then use the creationTS to decide what to
     * do with the key. If the key received is older than the one already in the buffer, it is ignored.
     * @param participantId
     * @param item
     */
    public isOutdated(membership: CallMembershipIdentityParts, item: InboundEncryptionSession): boolean {
        const mapKey = getEncryptionKeyMapKey(membership);
        if (!this.tsBuffer.has(mapKey)) {
            this.tsBuffer.set(mapKey, new Map<number, number>());
        }

        const latestTimestamp = this.tsBuffer.get(mapKey)?.get(item.keyIndex);
        if (latestTimestamp && latestTimestamp > item.creationTS) {
            // The existing key is more recent, ignore this one
            return true;
        }
        this.tsBuffer.get(mapKey)!.set(item.keyIndex, item.creationTS);
        return false;
    }
}

/**
 * Converts a slot ID into it's component application and ID portions.
 * @param slotId e.g. `m.call#call_id`
 * @throws If the format of `slotId` is invalid.
 */
export function slotIdToDescription(slotId: string): SlotDescription {
    const [application, id, ...unexpectedAdditionalValues] = slotId.split("#");
    if (unexpectedAdditionalValues.length) {
        throw Error(
            "MatrixRTC Slot IDs *must* only contain two components seperated by one '#'. Additional '#' characters detected.",
        );
    }
    return { application, id };
}

/**
 * Converts a SlotDescription into it's slot ID format.
 */
export function computeSlotId(slotDescription: SlotDescription): string {
    return `${slotDescription.application}#${slotDescription.id}`;
}

/**
 * Reads the slot state event's content for the given slot description.
 *
 * @returns The slot event's content, or `undefined` if no slot event exists for the given description.
 */
export function getSlotEventContent(
    room: Pick<Room, "getLiveTimeline">,
    slotDescription: SlotDescription,
): RtcSlotEventContent | undefined {
    const slotId = computeSlotId(slotDescription);
    const slotEvent = room
        .getLiveTimeline()
        .getState(EventTimeline.FORWARDS)
        ?.getStateEvents(EventType.RTCSlot, slotId);
    if (!slotEvent) return undefined;

    return slotEvent.getContent<RtcSlotEventContent>();
}

/**
 * Whether the given slot is closed.
 *
 * @returns `true` if the slot is closed, `false` if the slot is open or `undefined`
 * if no slot exists.
 */
export function isSlotClosed(
    room: Pick<Room, "getLiveTimeline">,
    slotDescription: SlotDescription,
): boolean | undefined {
    const content = getSlotEventContent(room, slotDescription) as Partial<RtcSlotEventContent> | undefined;
    if (content === undefined) return undefined;

    return (
        content.status !== "open" ||
        typeof content.application !== "object" ||
        content.application?.type !== slotDescription.application
    );
}

/**
 * Whether the given slot is open.
 *
 * @returns `true` if the slot is open, `false` if the slot is closed or `undefined`
 * if no slot exists.
 */
export function isSlotOpen(room: Pick<Room, "getLiveTimeline">, slotDescription: SlotDescription): boolean | undefined {
    const closed = isSlotClosed(room, slotDescription);
    return closed === undefined ? undefined : !closed;
}
