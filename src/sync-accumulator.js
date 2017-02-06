/*
Copyright 2017 Vector Creations Ltd

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
"use strict";


/**
 * Internal class.
 *
 * The purpose of this class is to accumulate /sync responses such that a
 * complete "initial" JSON response can be returned which accurately represents
 * the sum total of the /sync responses accumulated to date. It only handles
 * room data: that is, everything under the "rooms" top-level key.
 *
 * This class is used when persisting room data so a complete /sync response can
 * be loaded from disk and incremental syncs can be performed on the server,
 * rather than asking the server to do an initial sync on startup.
 */
class SyncAccumulator {

    /**
     * @param {Object} opts
     * @param {Number=} opts.maxTimelineEntries The ideal maximum number of
     * timeline entries to keep in the sync response. This is best-effort, as
     * clients do not always have a back-pagination token for each event, so
     * it's possible there may be slightly *less* than this value. There will
     * never be more.
     */
    constructor(opts) {
        opts = opts || {};
        opts.maxTimelineEntries = opts.maxTimelineEntries || 50;
        this.opts = opts;
        this.rooms = {
            // $room_id : {
            //   category: invite|join|leave,
            //   data: { ... sync json data ... }
            // }
        };
    }

    /**
     * Accumulate incremental /sync data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    accumulate(syncResponse) {
        if (!syncResponse.rooms) {
            return;
        }
        if (syncResponse.rooms.invite) {
            Object.keys(syncResponse.rooms.invite).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "invite", syncResponse.rooms.invite[roomId],
                );
            });
        }
        if (syncResponse.rooms.join) {
            Object.keys(syncResponse.rooms.join).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "join", syncResponse.rooms.join[roomId],
                );
            });
        }
        if (syncResponse.rooms.leave) {
            Object.keys(syncResponse.rooms.leave).forEach((roomId) => {
                this._accumulateRoom(
                    roomId, "leave", syncResponse.rooms.leave[roomId],
                );
            });
        }
    }

    _accumulateRoom(roomId, category, data) {
        // Valid /sync state transitions
        //       +--------+ <======+            1: Accept an invite
        //   +== | INVITE |        | (5)        2: Leave a room
        //   |   +--------+ =====+ |            3: Join a public room previously
        //   |(1)            (4) | |               left (handle as if new room)
        //   V         (2)       V |            4: Reject an invite
        // +------+ ========> +--------+         5: Invite to a room previously
        // | JOIN |    (3)    | LEAVE* |            left (handle as if new room)
        // +------+ <======== +--------+
        //
        // * equivalent to "no state"

        // We *NEVER* accumulate 'ephemeral' events because we don't want to
        // store stale typing notifs.
        if (data.ephemeral) {
            delete data.ephemeral;
        }

        if (!this.rooms[roomId]) { // (3) and (5)
            this.rooms[roomId] = {
                category: category,
                data: data,
            };
            return;
        }

        const r = this.rooms[roomId];
        if (r.category === category) {
            // append data to existing data structure
            if (category === "invite") {
                this._accumulateInviteState(r, data);
            } else if (category === "join") {
                this._accumulateJoinState(r, data);
            }
        } else if (category === "join" && r.category === "invite") { // (1)
            // invite -> join, replace data structure.
            this.rooms[roomId] = {
                category: "join",
                data: data,
            };
        } else if (category === "leave") { // (2) and (4)
            // invite|join -> leave, delete data structure, so (3) and (5) can
            // be hit if they rejoin/get reinvited.
            delete this.rooms[roomId];
        }
    }

    _accumulateInviteState(room, data) {
        if (!data.invite_state || !data.invite_state.events) { // no new data
            return;
        }
        // ensure current data structure is sound
        if (!room.data.invite_state) {
            room.data.invite_state = {};
        }
        if (!room.data.invite_state.events) {
            room.data.invite_state.events = [];
        }

        // clobber based on event type / state key
        // We expect invite_state to be small, so just loop over the events
        data.invite_state.events.forEach((e) => {
            let hasAdded = false;
            for (let i = 0; i < room.data.invite_state.events.length; i++) {
                const current = room.data.invite_state.events[i];
                if (current.type === e.type && current.state_key == e.state_key) {
                    room.data.invite_state.events[i] = e; // update
                    hasAdded = true;
                }
            }
            if (!hasAdded) {
                room.data.invite_state.events.push(e);
            }
        });
    }

    // Accumulate timeline and state events in a room.
    _accumulateJoinState(room, data) {
        // We expect this function to be called a lot (every /sync) so we want
        // this to be fast. /sync stores events in an array but we often want
        // to clobber based on type/state_key. Rather than convert arrays to
        // maps all the time, just keep private maps which contains
        // the set of updates to apply, which we'll do on getJSON().

        // State resolution:
        // The 'state' key is the delta from the previous sync (or start of time
        // if no token was supplied), to the START of the timeline. To obtain
        // the current state, we need to "roll forward" state by reading the
        // timeline. We want to store the current state so we can drop events
        // out the end of the timeline based on opts.maxTimelineEntries.
        //
        //      'state'     'timeline'     current state
        // |-------x<======================>x
        //          T   I   M   E
        //
        // When getJSON() is called, we 'roll back' the current state by the
        // number of entries in the timeline to work out what 'state' should be.

        // Back-pagination:
        // On an initial /sync, the server provides a back-pagination token for
        // the start of the timeline. When /sync deltas come down, they also
        // include back-pagination tokens for the start of the timeline. This
        // means not all events in the timeline have back-pagination tokens, as
        // it is only the ones at the START of the timeline which have them.
        // In order for us to have a valid timeline (and back-pagination token
        // to match), we need to make sure that when we remove old timeline
        // events, that we roll forward to an event which has a back-pagination
        // token. This means we can't keep a strict sliding-window based on
        // opts.maxTimelineEntries, and we may have a few less. We should never
        // have more though, provided that the /sync limit is less than or equal
        // to opts.maxTimelineEntries.

        // ensure current data structure is sound
        room.state = room.state || {};
        room.state.events = room.state.events || [];
        room._currentState = room._currentState || {};
        room.timeline = room.timeline || {};
        room.timeline.events = room.timeline.events || [];
        room.account_data = room.account_data || {};
        room.account_data.events = room.account_data.events || [];
        room.account_data._clobbers = room.account_data._clobbers || {};

        // TODO: state/timeline

        if (data.account_data) {
            // clobber based on type
            data.account_data.events.forEach((e) => {
                room.account_data._clobbers[e.type] = e;
            });
        }
    }

    /**
     * Return everything under the 'rooms' key from a /sync response which
     * accurately represents all room data.
     * @return {Object} A JSON object which has the same API shape as /sync.
     */
    getJSON() {
        const data = {
            join: {},
            invite: {},
            leave: {},
        };
        Object.keys(this.rooms).forEach((roomId) => {
            switch (this.rooms[roomId].category) {
                case "join":
                    data.join[roomId] = this.rooms[roomId].data;
                    break;
                case "invite":
                    data.invite[roomId] = this.rooms[roomId].data;
                    break;
                case "leave":
                    data.leave[roomId] = this.rooms[roomId].data;
                    break;
            }
        });
        return data;
    }
}

module.exports = SyncAccumulator;
