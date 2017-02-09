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
        this.inviteRooms = {
            //$roomId: { ... sync 'invite' json data ... }
        };
        this.joinRooms = {
            //$roomId: {
            //    _currentState: { $event_type: { $state_key: json } },
            //    _timeline: [
            //       { event: $event, token: null|token },
            //       { event: $event, token: null|token },
            //       { event: $event, token: null|token },
            //       ...
            //    ],
            //    _accountData: { $event_type: json }
            //}
        };
    }

    /**
     * Accumulate incremental /sync room data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    accumulateRooms(syncResponse) {
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
        switch (category) {
            case "invite": // (5)
                this._accumulateInviteState(roomId, data);
                break;
            case "join":
                if (this.inviteRooms[roomId]) { // (1)
                    // was previously invite, now join. We expect /sync to give
                    // the entire state and timeline on 'join', so delete previous
                    // invite state
                    delete this.inviteRooms[roomId];
                }
                // (3)
                // TODO: Check that join 'state' is the same if you leave then
                //       rejoin. We need to know if Synapse is instead returning
                //       a delta from the old leave state. If it is, this means
                //       we can NEVER delete 'leave' room data :/
                this._accumulateJoinState(roomId, data);
                break;
            case "leave":
                if (this.inviteRooms[roomId]) { // (4)
                    delete this.inviteRooms[roomId];
                } else { // (2)
                    delete this.joinRooms[roomId];
                }
                break;
            default:
                console.error("Unknown cateogory: ", category);
        }
    }

    _accumulateInviteState(roomId, data) {
        if (!data.invite_state || !data.invite_state.events) { // no new data
            return;
        }
        if (!this.inviteRooms[roomId]) {
            this.inviteRooms[roomId] = data;
            return;
        }
        // accumulate extra keys for invite->invite transitions
        // clobber based on event type / state key
        // We expect invite_state to be small, so just loop over the events
        const currentData = this.inviteRooms[roomId];
        data.invite_state.events.forEach((e) => {
            let hasAdded = false;
            for (let i = 0; i < currentData.invite_state.events.length; i++) {
                const current = currentData.invite_state.events[i];
                if (current.type === e.type && current.state_key == e.state_key) {
                    currentData.invite_state.events[i] = e; // update
                    hasAdded = true;
                }
            }
            if (!hasAdded) {
                currentData.invite_state.events.push(e);
            }
        });
    }

    // Accumulate timeline and state events in a room.
    _accumulateJoinState(roomId, data) {
        // We expect this function to be called a lot (every /sync) so we want
        // this to be fast. /sync stores events in an array but we often want
        // to clobber based on type/state_key. Rather than convert arrays to
        // maps all the time, just keep private maps which contain
        // the actual current accumulated sync state, and array-ify it when
        // getJSON() is called.

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
        //
        // We *NEVER* accumulate 'ephemeral' events because we don't want to
        // store stale typing notifs.

        if (!this.joinRooms[roomId]) {
            this.joinRooms[roomId] = {
                _currentState: {},
                _timeline: [],
                _accountData: {},
            };
        }
        const currentData = this.joinRooms[roomId];

        if (data.account_data && data.account_data.events) {
            // clobber based on type
            data.account_data.events.forEach((e) => {
                currentData._accountData[e.type] = e;
            });
        }

        // Work out the current state. The deltas need to be applied in the order:
        // - existing state which didn't come down /sync.
        // - State events under the 'state' key.
        // - State events in the 'timeline'.
        if (data.state && data.state.events) {
            data.state.events.forEach((e) => {
                setState(currentData._currentState, e);
            });
        }
        if (data.timeline && data.timeline.events) {
            data.timeline.events.forEach((e, index) => {
                // this nops if 'e' isn't a state event
                setState(currentData._currentState, e);
                // append the event to the timeline. The back-pagination token
                // corresponds to the first event in the timeline
                currentData._timeline.push({
                    event: e,
                    token: index === 0 ? data.timeline.prev_batch : null,
                });
            });
        }

        // attempt to prune the timeline by jumping between events which have
        // pagination tokens.
        if (currentData._timeline.length > this.opts.maxTimelineEntries) {
            const startIndex = (
                currentData._timeline.length - this.opts.maxTimelineEntries
            );
            for (let i = startIndex; i < currentData._timeline.length; i++) {
                if (currentData._timeline[i].token) {
                    // keep all events after this, including this one
                    currentData._timeline = currentData._timeline.slice(
                        i, currentData._timeline.length,
                    );
                    break;
                }
            }
        }
    }

    /**
     * Return everything under the 'rooms' key from a /sync response which
     * represents all room data that should be stored. This should be paired
     * with the sync token which represents the most recent /sync response
     * provided to accumulate(). Failure to do this can result in missing events.
     * <pre>
     * accumulator = new SyncAccumulator();
     * // these 2 lines must occur on the same event loop tick to prevent
     * // race conditions!
     * accumulator.accumulateRooms(someSyncResponse);
     * var outputSyncData = accumulator.getJSON();
     * // the next batch pairs with outputSyncData.
     * var syncToken = someSyncResponse.next_batch;
     * </pre>
     * @return {Object} A JSON object which has the same API shape as /sync.
     */
    getJSON() {
        const data = {
            join: {},
            invite: {},
            // always empty. This is set by /sync when a room was previously
            // in 'invite' or 'join'. On fresh startup, the client won't know
            // about any previous room being in 'invite' or 'join' so we can
            // just omit mentioning it at all, even if it has previously come
            // down /sync.
            // TODO: Check if full state is given upon rejoin.
            leave: {},
        };
        Object.keys(this.inviteRooms).forEach((roomId) => {
            data.invite[roomId] = this.inviteRooms[roomId];
        });
        Object.keys(this.joinRooms).forEach((roomId) => {
            // TODO roll back current state to start of timeline.
            data.join[roomId] = this.joinRooms[roomId].data;
        });
        return data;
    }
}

function setState(eventMap, event) {
    if (!event.state_key || !event.type) {
        return;
    }
    if (!eventMap[event.type]) {
        eventMap[event.type] = {};
    }
    eventMap[event.type][event.state_key] = event;
}

module.exports = SyncAccumulator;
