import { MatrixClient } from "../client";
import { IEncryptedFile } from "../@types/event";
import { Room } from "./room";
import { IContent } from "./event";
import { MSC3089Branch } from "./MSC3089Branch";
import { ISendEventResponse } from "../@types/requests";
/**
 * The recommended defaults for a tree space's power levels. Note that this
 * is UNSTABLE and subject to breaking changes without notice.
 */
export declare const DEFAULT_TREE_POWER_LEVELS_TEMPLATE: {
    invite: number;
    kick: number;
    ban: number;
    redact: number;
    state_default: number;
    events_default: number;
    users_default: number;
    events: {
        "m.room.power_levels": number;
        "m.room.history_visibility": number;
        "m.room.tombstone": number;
        "m.room.encryption": number;
        "m.room.name": number;
        "m.room.message": number;
        "m.room.encrypted": number;
        "m.sticker": number;
    };
    users: {};
};
/**
 * Ease-of-use representation for power levels represented as simple roles.
 * Note that this is UNSTABLE and subject to breaking changes without notice.
 */
export declare enum TreePermissions {
    Viewer = "viewer",
    Editor = "editor",
    Owner = "owner"
}
/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089)
 * file tree Space. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */
export declare class MSC3089TreeSpace {
    private client;
    readonly roomId: string;
    readonly room: Room;
    constructor(client: MatrixClient, roomId: string);
    /**
     * Syntactic sugar for room ID of the Space.
     */
    get id(): string;
    /**
     * Whether or not this is a top level space.
     */
    get isTopLevel(): boolean;
    /**
     * Sets the name of the tree space.
     * @param {string} name The new name for the space.
     * @returns {Promise<void>} Resolves when complete.
     */
    setName(name: string): Promise<void>;
    /**
     * Invites a user to the tree space. They will be given the default Viewer
     * permission level unless specified elsewhere.
     * @param {string} userId The user ID to invite.
     * @param {boolean} andSubspaces True (default) to invite the user to all
     * directories/subspaces too, recursively.
     * @param {boolean} shareHistoryKeys True (default) to share encryption keys
     * with the invited user. This will allow them to decrypt the events (files)
     * in the tree. Keys will not be shared if the room is lacking appropriate
     * history visibility (by default, history visibility is "shared" in trees,
     * which is an appropriate visibility for these purposes).
     * @returns {Promise<void>} Resolves when complete.
     */
    invite(userId: string, andSubspaces?: boolean, shareHistoryKeys?: boolean): Promise<void>;
    private retryInvite;
    /**
     * Sets the permissions of a user to the given role. Note that if setting a user
     * to Owner then they will NOT be able to be demoted. If the user does not have
     * permission to change the power level of the target, an error will be thrown.
     * @param {string} userId The user ID to change the role of.
     * @param {TreePermissions} role The role to assign.
     * @returns {Promise<void>} Resolves when complete.
     */
    setPermissions(userId: string, role: TreePermissions): Promise<void>;
    /**
     * Gets the current permissions of a user. Note that any users missing explicit permissions (or not
     * in the space) will be considered Viewers. Appropriate membership checks need to be performed
     * elsewhere.
     * @param {string} userId The user ID to check permissions of.
     * @returns {TreePermissions} The permissions for the user, defaulting to Viewer.
     */
    getPermissions(userId: string): TreePermissions;
    /**
     * Creates a directory under this tree space, represented as another tree space.
     * @param {string} name The name for the directory.
     * @returns {Promise<MSC3089TreeSpace>} Resolves to the created directory.
     */
    createDirectory(name: string): Promise<MSC3089TreeSpace>;
    /**
     * Gets a list of all known immediate subdirectories to this tree space.
     * @returns {MSC3089TreeSpace[]} The tree spaces (directories). May be empty, but not null.
     */
    getDirectories(): MSC3089TreeSpace[];
    /**
     * Gets a subdirectory of a given ID under this tree space. Note that this will not recurse
     * into children and instead only look one level deep.
     * @param {string} roomId The room ID (directory ID) to find.
     * @returns {MSC3089TreeSpace} The directory, or falsy if not found.
     */
    getDirectory(roomId: string): MSC3089TreeSpace;
    /**
     * Deletes the tree, kicking all members and deleting **all subdirectories**.
     * @returns {Promise<void>} Resolves when complete.
     */
    delete(): Promise<void>;
    private getOrderedChildren;
    private getParentRoom;
    /**
     * Gets the current order index for this directory. Note that if this is the top level space
     * then -1 will be returned.
     * @returns {number} The order index of this space.
     */
    getOrder(): number;
    /**
     * Sets the order index for this directory within its parent. Note that if this is a top level
     * space then an error will be thrown. -1 can be used to move the child to the start, and numbers
     * larger than the number of children can be used to move the child to the end.
     * @param {number} index The new order index for this space.
     * @returns {Promise<void>} Resolves when complete.
     * @throws Throws if this is a top level space.
     */
    setOrder(index: number): Promise<void>;
    /**
     * Creates (uploads) a new file to this tree. The file must have already been encrypted for the room.
     * @param {string} name The name of the file.
     * @param {ArrayBuffer} encryptedContents The encrypted contents.
     * @param {Partial<IEncryptedFile>} info The encrypted file information.
     * @param {IContent} additionalContent Optional event content fields to include in the message.
     * @returns {Promise<ISendEventResponse>} Resolves to the file event's sent response.
     */
    createFile(name: string, encryptedContents: ArrayBuffer, info: Partial<IEncryptedFile>, additionalContent?: IContent): Promise<ISendEventResponse>;
    /**
     * Retrieves a file from the tree.
     * @param {string} fileEventId The event ID of the file.
     * @returns {MSC3089Branch} The file, or falsy if not found.
     */
    getFile(fileEventId: string): MSC3089Branch;
    /**
     * Gets an array of all known files for the tree.
     * @returns {MSC3089Branch[]} The known files. May be empty, but not null.
     */
    listFiles(): MSC3089Branch[];
    /**
     * Gets an array of all known files for the tree, including inactive/invalid ones.
     * @returns {MSC3089Branch[]} The known files. May be empty, but not null.
     */
    listAllFiles(): MSC3089Branch[];
}
//# sourceMappingURL=MSC3089TreeSpace.d.ts.map