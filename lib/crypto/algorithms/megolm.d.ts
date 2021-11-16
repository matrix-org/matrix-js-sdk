import { Room } from '../../models/room';
import { DeviceInfo } from "../deviceinfo";
export declare function isRoomSharedHistory(room: Room): boolean;
export interface IOlmDevice<T = DeviceInfo> {
    userId: string;
    deviceInfo: T;
}
export interface IOutboundGroupSessionKey {
    chain_index: number;
    key: string;
}
//# sourceMappingURL=megolm.d.ts.map