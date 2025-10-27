import { RtcSlotEventContent } from "./types";

/**
 * Matrix RTC Slot event for the "m.call" application type.
 */
export interface CallSlotEventContent extends RtcSlotEventContent<"m.call"> {
    application: {
        type: "m.call",
        "m.call.id"?: string,
    }
}
/**
 * Default slot for a room using "m.call".
 */
export const DefaultCallApplicationSlot: CallSlotEventContent = {
    application: {
        type: "m.call",
        "m.call.id": ""
    }
};

