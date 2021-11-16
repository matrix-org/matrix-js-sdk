import { IPublicRoomsChunkRoom } from "../client";
import { RoomType } from "./event";
import { IStrippedState } from "../sync-accumulator";
/** @deprecated Use hierarchy instead where possible. */
export interface ISpaceSummaryRoom extends IPublicRoomsChunkRoom {
    num_refs: number;
    room_type: string;
}
/** @deprecated Use hierarchy instead where possible. */
export interface ISpaceSummaryEvent {
    room_id: string;
    event_id: string;
    origin_server_ts: number;
    type: string;
    state_key: string;
    sender: string;
    content: {
        order?: string;
        suggested?: boolean;
        auto_join?: boolean;
        via?: string[];
    };
}
export interface IHierarchyRelation extends IStrippedState {
    room_id: string;
    origin_server_ts: number;
    content: {
        order?: string;
        suggested?: boolean;
        via?: string[];
    };
}
export interface IHierarchyRoom extends IPublicRoomsChunkRoom {
    room_type?: RoomType | string;
    children_state: IHierarchyRelation[];
}
//# sourceMappingURL=spaces.d.ts.map