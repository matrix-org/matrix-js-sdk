/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { User, UserEvent } from "./models/user";
import { NotificationCountType, Room, RoomEvent } from "./models/room";
import {ConnectionManagement } from "./conn-management";
import { logger } from './logger';
import { ClientEvent, IStoredClientOpts, MatrixClient, PendingEventOrdering } from "./client";
import { ISyncStateData } from "./sync";
import { MatrixEvent } from "./models/event";
import { MatrixError } from "./http-api";
import { RoomStateEvent } from "./models/room-state";
import { RoomMemberEvent } from "./models/room-member";
import {SyncState } from "./sync";
import { MSC3575SlidingSyncResponse, SlidingList, SlidingSync, SlidingSyncState } from "./sliding-sync";

const DEBUG = true;

// Number of consecutive failed syncs that will lead to a syncState of ERROR as opposed
// to RECONNECTING. This is needed to inform the client of server issues when the
// keepAlive is successful but the server /sync fails.
const FAILED_SYNC_ERROR_THRESHOLD = 3;

function debuglog(...params) {
    if (!DEBUG) {
        return;
    }
    logger.log(...params);
}

/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 * @param {module:crypto=} opts.crypto Crypto manager
 * @param {Function=} opts.canResetEntireTimeline A function which is called
 * with a room ID and returns a boolean. It should return 'true' if the SDK can
 * SAFELY remove events from this room. It may not be safe to remove events if
 * there are other references to the timelines for this room.
 * Default: returns false.
 */
export class SlidingSyncApi {
    private syncState: SyncState = null;
    private syncStateData: ISyncStateData;
    private slidingSync: SlidingSync;
    private connManagement: ConnectionManagement;
    private lastPos: string;
    private failCount: number;

    constructor(private readonly client: MatrixClient, private readonly opts: Partial<IStoredClientOpts> = {}) {
        this.opts.initialSyncLimit = this.opts.initialSyncLimit ?? 8;
        this.opts.resolveInvitesToProfiles = this.opts.resolveInvitesToProfiles || false;
        this.opts.pollTimeout = this.opts.pollTimeout || (30 * 1000);
        this.opts.pendingEventOrdering = this.opts.pendingEventOrdering || PendingEventOrdering.Chronological;
        this.opts.experimentalThreadSupport = this.opts.experimentalThreadSupport === true;

        if (!opts.canResetEntireTimeline) {
            opts.canResetEntireTimeline = (roomId: string) => {
                return false;
            };
        }

        if (client.getNotifTimelineSet()) {
            client.reEmitter.reEmit(client.getNotifTimelineSet(), [
                RoomEvent.Timeline,
                RoomEvent.TimelineReset,
            ]);
        }
        this.client = client;
        this.connManagement = new ConnectionManagement(client, this.updateSyncState.bind(this));
        this.lastPos = null;
        this.failCount = 0;

        // TODO: dependency inject
        this.slidingSync = new SlidingSync("http://localhost:8008", [
            new SlidingList({
                ranges: [[0,20]],
                sort: [],
                required_state: [
                    ["m.room.join_rules", ""],
                    ["m.room.avatar", ""],
                    ["m.room.tombstone", ""],
                ],
                timeline_limit: 1,
            }),
        ], {}, client, 30 * 1000);
        this.slidingSync.addLifecycleListener(this.onLifecycle.bind(this));
        this.slidingSync.addRoomDataListener(this.onRoomData.bind(this));
    }

    private onRoomData(roomId: string, roomData: object) {
        console.log("onRoomData", roomId, JSON.stringify(roomData));
    }

    private onLifecycle(state: SlidingSyncState, resp: MSC3575SlidingSyncResponse, err?: Error) {
        console.log("onLifecycle", state, err);
        switch (state) {
            case SlidingSyncState.Complete:
                this.updateSyncState(this.lastPos ? SyncState.Syncing : SyncState.Prepared, {
                    oldSyncToken: this.lastPos,
                    nextSyncToken: resp.pos,
                    catchingUp: false,
                    fromCache: false,
                });
                this.lastPos = resp.pos;
                break;
            case SlidingSyncState.RequestFinished:
                if (err) {
                    this.failCount += 1;
                    this.updateSyncState(this.failCount > FAILED_SYNC_ERROR_THRESHOLD ? SyncState.Error : SyncState.Reconnecting, {
                        error: new MatrixError(err),
                    });
                } else {
                    this.failCount = 0;
                }
                break;
        }
    }

    /**
     * Sync rooms the user has left.
     * @return {Promise} Resolved when they've been added to the store.
     */
    public async syncLeftRooms() {
        return []; // TODO
    }

    /**
     * Peek into a room. This will result in the room in question being synced so it
     * is accessible via getRooms(). Live updates for the room will be provided.
     * @param {string} roomId The room ID to peek into.
     * @return {Promise} A promise which resolves once the room has been added to the
     * store.
     */
    public async peek(roomId: string): Promise<Room> {
        return null; // TODO
    }

    /**
     * Stop polling for updates in the peeked room. NOPs if there is no room being
     * peeked.
     */
    public stopPeeking(): void {
        // TODO
    }

    /**
     * Returns the current state of this sync object
     * @see module:client~MatrixClient#event:"sync"
     * @return {?String}
     */
    public getSyncState(): SyncState {
        return this.syncState;
    }

    public retryImmediately() {
        return this.connManagement.retryImmediately();
    }

    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     * @return {?Object}
     */
    public getSyncStateData(): ISyncStateData {
        return this.syncStateData;
    }

    private shouldAbortSync(error: MatrixError): boolean {
        if (error.errcode === "M_UNKNOWN_TOKEN") {
            // The logout already happened, we just need to stop.
            logger.warn("Token no longer valid - assuming logout");
            this.stop();
            this.updateSyncState(SyncState.Error, { error });
            return true;
        }
        return false;
    }

    /**
     * Main entry point. Blocks until stop() is called.
     */
    public async sync() {
        this.connManagement.start();
        debuglog("Sliding sync init loop");

        //   1) We need to get push rules so we can check if events should bing as we get
        //      them from /sync.
        while (true) {
            try {
                debuglog("Getting push rules...");
                const result = await this.client.getPushRules();
                debuglog("Got push rules");
                this.client.pushRules = result;
                break;
            } catch (err) {
                logger.error("Getting push rules failed", err);
                if (this.shouldAbortSync(err)) {
                    return;
                }
            }
        }

        // start syncing
        await this.slidingSync.start();
    }

    /**
     * Stops the sync object from syncing.
     */
    public stop(): void {
        debuglog("SyncApi.stop");
        this.slidingSync.stop();
        this.connManagement.stop();
    }

    /**
     * Sets the sync state and emits an event to say so
     * @param {String} newState The new state string
     * @param {Object} data Object of additional data to emit in the event
     */
    private updateSyncState(newState: SyncState, data?: ISyncStateData): void {
        const old = this.syncState;
        this.syncState = newState;
        this.syncStateData = data;
        this.client.emit(ClientEvent.Sync, this.syncState, old, data);
    }
}


// Helper functions which set up JS SDK structs are below and are identical to the sync v2 counterparts,
// just outside the class.

function createNewUser(client: MatrixClient, userId: string): User {
    const user = new User(userId);
    client.reEmitter.reEmit(user, [
        UserEvent.AvatarUrl,
        UserEvent.DisplayName,
        UserEvent.Presence,
        UserEvent.CurrentlyActive,
        UserEvent.LastPresenceTs,
    ]);
    return user;
}


function createRoom(client: MatrixClient, roomId: string, opts: IStoredClientOpts): Room { // XXX cargoculted from sync.ts
    const {
        timelineSupport,
        unstableClientRelationAggregation,
    } = client;
    const room = new Room(roomId, client, client.getUserId(), {
        lazyLoadMembers: opts.lazyLoadMembers,
        pendingEventOrdering: opts.pendingEventOrdering,
        timelineSupport,
        unstableClientRelationAggregation,
    });
    client.reEmitter.reEmit(room, [
        RoomEvent.Name,
        RoomEvent.Redaction,
        RoomEvent.RedactionCancelled,
        RoomEvent.Receipt,
        RoomEvent.Tags,
        RoomEvent.LocalEchoUpdated,
        RoomEvent.AccountData,
        RoomEvent.MyMembership,
        RoomEvent.Timeline,
        RoomEvent.TimelineReset,
    ]);
    registerStateListeners(client, room);
    return room;
}

function registerStateListeners(client: MatrixClient, room: Room): void { // XXX cargoculted from sync.ts
    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly.
    client.reEmitter.reEmit(room.currentState, [
        RoomStateEvent.Events,
        RoomStateEvent.Members,
        RoomStateEvent.NewMember,
        RoomStateEvent.Update,
    ]);
    room.currentState.on(RoomStateEvent.NewMember, function(event, state, member) {
        member.user = client.getUser(member.userId);
        client.reEmitter.reEmit(member, [
            RoomMemberEvent.Name,
            RoomMemberEvent.Typing,
            RoomMemberEvent.PowerLevel,
            RoomMemberEvent.Membership,
        ]);
    });
}

function deregisterStateListeners(room: Room): void { // XXX cargoculted from sync.ts
    // could do with a better way of achieving this.
    room.currentState.removeAllListeners(RoomStateEvent.Events);
    room.currentState.removeAllListeners(RoomStateEvent.Members);
    room.currentState.removeAllListeners(RoomStateEvent.NewMember);
}