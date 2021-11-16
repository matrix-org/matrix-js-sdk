import { ISavedSync } from "./index";
import { IEvent, IStartClientOpts, ISyncResponse } from "..";
export interface IIndexedDBBackend {
    connect(): Promise<void>;
    syncToDatabase(userTuples: UserTuple[]): Promise<void>;
    isNewlyCreated(): Promise<boolean>;
    setSyncData(syncData: ISyncResponse): Promise<void>;
    getSavedSync(): Promise<ISavedSync>;
    getNextBatchToken(): Promise<string>;
    clearDatabase(): Promise<void>;
    getOutOfBandMembers(roomId: string): Promise<IEvent[] | null>;
    setOutOfBandMembers(roomId: string, membershipEvents: IEvent[]): Promise<void>;
    clearOutOfBandMembers(roomId: string): Promise<void>;
    getUserPresenceEvents(): Promise<UserTuple[]>;
    getClientOptions(): Promise<IStartClientOpts>;
    storeClientOptions(options: IStartClientOpts): Promise<void>;
}
export declare type UserTuple = [userId: string, presenceEvent: Partial<IEvent>];
//# sourceMappingURL=indexeddb-backend.d.ts.map