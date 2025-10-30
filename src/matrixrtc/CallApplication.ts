import { RtcSlotEventContent, SlotDescription } from "./types";

export const DefaultCallApplicationDescription: SlotDescription = {
    id: "",
    application: "m.call"
};

/**
 * Matrix RTC Slot event for the "m.call" application type.
 */
export interface CallSlotEventContent extends RtcSlotEventContent<"m.call"> {
    application: {
        "type": "m.call";
        "m.call.id"?: string;
    };
    slot_id: `${string}#${string}`,
}
/**
 * Default slot for a room using "m.call".
 */
export const DefaultCallApplicationSlot: CallSlotEventContent = {
    application: {
        "type": "m.call",
    },
    slot_id: "m.call#",
};
