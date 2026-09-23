import { UnstableValue } from "../NamespacedValue.ts";

/**
 * Event type for a room policy event.
 * NOTE: While MSC1763 has not been merged, `m.room.retention` is unfortunately
 * already in use in production.
 */
export const ROOM_RETENTION_TYPE = new UnstableValue("m.room.retention", "org.matrix.msc1763.retention");

/**
 * The content of a `m.room.retention` state event.
 */
export interface RoomRetentionContent {
    max_lifetime?: number;
    min_lifetime?: number;
}
