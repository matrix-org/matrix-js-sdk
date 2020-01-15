/*
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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
 * This is an internal module. See {@link SyncAccumulator} for the public class.
 * @module sync-accumulator
 */

import {logger} from './logger';
import {deepCopy} from "./utils";

/**
 * The purpose of this class is to accumulate /sync responses such that a
 * complete "initial" JSON response can be returned which accurately represents
 * the sum total of the /sync responses accumulated to date. It only handles
 * room data: that is, everything under the "rooms" top-level key.
 *
 * This class is used when persisting room data so a complete /sync response can
 * be loaded from disk and incremental syncs can be performed on the server,
 * rather than asking the server to do an initial sync on startup.
 */
export class SyncAccumulator {
    /**
     * @param {Object} opts
     * @param {Number=} opts.maxTimelineEntries The ideal maximum number of
     * timeline entries to keep in the sync response. This is best-effort, as
     * clients do not always have a back-pagination token for each event, so
     * it's possible there may be slightly *less* than this value. There will
     * never be more. This cannot be 0 or else it makes it impossible to scroll
     * back in a room. Default: 50.
     */
    constructor(opts) {
        opts = opts || {};
        opts.maxTimelineEntries = opts.maxTimelineEntries || 50;
        this.opts = opts;
        this.accountData = {
            //$event_type: Object
        };
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
            //    _summary: {
            //       m.heroes: [ $user_id ],
            //       m.joined_member_count: $count,
            //       m.invited_member_count: $count
            //    },
            //    _accountData: { $event_type: json },
            //    _unreadNotifications: { ... unread_notifications JSON ... },
            //    _readReceipts: { $user_id: { data: $json, eventId: $event_id }}
            //}
        };
        // the /sync token which corresponds to the last time rooms were
        // accumulated. We remember this so that any caller can obtain a
        // coherent /sync response and know at what point they should be
        // streaming from without losing events.
        this.nextBatch = null;

        // { ('invite'|'join'|'leave'): $groupId: { ... sync 'group' data } }
        this.groups = {
            invite: {},
            join: {},
            leave: {},
        };
    }

    accumulate(syncResponse) {
        this._accumulateRooms(syncResponse);
        this._accumulateGroups(syncResponse);
        this._accumulateAccountData(syncResponse);
        this.nextBatch = syncResponse.next_batch;
    }

    _accumulateAccountData(syncResponse) {
        if (!syncResponse.account_data || !syncResponse.account_data.events) {
            return;
        }
        // Clobbers based on event type.
        syncResponse.account_data.events.forEach((e) => {
            this.accountData[e.type] = e;
        });
    }

    /**
     * Accumulate incremental /sync room data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    _accumulateRooms(syncResponse) {
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
                logger.error("Unknown cateogory: ", category);
        }
    }

    _accumulateInviteState(roomId, data) {
        if (!data.invite_state || !data.invite_state.events) { // no new data
            return;
        }
        if (!this.inviteRooms[roomId]) {
            this.inviteRooms[roomId] = {
                invite_state: data.invite_state,
            };
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

        if (!this.joinRooms[roomId]) {
            // Create truly empty objects so event types of 'hasOwnProperty' and co
            // don't cause this code to break.
            this.joinRooms[roomId] = {
                _currentState: Object.create(null),
                _timeline: [],
                _accountData: Object.create(null),
                _unreadNotifications: {},
                _summary: {},
                _readReceipts: {},
            };
        }
        const currentData = this.joinRooms[roomId];

        if (data.account_data && data.account_data.events) {
            // clobber based on type
            data.account_data.events.forEach((e) => {
                currentData._accountData[e.type] = e;
            });
        }

        // these probably clobber, spec is unclear.
        if (data.unread_notifications) {
            currentData._unreadNotifications = data.unread_notifications;
        }
        if (data.summary) {
            const HEROES_KEY = "m.heroes";
            const INVITED_COUNT_KEY = "m.invited_member_count";
            const JOINED_COUNT_KEY = "m.joined_member_count";

            const acc = currentData._summary;
            const sum = data.summary;
            acc[HEROES_KEY] = sum[HEROES_KEY] || acc[HEROES_KEY];
            acc[JOINED_COUNT_KEY] = sum[JOINED_COUNT_KEY] || acc[JOINED_COUNT_KEY];
            acc[INVITED_COUNT_KEY] = sum[INVITED_COUNT_KEY] || acc[INVITED_COUNT_KEY];
        }

        if (data.ephemeral && data.ephemeral.events) {
            data.ephemeral.events.forEach((e) => {
                // We purposefully do not persist m.typing events.
                // Technically you could refresh a browser before the timer on a
                // typing event is up, so it'll look like you aren't typing when
                // you really still are. However, the alternative is worse. If
                // we do persist typing events, it will look like people are
                // typing forever until someone really does start typing (which
                // will prompt Synapse to send down an actual m.typing event to
                // clobber the one we persisted).
                if (e.type !== "m.receipt" || !e.content) {
                    // This means we'll drop unknown ephemeral events but that
                    // seems okay.
                    return;
                }
                // Handle m.receipt events. They clobber based on:
                //   (user_id, receipt_type)
                // but they are keyed in the event as:
                //   content:{ $event_id: { $receipt_type: { $user_id: {json} }}}
                // so store them in the former so we can accumulate receipt deltas
                // quickly and efficiently (we expect a lot of them). Fold the
                // receipt type into the key name since we only have 1 at the
                // moment (m.read) and nested JSON objects are slower and more
                // of a hassle to work with. We'll inflate this back out when
                // getJSON() is called.
                Object.keys(e.content).forEach((eventId) => {
                    if (!e.content[eventId]["m.read"]) {
                        return;
                    }
                    Object.keys(e.content[eventId]["m.read"]).forEach((userId) => {
                        // clobber on user ID
                        currentData._readReceipts[userId] = {
                            data: e.content[eventId]["m.read"][userId],
                            eventId: eventId,
                        };
                    });
                });
            });
        }

        // if we got a limited sync, we need to remove all timeline entries or else
        // we will have gaps in the timeline.
        if (data.timeline && data.timeline.limited) {
            currentData._timeline = [];
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
     * Accumulate incremental /sync group data.
     * @param {Object} syncResponse the complete /sync JSON
     */
    _accumulateGroups(syncResponse) {
        if (!syncResponse.groups) {
            return;
        }
        if (syncResponse.groups.invite) {
            Object.keys(syncResponse.groups.invite).forEach((groupId) => {
                this._accumulateGroup(
                    groupId, "invite", syncResponse.groups.invite[groupId],
                );
            });
        }
        if (syncResponse.groups.join) {
            Object.keys(syncResponse.groups.join).forEach((groupId) => {
                this._accumulateGroup(
                    groupId, "join", syncResponse.groups.join[groupId],
                );
            });
        }
        if (syncResponse.groups.leave) {
            Object.keys(syncResponse.groups.leave).forEach((groupId) => {
                this._accumulateGroup(
                    groupId, "leave", syncResponse.groups.leave[groupId],
                );
            });
        }
    }

    _accumulateGroup(groupId, category, data) {
        for (const cat of ['invite', 'join', 'leave']) {
            delete this.groups[cat][groupId];
        }
        this.groups[category][groupId] = data;
    }

    /**
     * Return everything under the 'rooms' key from a /sync response which
     * represents all room data that should be stored. This should be paired
     * with the sync token which represents the most recent /sync response
     * provided to accumulate().
     * @return {Object} An object with a "nextBatch", "roomsData" and "accountData"
     * keys.
     * The "nextBatch" key is a string which represents at what point in the
     * /sync stream the accumulator reached. This token should be used when
     * restarting a /sync stream at startup. Failure to do so can lead to missing
     * events. The "roomsData" key is an Object which represents the entire
     * /sync response from the 'rooms' key onwards. The "accountData" key is
     * a list of raw events which represent global account data.
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
            // The notable exception is when a client is kicked or banned:
            // we may want to hold onto that room so the client can clearly see
            // why their room has disappeared. We don't persist it though because
            // it is unclear *when* we can safely remove the room from the DB.
            // Instead, we assume that if you're loading from the DB, you've
            // refreshed the page, which means you've seen the kick/ban already.
            leave: {},
        };
        Object.keys(this.inviteRooms).forEach((roomId) => {
            data.invite[roomId] = this.inviteRooms[roomId];
        });
        Object.keys(this.joinRooms).forEach((roomId) => {
            const roomData = this.joinRooms[roomId];
            const roomJson = {
                ephemeral: { events: [] },
                account_data: { events: [] },
                state: { events: [] },
                timeline: {
                    events: [],
                    prev_batch: null,
                },
                unread_notifications: roomData._unreadNotifications,
                summary: roomData._summary,
            };
            // Add account data
            Object.keys(roomData._accountData).forEach((evType) => {
                roomJson.account_data.events.push(roomData._accountData[evType]);
            });

            // Add receipt data
            const receiptEvent = {
                type: "m.receipt",
                room_id: roomId,
                content: {
                    // $event_id: { "m.read": { $user_id: $json } }
                },
            };
            Object.keys(roomData._readReceipts).forEach((userId) => {
                const receiptData = roomData._readReceipts[userId];
                if (!receiptEvent.content[receiptData.eventId]) {
                    receiptEvent.content[receiptData.eventId] = {
                        "m.read": {},
                    };
                }
                receiptEvent.content[receiptData.eventId]["m.read"][userId] = (
                    receiptData.data
                );
            });
            // add only if we have some receipt data
            if (Object.keys(receiptEvent.content).length > 0) {
                roomJson.ephemeral.events.push(receiptEvent);
            }

            // Add timeline data
            roomData._timeline.forEach((msgData) => {
                if (!roomJson.timeline.prev_batch) {
                    // the first event we add to the timeline MUST match up to
                    // the prev_batch token.
                    if (!msgData.token) {
                        return; // this shouldn't happen as we prune constantly.
                    }
                    roomJson.timeline.prev_batch = msgData.token;
                }
                roomJson.timeline.events.push(msgData.event);
            });

            // Add state data: roll back current state to the start of timeline,
            // by "reverse clobbering" from the end of the timeline to the start.
            // Convert maps back into arrays.
            const rollBackState = Object.create(null);
            for (let i = roomJson.timeline.events.length - 1; i >=0; i--) {
                const timelineEvent = roomJson.timeline.events[i];
                if (timelineEvent.state_key === null ||
                        timelineEvent.state_key === undefined) {
                    continue; // not a state event
                }
                // since we're going back in time, we need to use the previous
                // state value else we'll break causality. We don't have the
                // complete previous state event, so we need to create one.
                const prevStateEvent = deepCopy(timelineEvent);
                if (prevStateEvent.unsigned) {
                    if (prevStateEvent.unsigned.prev_content) {
                        prevStateEvent.content = prevStateEvent.unsigned.prev_content;
                    }
                    if (prevStateEvent.unsigned.prev_sender) {
                        prevStateEvent.sender = prevStateEvent.unsigned.prev_sender;
                    }
                }
                setState(rollBackState, prevStateEvent);
            }
            Object.keys(roomData._currentState).forEach((evType) => {
                Object.keys(roomData._currentState[evType]).forEach((stateKey) => {
                    let ev = roomData._currentState[evType][stateKey];
                    if (rollBackState[evType] && rollBackState[evType][stateKey]) {
                        // use the reverse clobbered event instead.
                        ev = rollBackState[evType][stateKey];
                    }
                    roomJson.state.events.push(ev);
                });
            });
            data.join[roomId] = roomJson;
        });

        // Add account data
        const accData = [];
        Object.keys(this.accountData).forEach((evType) => {
            accData.push(this.accountData[evType]);
        });

        return {
            nextBatch: this.nextBatch,
            roomsData: data,
            groupsData: this.groups,
            accountData: accData,
        };
    }

    getNextBatchToken() {
        return this.nextBatch;
    }
}

function setState(eventMap, event) {
    if (event.state_key === null || event.state_key === undefined || !event.type) {
        return;
    }
    if (!eventMap[event.type]) {
        eventMap[event.type] = Object.create(null);
    }
    eventMap[event.type][event.state_key] = event;
}
