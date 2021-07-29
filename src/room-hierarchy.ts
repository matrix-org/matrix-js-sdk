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

/**
 * @module room-hierarchy
 */

import { Room } from "./models/room";
import { IHierarchyRoom, IHierarchyRelation } from "./@types/spaces";
import { MatrixClient } from "./client";
import { EventType } from "./@types/event";

export class RoomHierarchy {
    // Map from room id to list of servers which are listed as a via somewhere in the loaded hierarchy
    public readonly viaMap = new Map<string, Set<string>>();
    // Map from room id to list of rooms which claim this room as their child
    public readonly backRefs = new Map<string, string[]>();
    // Map from room id to object
    public readonly roomMap = new Map<string, IHierarchyRoom>();
    private loadRequest: ReturnType<MatrixClient["getRoomHierarchy"]>;
    private nextToken?: string;
    private _rooms?: IHierarchyRoom[];
    private serverSupportError?: Error;

    /**
     * Construct a new EventTimeline
     *
     * TODO
     * <p>An EventTimeline represents a contiguous sequence of events in a room.
     *
     * <p>As well as keeping track of the events themselves, it stores the state of
     * the room at the beginning and end of the timeline, and pagination tokens for
     * going backwards and forwards in the timeline.
     *
     * <p>In order that clients can meaningfully maintain an index into a timeline,
     * the EventTimeline object tracks a 'baseIndex'. This starts at zero, but is
     * incremented when events are prepended to the timeline. The index of an event
     * relative to baseIndex therefore remains constant.
     *
     * <p>Once a timeline joins up with its neighbour, they are linked together into a
     * doubly-linked list.
     *
     * @param {Room} root the root of this hierarchy
     * @param {number} pageSize the maximum number of rooms to return per page, can be overridden per load request.
     * @param {number} maxDepth the maximum depth to traverse the hierarchy to
     * @param {boolean} suggestedOnly whether to only return rooms with suggested=true.
     * @constructor
     */
    constructor(
        private readonly root: Room,
        private readonly pageSize?: number,
        private readonly maxDepth?: number,
        private readonly suggestedOnly = false,
    ) {}

    public get noSupport(): boolean {
        return !!this.serverSupportError;
    }

    public get canLoadMore(): boolean {
        return !!this.serverSupportError || !!this.nextToken || !this._rooms;
    }

    public get rooms(): IHierarchyRoom[] {
        return this._rooms;
    }

    public async load(pageSize = this.pageSize): Promise<IHierarchyRoom[]> {
        if (this.loadRequest) return this.loadRequest.then(r => r.rooms);

        this.loadRequest = this.root.client.getRoomHierarchy(
            this.root.roomId,
            pageSize,
            this.maxDepth,
            this.suggestedOnly,
            this.nextToken,
        );

        let rooms: IHierarchyRoom[];
        try {
            ({ rooms, next_token: this.nextToken } = await this.loadRequest);
        } catch (e) {
            if (e.errcode === "M_UNRECOGNIZED") {
                this.serverSupportError = e;
            } else {
                // TODO retry?
            }

            return [];
        } finally {
            this.loadRequest = null;
        }

        this._rooms = rooms; // TODO merge

        rooms.forEach(room => {
            this.roomMap.set(room.room_id, room);

            room.children_state.forEach(ev => {
                if (ev.type !== EventType.SpaceChild) return;
                const childRoomId = ev.state_key;

                // track backrefs for quicker hierarchy navigation
                if (!this.backRefs.has(childRoomId)) {
                    this.backRefs.set(childRoomId, []);
                }
                this.backRefs.get(childRoomId).push(ev.room_id);

                // fill viaMap
                if (Array.isArray(ev.content.via)) {
                    if (!this.viaMap.has(childRoomId)) {
                        this.viaMap.set(childRoomId, new Set());
                    }
                    const vias = this.viaMap.get(childRoomId);
                    ev.content.via.forEach(via => vias.add(via));
                }
            });
        });

        return rooms;
    }

    public getRelation(parentId: string, childId: string): IHierarchyRelation {
        return this.roomMap.get(parentId)?.children_state.find(e => e.state_key === childId);
    }

    public isSuggested(parentId: string, childId: string): boolean {
        return this.getRelation(parentId, childId)?.content.suggested;
    }

    public removeRelation(parentId: string, childId: string): void {
        const backRefs = this.backRefs.get(childId);
        if (backRefs?.length === 1) {
            this.backRefs.delete(childId);
        } else if (backRefs?.length) {
            this.backRefs.set(childId, backRefs.filter(ref => ref !== parentId));
        }

        const room = this.roomMap.get(parentId);
        if (room) {
            room.children_state = room.children_state.filter(ev => ev.state_key !== childId);
        }
    }
}
