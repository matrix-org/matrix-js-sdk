/**
 * @module crypto/RoomList
 *
 * Manages the list of encrypted rooms
 */
import { CryptoStore } from './store/base';
export interface IRoomEncryption {
    algorithm: string;
    rotation_period_ms?: number;
    rotation_period_msgs?: number;
}
/**
 * @alias module:crypto/RoomList
 */
export declare class RoomList {
    private readonly cryptoStore;
    private roomEncryption;
    constructor(cryptoStore: CryptoStore);
    init(): Promise<void>;
    getRoomEncryption(roomId: string): IRoomEncryption;
    isRoomEncrypted(roomId: string): boolean;
    setRoomEncryption(roomId: string, roomInfo: IRoomEncryption): Promise<void>;
}
//# sourceMappingURL=RoomList.d.ts.map