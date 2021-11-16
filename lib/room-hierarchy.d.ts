/**
 * @module room-hierarchy
 */
import { Room } from "./models/room";
import { IHierarchyRoom, IHierarchyRelation } from "./@types/spaces";
export declare class RoomHierarchy {
    readonly root: Room;
    private readonly pageSize?;
    private readonly maxDepth?;
    private readonly suggestedOnly;
    readonly viaMap: Map<string, Set<string>>;
    readonly backRefs: Map<string, string[]>;
    readonly roomMap: Map<string, IHierarchyRoom>;
    private loadRequest;
    private nextBatch?;
    private _rooms?;
    private serverSupportError?;
    /**
     * Construct a new RoomHierarchy
     *
     * A RoomHierarchy instance allows you to easily make use of the /hierarchy API and paginate it.
     *
     * @param {Room} root the root of this hierarchy
     * @param {number} pageSize the maximum number of rooms to return per page, can be overridden per load request.
     * @param {number} maxDepth the maximum depth to traverse the hierarchy to
     * @param {boolean} suggestedOnly whether to only return rooms with suggested=true.
     * @constructor
     */
    constructor(root: Room, pageSize?: number, maxDepth?: number, suggestedOnly?: boolean);
    get noSupport(): boolean;
    get canLoadMore(): boolean;
    get loading(): boolean;
    get rooms(): IHierarchyRoom[];
    load(pageSize?: number): Promise<IHierarchyRoom[]>;
    getRelation(parentId: string, childId: string): IHierarchyRelation;
    isSuggested(parentId: string, childId: string): boolean;
    removeRelation(parentId: string, childId: string): void;
}
//# sourceMappingURL=room-hierarchy.d.ts.map