import { MatrixClient } from "../client";
import { IEncryptedFile } from "../@types/event";
import { IContent, MatrixEvent } from "./event";
import { MSC3089TreeSpace } from "./MSC3089TreeSpace";
/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) branch - a reference
 * to a file (leaf) in the tree. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */
export declare class MSC3089Branch {
    private client;
    readonly indexEvent: MatrixEvent;
    readonly directory: MSC3089TreeSpace;
    constructor(client: MatrixClient, indexEvent: MatrixEvent, directory: MSC3089TreeSpace);
    /**
     * The file ID.
     */
    get id(): string;
    /**
     * Whether this branch is active/valid.
     */
    get isActive(): boolean;
    /**
     * Version for the file, one-indexed.
     */
    get version(): number;
    private get roomId();
    /**
     * Deletes the file from the tree, including all prior edits/versions.
     * @returns {Promise<void>} Resolves when complete.
     */
    delete(): Promise<void>;
    /**
     * Gets the name for this file.
     * @returns {string} The name, or "Unnamed File" if unknown.
     */
    getName(): string;
    /**
     * Sets the name for this file.
     * @param {string} name The new name for this file.
     * @returns {Promise<void>} Resolves when complete.
     */
    setName(name: string): Promise<void>;
    /**
     * Gets whether or not a file is locked.
     * @returns {boolean} True if locked, false otherwise.
     */
    isLocked(): boolean;
    /**
     * Sets a file as locked or unlocked.
     * @param {boolean} locked True to lock the file, false otherwise.
     * @returns {Promise<void>} Resolves when complete.
     */
    setLocked(locked: boolean): Promise<void>;
    /**
     * Gets information about the file needed to download it.
     * @returns {Promise<{info: IEncryptedFile, httpUrl: string}>} Information about the file.
     */
    getFileInfo(): Promise<{
        info: IEncryptedFile;
        httpUrl: string;
    }>;
    /**
     * Gets the event the file points to.
     * @returns {Promise<MatrixEvent>} Resolves to the file's event.
     */
    getFileEvent(): Promise<MatrixEvent>;
    /**
     * Creates a new version of this file.
     * @param {string} name The name of the file.
     * @param {ArrayBuffer} encryptedContents The encrypted contents.
     * @param {Partial<IEncryptedFile>} info The encrypted file information.
     * @param {IContent} additionalContent Optional event content fields to include in the message.
     * @returns {Promise<void>} Resolves when uploaded.
     */
    createNewVersion(name: string, encryptedContents: ArrayBuffer, info: Partial<IEncryptedFile>, additionalContent?: IContent): Promise<void>;
    /**
     * Gets the file's version history, starting at this file.
     * @returns {Promise<MSC3089Branch[]>} Resolves to the file's version history, with the
     * first element being the current version and the last element being the first version.
     */
    getVersionHistory(): Promise<MSC3089Branch[]>;
}
//# sourceMappingURL=MSC3089Branch.d.ts.map