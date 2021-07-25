/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { MatrixClient } from "../client";
import { IEncryptedFile, UNSTABLE_MSC3089_BRANCH } from "../@types/event";
import { MatrixEvent } from "./event";

/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) branch - a reference
 * to a file (leaf) in the tree. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */
export class MSC3089Branch {
    public constructor(private client: MatrixClient, public readonly indexEvent: MatrixEvent) {
        // Nothing to do
    }

    /**
     * The file ID.
     */
    public get id(): string {
        return this.indexEvent.getStateKey();
    }

    /**
     * Whether this branch is active/valid.
     */
    public get isActive(): boolean {
        return this.indexEvent.getContent()["active"] === true;
    }

    private get roomId(): string {
        return this.indexEvent.getRoomId();
    }

    /**
     * Deletes the file from the tree.
     * @returns {Promise<void>} Resolves when complete.
     */
    public async delete(): Promise<void> {
        await this.client.sendStateEvent(this.roomId, UNSTABLE_MSC3089_BRANCH.name, {}, this.id);
        await this.client.redactEvent(this.roomId, this.id);

        // TODO: Delete edit history as well
    }

    /**
     * Gets the name for this file.
     * @returns {string} The name, or "Unnamed File" if unknown.
     */
    public getName(): string {
        return this.indexEvent.getContent()['name'] || "Unnamed File";
    }

    /**
     * Sets the name for this file.
     * @param {string} name The new name for this file.
     * @returns {Promise<void>} Resolves when complete.
     */
    public async setName(name: string): Promise<void> {
        await this.client.sendStateEvent(this.roomId, UNSTABLE_MSC3089_BRANCH.name, {
            ...this.indexEvent.getContent(),
            name: name,
        }, this.id);
    }

    /**
     * Gets information about the file needed to download it.
     * @returns {Promise<{info: IEncryptedFile, httpUrl: string}>} Information about the file.
     */
    public async getFileInfo(): Promise<{ info: IEncryptedFile, httpUrl: string }> {
        const room = this.client.getRoom(this.roomId);
        if (!room) throw new Error("Unknown room");

        const timeline = await this.client.getEventTimeline(room.getUnfilteredTimelineSet(), this.id);
        if (!timeline) throw new Error("Failed to get timeline for room event");

        const event = timeline.getEvents().find(e => e.getId() === this.id);
        if (!event) throw new Error("Failed to find event");

        // Sometimes the event context doesn't decrypt for us, so do that.
        await this.client.decryptEventIfNeeded(event, { emit: false, isRetry: false });

        const file = event.getContent()['file'];
        const httpUrl = this.client.mxcUrlToHttp(file['url']);

        return { info: file, httpUrl: httpUrl };
    }
}
