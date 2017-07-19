/*
Copyright 2015, 2016 OpenMarket Ltd
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

/*
 * TODO:
 * This class mainly serves to take all the syncing logic out of client.js and
 * into a separate file. It's all very fluid, and this class gut wrenches a lot
 * of MatrixClient props (e.g. _http). Given we want to support WebSockets as
 * an alternative syncing API, we may want to have a proper syncing interface
 * for HTTP and WS at some point.
 */
import Promise from 'bluebird';
const User = require("./models/user");
const Room = require("./models/room");
const utils = require("./utils");
const Filter = require("./filter");
const EventTimeline = require("./models/event-timeline");

import reEmit from './reemit';

const DEBUG = true;

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
const BUFFER_PERIOD_MS = 80 * 1000;

// Number of consecutive failed syncs that will lead to a syncState of ERROR as opposed
// to RECONNECTING. This is needed to inform the client of server issues when the
// keepAlive is successful but the server /sync fails.
const FAILED_SYNC_ERROR_THRESHOLD = 3;

function getFilterName(userId, suffix) {
    // scope this on the user ID because people may login on many accounts
    // and they all need to be stored!
    return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
}

function debuglog() {
    if (!DEBUG) {
        return;
    }
    console.log(...arguments);
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
function SyncApi(client, opts) {
    this.client = client;
    opts = opts || {};
    opts.initialSyncLimit = (
        opts.initialSyncLimit === undefined ? 8 : opts.initialSyncLimit
    );
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pollTimeout = opts.pollTimeout || (30 * 1000);
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";
    if (!opts.canResetEntireTimeline) {
        opts.canResetEntireTimeline = function(roomId) {
            return false;
        };
    }
    this.opts = opts;
    this._peekRoomId = null;
    this._currentSyncRequest = null;
    this._syncState = null;
    this._catchingUp = false;
    this._running = false;
    this._keepAliveTimer = null;
    this._connectionReturnedDefer = null;
    this._notifEvents = []; // accumulator of sync events in the current sync response
    this._failedSyncCount = 0; // Number of consecutive failed /sync requests

    if (client.getNotifTimelineSet()) {
        reEmit(client, client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

/**
 * @param {string} roomId
 * @return {Room}
 */
SyncApi.prototype.createRoom = function(roomId) {
    const client = this.client;
    const room = new Room(roomId, {
        pendingEventOrdering: this.opts.pendingEventOrdering,
        timelineSupport: client.timelineSupport,
    });
    reEmit(client, room, ["Room.name", "Room.timeline", "Room.redaction",
                          "Room.receipt", "Room.tags",
                          "Room.timelineReset",
                          "Room.localEchoUpdated",
                          "Room.accountData",
                         ]);
    this._registerStateListeners(room);
    return room;
};

/**
 * @param {Room} room
 * @private
 */
SyncApi.prototype._registerStateListeners = function(room) {
    const client = this.client;
    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember",
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership",
            ],
        );
    });
};

/**
 * @param {Room} room
 * @private
 */
SyncApi.prototype._deregisterStateListeners = function(room) {
    // could do with a better way of achieving this.
    room.currentState.removeAllListeners("RoomState.events");
    room.currentState.removeAllListeners("RoomState.members");
    room.currentState.removeAllListeners("RoomState.newMember");
};


/**
 * Sync rooms the user has left.
 * @return {Promise} Resolved when they've been added to the store.
 */
SyncApi.prototype.syncLeftRooms = function() {
    const client = this.client;
    const self = this;

    // grab a filter with limit=1 and include_leave=true
    const filter = new Filter(this.client.credentials.userId);
    filter.setTimelineLimit(1);
    filter.setIncludeLeaveRooms(true);

    const localTimeoutMs = this.opts.pollTimeout + BUFFER_PERIOD_MS;
    const qps = {
        timeout: 0, // don't want to block since this is a single isolated req
    };

    return client.getOrCreateFilter(
        getFilterName(client.credentials.userId, "LEFT_ROOMS"), filter,
    ).then(function(filterId) {
        qps.filter = filterId;
        return client._http.authedRequest(
            undefined, "GET", "/sync", qps, undefined, localTimeoutMs,
        );
    }).then(function(data) {
        let leaveRooms = [];
        if (data.rooms && data.rooms.leave) {
            leaveRooms = self._mapSyncResponseToRoomArray(data.rooms.leave);
        }
        const rooms = [];
        leaveRooms.forEach(function(leaveObj) {
            const room = leaveObj.room;
            rooms.push(room);
            if (!leaveObj.isBrandNewRoom) {
                // the intention behind syncLeftRooms is to add in rooms which were
                // *omitted* from the initial /sync. Rooms the user were joined to
                // but then left whilst the app is running will appear in this list
                // and we do not want to bother with them since they will have the
                // current state already (and may get dupe messages if we add
                // yet more timeline events!), so skip them.
                // NB: When we persist rooms to localStorage this will be more
                //     complicated...
                return;
            }
            leaveObj.timeline = leaveObj.timeline || {};
            const timelineEvents =
                self._mapSyncEventsFormat(leaveObj.timeline, room);
            const stateEvents = self._mapSyncEventsFormat(leaveObj.state, room);

            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(leaveObj.timeline.prev_batch,
                                                      EventTimeline.BACKWARDS);

            self._processRoomEvents(room, stateEvents, timelineEvents);

            room.recalculate(client.credentials.userId);
            client.store.storeRoom(room);
            client.emit("Room", room);
        });
        return rooms;
    });
};

/**
 * Peek into a room. This will result in the room in question being synced so it
 * is accessible via getRooms(). Live updates for the room will be provided.
 * @param {string} roomId The room ID to peek into.
 * @return {Promise} A promise which resolves once the room has been added to the
 * store.
 */
SyncApi.prototype.peek = function(roomId) {
    const self = this;
    const client = this.client;
    this._peekRoomId = roomId;
    return this.client.roomInitialSync(roomId, 20).then(function(response) {
        // make sure things are init'd
        response.messages = response.messages || {};
        response.messages.chunk = response.messages.chunk || [];
        response.state = response.state || [];

        const peekRoom = self.createRoom(roomId);

        // FIXME: Mostly duplicated from _processRoomEvents but not entirely
        // because "state" in this API is at the BEGINNING of the chunk
        const oldStateEvents = utils.map(
            utils.deepCopy(response.state), client.getEventMapper(),
        );
        const stateEvents = utils.map(
            response.state, client.getEventMapper(),
        );
        const messages = utils.map(
            response.messages.chunk, client.getEventMapper(),
        );

        // XXX: copypasted from /sync until we kill off this
        // minging v1 API stuff)
        // handle presence events (User objects)
        if (response.presence && utils.isArray(response.presence)) {
            response.presence.map(client.getEventMapper()).forEach(
            function(presenceEvent) {
                let user = client.store.getUser(presenceEvent.getContent().user_id);
                if (user) {
                    user.setPresenceEvent(presenceEvent);
                } else {
                    user = createNewUser(client, presenceEvent.getContent().user_id);
                    user.setPresenceEvent(presenceEvent);
                    client.store.storeUser(user);
                }
                client.emit("event", presenceEvent);
            });
        }

        // set the pagination token before adding the events in case people
        // fire off pagination requests in response to the Room.timeline
        // events.
        if (response.messages.start) {
            peekRoom.oldState.paginationToken = response.messages.start;
        }

        // set the state of the room to as it was after the timeline executes
        peekRoom.oldState.setStateEvents(oldStateEvents);
        peekRoom.currentState.setStateEvents(stateEvents);

        self._resolveInvites(peekRoom);
        peekRoom.recalculate(self.client.credentials.userId);

        // roll backwards to diverge old state. addEventsToTimeline
        // will overwrite the pagination token, so make sure it overwrites
        // it with the right thing.
        peekRoom.addEventsToTimeline(messages.reverse(), true,
                                     peekRoom.getLiveTimeline(),
                                     response.messages.start);

        client.store.storeRoom(peekRoom);
        client.emit("Room", peekRoom);

        self._peekPoll(peekRoom);
        return peekRoom;
    });
};

/**
 * Stop polling for updates in the peeked room. NOPs if there is no room being
 * peeked.
 */
SyncApi.prototype.stopPeeking = function() {
    this._peekRoomId = null;
};

/**
 * Do a peek room poll.
 * @param {Room} peekRoom
 * @param {string} token from= token
 */
SyncApi.prototype._peekPoll = function(peekRoom, token) {
    if (this._peekRoomId !== peekRoom.roomId) {
        debuglog("Stopped peeking in room %s", peekRoom.roomId);
        return;
    }

    const self = this;
    // FIXME: gut wrenching; hard-coded timeout values
    this.client._http.authedRequest(undefined, "GET", "/events", {
        room_id: peekRoom.roomId,
        timeout: 30 * 1000,
        from: token,
    }, undefined, 50 * 1000).done(function(res) {
        if (self._peekRoomId !== peekRoom.roomId) {
            debuglog("Stopped peeking in room %s", peekRoom.roomId);
            return;
        }
        // We have a problem that we get presence both from /events and /sync
        // however, /sync only returns presence for users in rooms
        // you're actually joined to.
        // in order to be sure to get presence for all of the users in the
        // peeked room, we handle presence explicitly here. This may result
        // in duplicate presence events firing for some users, which is a
        // performance drain, but such is life.
        // XXX: copypasted from /sync until we can kill this minging v1 stuff.

        res.chunk.filter(function(e) {
            return e.type === "m.presence";
        }).map(self.client.getEventMapper()).forEach(function(presenceEvent) {
            let user = self.client.store.getUser(presenceEvent.getContent().user_id);
            if (user) {
                user.setPresenceEvent(presenceEvent);
            } else {
                user = createNewUser(self.client, presenceEvent.getContent().user_id);
                user.setPresenceEvent(presenceEvent);
                self.client.store.storeUser(user);
            }
            self.client.emit("event", presenceEvent);
        });

        // strip out events which aren't for the given room_id (e.g presence)
        const events = res.chunk.filter(function(e) {
            return e.room_id === peekRoom.roomId;
        }).map(self.client.getEventMapper());

        peekRoom.addLiveEvents(events);
        self._peekPoll(peekRoom, res.end);
    }, function(err) {
        console.error("[%s] Peek poll failed: %s", peekRoom.roomId, err);
        setTimeout(function() {
            self._peekPoll(peekRoom, token);
        }, 30 * 1000);
    });
};

/**
 * Returns the current state of this sync object
 * @see module:client~MatrixClient#event:"sync"
 * @return {?String}
 */
SyncApi.prototype.getSyncState = function() {
    return this._syncState;
};

/**
 * Main entry point
 */
SyncApi.prototype.sync = function() {
    const client = this.client;
    const self = this;

    this._running = true;

    if (global.document) {
        this._onOnlineBound = this._onOnline.bind(this);
        global.document.addEventListener("online", this._onOnlineBound, false);
    }

    // We need to do one-off checks before we can begin the /sync loop.
    // These are:
    //   1) We need to get push rules so we can check if events should bing as we get
    //      them from /sync.
    //   2) We need to get/create a filter which we can use for /sync.

    function getPushRules() {
        client.getPushRules().done(function(result) {
            debuglog("Got push rules");
            client.pushRules = result;
            getFilter(); // Now get the filter
        }, function(err) {
            self._startKeepAlives().done(function() {
                getPushRules();
            });
            self._updateSyncState("ERROR", { error: err });
        });
    }

    function getFilter() {
        let filter;
        if (self.opts.filter) {
            filter = self.opts.filter;
        } else {
            filter = new Filter(client.credentials.userId);
            filter.setTimelineLimit(self.opts.initialSyncLimit);
        }

        client.getOrCreateFilter(
            getFilterName(client.credentials.userId), filter,
        ).done(function(filterId) {
            // reset the notifications timeline to prepare it to paginate from
            // the current point in time.
            // The right solution would be to tie /sync pagination tokens into
            // /notifications API somehow.
            client.resetNotifTimelineSet();

            self._sync({ filterId: filterId });
        }, function(err) {
            self._startKeepAlives().done(function() {
                getFilter();
            });
            self._updateSyncState("ERROR", { error: err });
        });
    }

    if (client.isGuest()) {
        // no push rules for guests, no access to POST filter for guests.
        self._sync({});
    } else {
        getPushRules();
    }
};

/**
 * Stops the sync object from syncing.
 */
SyncApi.prototype.stop = function() {
    debuglog("SyncApi.stop");
    if (global.document) {
        global.document.removeEventListener("online", this._onOnlineBound, false);
        this._onOnlineBound = undefined;
    }
    this._running = false;
    if (this._currentSyncRequest) {
        this._currentSyncRequest.abort();
    }
    if (this._keepAliveTimer) {
        clearTimeout(this._keepAliveTimer);
        this._keepAliveTimer = null;
    }
};

/**
 * Retry a backed off syncing request immediately. This should only be used when
 * the user <b>explicitly</b> attempts to retry their lost connection.
 * @return {boolean} True if this resulted in a request being retried.
 */
SyncApi.prototype.retryImmediately = function() {
    if (!this._connectionReturnedDefer) {
        return false;
    }
    this._startKeepAlives(0);
    return true;
};

/**
 * Invoke me to do /sync calls
 * @param {Object} syncOptions
 * @param {string} syncOptions.filterId
 * @param {boolean} syncOptions.hasSyncedBefore
 */
SyncApi.prototype._sync = function(syncOptions) {
    const client = this.client;
    const self = this;

    if (!this._running) {
        debuglog("Sync no longer running: exiting.");
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.reject();
            self._connectionReturnedDefer = null;
        }
        this._updateSyncState("STOPPED");
        return;
    }

    let filterId = syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = this._getGuestFilter();
    }

    const syncToken = client.store.getSyncToken();

    let pollTimeout = this.opts.pollTimeout;

    if (this.getSyncState() !== 'SYNCING' || this._catchingUp) {
        // unless we are happily syncing already, we want the server to return
        // as quickly as possible, even if there are no events queued. This
        // serves two purposes:
        //
        // * When the connection dies, we want to know asap when it comes back,
        //   so that we can hide the error from the user. (We don't want to
        //   have to wait for an event or a timeout).
        //
        // * We want to know if the server has any to_device messages queued up
        //   for us. We do that by calling it with a zero timeout until it
        //   doesn't give us any more to_device messages.
        this._catchingUp = true;
        pollTimeout = 0;
    }

    // normal timeout= plus buffer time
    const clientSideTimeoutMs = pollTimeout + BUFFER_PERIOD_MS;

    const qps = {
        filter: filterId,
        timeout: pollTimeout,
    };

    if (syncToken) {
        qps.since = syncToken;
    } else {
        // use a cachebuster for initialsyncs, to make sure that
        // we don't get a stale sync
        // (https://github.com/vector-im/vector-web/issues/1354)
        qps._cacheBuster = Date.now();
    }

    if (this.getSyncState() == 'ERROR' || this.getSyncState() == 'RECONNECTING') {
        // we think the connection is dead. If it comes back up, we won't know
        // about it till /sync returns. If the timeout= is high, this could
        // be a long time. Set it to 0 when doing retries so we don't have to wait
        // for an event or a timeout before emiting the SYNCING event.
        qps.timeout = 0;
    }

    let isCachedResponse = false;

    let syncPromise;
    if (!syncOptions.hasSyncedBefore) {
        // Don't do an HTTP hit to /sync. Instead, load up the persisted /sync data,
        // if there is data there.
        syncPromise = client.store.getSavedSync();
    } else {
        syncPromise = Promise.resolve(null);
    }

    syncPromise.then((savedSync) => {
        if (savedSync) {
            debuglog("sync(): not doing HTTP hit, instead returning stored /sync data");
            isCachedResponse = true;
            return {
                next_batch: savedSync.nextBatch,
                rooms: savedSync.roomsData,
                account_data: {
                    events: savedSync.accountData,
                },
            };
        } else {
            //debuglog('Starting sync since=' + syncToken);
            this._currentSyncRequest = client._http.authedRequest(
                undefined, "GET", "/sync", qps, undefined, clientSideTimeoutMs,
            );
            return this._currentSyncRequest;
        }
    }).then(function(data) {
        //debuglog('Completed sync, next_batch=' + data.next_batch);

        // set the sync token NOW *before* processing the events. We do this so
        // if something barfs on an event we can skip it rather than constantly
        // polling with the same token.
        client.store.setSyncToken(data.next_batch);

        // Reset after a successful sync
        self._failedSyncCount = 0;

        // We need to wait until the sync data has been sent to the backend
        // because it appears that the sync data gets modified somewhere in
        // processing it in such a way as to make it no longer cloneable.
        // XXX: Find out what is modifying it!
        if (!isCachedResponse) {
            // Don't give the store back its own cached data
            return client.store.setSyncData(data).then(() => {
                return data;
            });
        } else {
            return Promise.resolve(data);
        }
    }).done((data) => {
        try {
            self._processSyncResponse(syncToken, data);
        } catch (e) {
            // log the exception with stack if we have it, else fall back
            // to the plain description
            console.error("Caught /sync error", e.stack || e);
        }

        // emit synced events
        const syncEventData = {
            oldSyncToken: syncToken,
            nextSyncToken: data.next_batch,
            catchingUp: self._catchingUp,
        };

        if (!syncOptions.hasSyncedBefore) {
            self._updateSyncState("PREPARED", syncEventData);
            syncOptions.hasSyncedBefore = true;
        }

        // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
        if (!isCachedResponse) {
            self._updateSyncState("SYNCING", syncEventData);

            // tell databases that everything is now in a consistent state and can be
            // saved (no point doing so if we only have the data we just got out of the
            // store).
            client.store.save();
        }


        // Begin next sync
        self._sync(syncOptions);
    }, function(err) {
        if (!self._running) {
            debuglog("Sync no longer running: exiting");
            if (self._connectionReturnedDefer) {
                self._connectionReturnedDefer.reject();
                self._connectionReturnedDefer = null;
            }
            self._updateSyncState("STOPPED");
            return;
        }
        console.error("/sync error %s", err);
        console.error(err);

        self._failedSyncCount++;
        console.log('Number of consecutive failed sync requests:', self._failedSyncCount);

        debuglog("Starting keep-alive");
        // Note that we do *not* mark the sync connection as
        // lost yet: we only do this if a keepalive poke
        // fails, since long lived HTTP connections will
        // go away sometimes and we shouldn't treat this as
        // erroneous. We set the state to 'reconnecting'
        // instead, so that clients can onserve this state
        // if they wish.
        self._startKeepAlives().done(function() {
            self._sync(syncOptions);
        });
        self._currentSyncRequest = null;
        // Transition from RECONNECTING to ERROR after a given number of failed syncs
        self._updateSyncState(
            self._failedSyncCount >= FAILED_SYNC_ERROR_THRESHOLD ?
                "ERROR" : "RECONNECTING",
        );
    });
};

/**
 * Process data returned from a sync response and propagate it
 * into the model objects
 *
 * @param {string} syncToken the old next_batch token sent to this
 *    sync request.
 * @param {Object} data The response from /sync
 */
SyncApi.prototype._processSyncResponse = function(syncToken, data) {
    const client = this.client;
    const self = this;

    // data looks like:
    // {
    //    next_batch: $token,
    //    presence: { events: [] },
    //    account_data: { events: [] },
    //    device_lists: { changed: ["@user:server", ... ]},
    //    to_device: { events: [] },
    //    device_one_time_keys_count: { signed_curve25519: 42 },
    //    rooms: {
    //      invite: {
    //        $roomid: {
    //          invite_state: { events: [] }
    //        }
    //      },
    //      join: {
    //        $roomid: {
    //          state: { events: [] },
    //          timeline: { events: [], prev_batch: $token, limited: true },
    //          ephemeral: { events: [] },
    //          account_data: { events: [] },
    //          unread_notifications: {
    //              highlight_count: 0,
    //              notification_count: 0,
    //          }
    //        }
    //      },
    //      leave: {
    //        $roomid: {
    //          state: { events: [] },
    //          timeline: { events: [], prev_batch: $token }
    //        }
    //      }
    //    },
    // }

    // TODO-arch:
    // - Each event we pass through needs to be emitted via 'event', can we
    //   do this in one place?
    // - The isBrandNewRoom boilerplate is boilerplatey.

    // handle presence events (User objects)
    if (data.presence && utils.isArray(data.presence.events)) {
        data.presence.events.map(client.getEventMapper()).forEach(
        function(presenceEvent) {
            let user = client.store.getUser(presenceEvent.getSender());
            if (user) {
                user.setPresenceEvent(presenceEvent);
            } else {
                user = createNewUser(client, presenceEvent.getSender());
                user.setPresenceEvent(presenceEvent);
                client.store.storeUser(user);
            }
            client.emit("event", presenceEvent);
        });
    }

    // handle non-room account_data
    if (data.account_data && utils.isArray(data.account_data.events)) {
        const events = data.account_data.events.map(client.getEventMapper());
        client.store.storeAccountDataEvents(events);
        events.forEach(
            function(accountDataEvent) {
                if (accountDataEvent.getType() == 'm.push_rules') {
                    client.pushRules = accountDataEvent.getContent();
                }
                client.emit("accountData", accountDataEvent);
                return accountDataEvent;
            },
        );
    }

    // handle to-device events
    if (data.to_device && utils.isArray(data.to_device.events) &&
        data.to_device.events.length > 0
       ) {
        data.to_device.events
            .map(client.getEventMapper())
            .forEach(
                function(toDeviceEvent) {
                    const content = toDeviceEvent.getContent();
                    if (
                        toDeviceEvent.getType() == "m.room.message" &&
                            content.msgtype == "m.bad.encrypted"
                    ) {
                        // the mapper already logged a warning.
                        console.log(
                            'Ignoring undecryptable to-device event from ' +
                                toDeviceEvent.getSender(),
                        );
                        return;
                    }

                    client.emit("toDeviceEvent", toDeviceEvent);
                },
            );
    } else {
        // no more to-device events: we can stop polling with a short timeout.
        this._catchingUp = false;
    }

    // the returned json structure is a bit crap, so make it into a
    // nicer form (array) after applying sanity to make sure we don't fail
    // on missing keys (on the off chance)
    let inviteRooms = [];
    let joinRooms = [];
    let leaveRooms = [];

    if (data.rooms) {
        if (data.rooms.invite) {
            inviteRooms = this._mapSyncResponseToRoomArray(data.rooms.invite);
        }
        if (data.rooms.join) {
            joinRooms = this._mapSyncResponseToRoomArray(data.rooms.join);
        }
        if (data.rooms.leave) {
            leaveRooms = this._mapSyncResponseToRoomArray(data.rooms.leave);
        }
    }

    this._notifEvents = [];

    // Handle invites
    inviteRooms.forEach(function(inviteObj) {
        const room = inviteObj.room;
        const stateEvents =
            self._mapSyncEventsFormat(inviteObj.invite_state, room);
        self._processRoomEvents(room, stateEvents);
        if (inviteObj.isBrandNewRoom) {
            room.recalculate(client.credentials.userId);
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
    });

    // Handle joins
    joinRooms.forEach(function(joinObj) {
        const room = joinObj.room;
        const stateEvents = self._mapSyncEventsFormat(joinObj.state, room);
        const timelineEvents = self._mapSyncEventsFormat(joinObj.timeline, room);
        const ephemeralEvents = self._mapSyncEventsFormat(joinObj.ephemeral);
        const accountDataEvents = self._mapSyncEventsFormat(joinObj.account_data);

        // we do this first so it's correct when any of the events fire
        if (joinObj.unread_notifications) {
            room.setUnreadNotificationCount(
                'total', joinObj.unread_notifications.notification_count,
            );
            room.setUnreadNotificationCount(
                'highlight', joinObj.unread_notifications.highlight_count,
            );
        }

        joinObj.timeline = joinObj.timeline || {};

        if (joinObj.isBrandNewRoom) {
            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(
                joinObj.timeline.prev_batch, EventTimeline.BACKWARDS);
        } else if (joinObj.timeline.limited) {
            let limited = true;

            // we've got a limited sync, so we *probably* have a gap in the
            // timeline, so should reset. But we might have been peeking or
            // paginating and already have some of the events, in which
            // case we just want to append any subsequent events to the end
            // of the existing timeline.
            //
            // This is particularly important in the case that we already have
            // *all* of the events in the timeline - in that case, if we reset
            // the timeline, we'll end up with an entirely empty timeline,
            // which we'll try to paginate but not get any new events (which
            // will stop us linking the empty timeline into the chain).
            //
            for (let i = timelineEvents.length - 1; i >= 0; i--) {
                const eventId = timelineEvents[i].getId();
                if (room.getTimelineForEvent(eventId)) {
                    debuglog("Already have event " + eventId + " in limited " +
                             "sync - not resetting");
                    limited = false;

                    // we might still be missing some of the events before i;
                    // we don't want to be adding them to the end of the
                    // timeline because that would put them out of order.
                    timelineEvents.splice(0, i);

                    // XXX: there's a problem here if the skipped part of the
                    // timeline modifies the state set in stateEvents, because
                    // we'll end up using the state from stateEvents rather
                    // than the later state from timelineEvents. We probably
                    // need to wind stateEvents forward over the events we're
                    // skipping.

                    break;
                }
            }

            if (limited) {
                // save the old 'next_batch' token as the
                // forward-pagination token for the previously-active
                // timeline.
                room.currentState.paginationToken = syncToken;
                self._deregisterStateListeners(room);
                room.resetLiveTimeline(
                    joinObj.timeline.prev_batch,
                    self.opts.canResetEntireTimeline(room.roomId),
                );

                // We have to assume any gap in any timeline is
                // reason to stop incrementally tracking notifications and
                // reset the timeline.
                client.resetNotifTimelineSet();

                self._registerStateListeners(room);
            }
        }

        self._processRoomEvents(room, stateEvents, timelineEvents);

        // XXX: should we be adding ephemeralEvents to the timeline?
        // It feels like that for symmetry with room.addAccountData()
        // there should be a room.addEphemeralEvents() or similar.
        room.addLiveEvents(ephemeralEvents);

        // we deliberately don't add accountData to the timeline
        room.addAccountData(accountDataEvents);

        room.recalculate(client.credentials.userId);
        if (joinObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        timelineEvents.forEach(function(e) {
            client.emit("event", e);
        });
        ephemeralEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });
    });

    // Handle leaves (e.g. kicked rooms)
    leaveRooms.forEach(function(leaveObj) {
        const room = leaveObj.room;
        const stateEvents =
            self._mapSyncEventsFormat(leaveObj.state, room);
        const timelineEvents =
            self._mapSyncEventsFormat(leaveObj.timeline, room);
        const accountDataEvents =
            self._mapSyncEventsFormat(leaveObj.account_data);

        self._processRoomEvents(room, stateEvents, timelineEvents);
        room.addAccountData(accountDataEvents);

        room.recalculate(client.credentials.userId);
        if (leaveObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }

        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        timelineEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });
    });

    // update the notification timeline, if appropriate.
    // we only do this for live events, as otherwise we can't order them sanely
    // in the timeline relative to ones paginated in by /notifications.
    // XXX: we could fix this by making EventTimeline support chronological
    // ordering... but it doesn't, right now.
    if (syncToken && this._notifEvents.length) {
        this._notifEvents.sort(function(a, b) {
            return a.getTs() - b.getTs();
        });
        this._notifEvents.forEach(function(event) {
            client.getNotifTimelineSet().addLiveEvent(event);
        });
    }

    // Handle device list updates
    if (this.opts.crypto && data.device_lists && data.device_lists.changed) {
        data.device_lists.changed.forEach((u) => {
            this.opts.crypto.userDeviceListChanged(u);
        });
    }

    // Handle one_time_keys_count
    if (this.opts.crypto && data.device_one_time_keys_count) {
        const currentCount = data.device_one_time_keys_count.signed_curve25519 || 0;
        this.opts.crypto.updateOneTimeKeyCount(currentCount);
    }
};

/**
 * Starts polling the connectivity check endpoint
 * @param {number} delay How long to delay until the first poll.
 *        defaults to a short, randomised interval (to prevent
 *        tightlooping if /versions succeeds but /sync etc. fail).
 * @return {promise} which resolves once the connection returns
 */
SyncApi.prototype._startKeepAlives = function(delay) {
    if (delay === undefined) {
        delay = 2000 + Math.floor(Math.random() * 5000);
    }

    if (this._keepAliveTimer !== null) {
        clearTimeout(this._keepAliveTimer);
    }
    const self = this;
    if (delay > 0) {
        self._keepAliveTimer = setTimeout(
            self._pokeKeepAlive.bind(self),
            delay,
        );
    } else {
        self._pokeKeepAlive();
    }
    if (!this._connectionReturnedDefer) {
        this._connectionReturnedDefer = Promise.defer();
    }
    return this._connectionReturnedDefer.promise;
};

/**
 * Make a dummy call to /_matrix/client/versions, to see if the HS is
 * reachable.
 *
 * On failure, schedules a call back to itself. On success, resolves
 * this._connectionReturnedDefer.
 */
SyncApi.prototype._pokeKeepAlive = function() {
    const self = this;
    function success() {
        clearTimeout(self._keepAliveTimer);
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.resolve();
            self._connectionReturnedDefer = null;
        }
    }

    this.client._http.request(
        undefined, // callback
        "GET", "/_matrix/client/versions",
        undefined, // queryParams
        undefined, // data
        {
            prefix: '',
            localTimeoutMs: 15 * 1000,
        },
    ).done(function() {
        success();
    }, function(err) {
        if (err.httpStatus == 400) {
            // treat this as a success because the server probably just doesn't
            // support /versions: point is, we're getting a response.
            // We wait a short time though, just in case somehow the server
            // is in a mode where it 400s /versions responses and sync etc.
            // responses fail, this will mean we don't hammer in a loop.
            self._keepAliveTimer = setTimeout(success, 2000);
        } else {
            self._keepAliveTimer = setTimeout(
                self._pokeKeepAlive.bind(self),
                5000 + Math.floor(Math.random() * 5000),
            );
            // A keepalive has failed, so we emit the
            // error state (whether or not this is the
            // first failure).
            // Note we do this after setting the timer:
            // this lets the unit tests advance the mock
            // clock when the get the error.
            self._updateSyncState("ERROR", { error: err });
        }
    });
};

/**
 * @param {Object} obj
 * @return {Object[]}
 */
SyncApi.prototype._mapSyncResponseToRoomArray = function(obj) {
    // Maps { roomid: {stuff}, roomid: {stuff} }
    // to
    // [{stuff+Room+isBrandNewRoom}, {stuff+Room+isBrandNewRoom}]
    const client = this.client;
    const self = this;
    return utils.keys(obj).map(function(roomId) {
        const arrObj = obj[roomId];
        let room = client.store.getRoom(roomId);
        let isBrandNewRoom = false;
        if (!room) {
            room = self.createRoom(roomId);
            isBrandNewRoom = true;
        }
        arrObj.room = room;
        arrObj.isBrandNewRoom = isBrandNewRoom;
        return arrObj;
    });
};

/**
 * @param {Object} obj
 * @param {Room} room
 * @return {MatrixEvent[]}
 */
SyncApi.prototype._mapSyncEventsFormat = function(obj, room) {
    if (!obj || !utils.isArray(obj.events)) {
        return [];
    }
    const mapper = this.client.getEventMapper();
    return obj.events.map(function(e) {
        if (room) {
            e.room_id = room.roomId;
        }
        return mapper(e);
    });
};

/**
 * @param {Room} room
 */
SyncApi.prototype._resolveInvites = function(room) {
    if (!room || !this.opts.resolveInvitesToProfiles) {
        return;
    }
    const client = this.client;
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        const user = client.getUser(member.userId);
        let promise;
        if (user) {
            promise = Promise.resolve({
                avatar_url: user.avatarUrl,
                displayname: user.displayName,
            });
        } else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            const inviteEvent = member.events.member;
            if (inviteEvent.getContent().membership !== "invite") {
                // between resolving and now they have since joined, so don't clobber
                return;
            }
            inviteEvent.getContent().avatar_url = info.avatar_url;
            inviteEvent.getContent().displayname = info.displayname;
            // fire listeners
            member.setMembershipEvent(inviteEvent, room.currentState);
        }, function(err) {
            // OH WELL.
        });
    });
};

/**
 * @param {Room} room
 * @param {MatrixEvent[]} stateEventList A list of state events. This is the state
 * at the *START* of the timeline list if it is supplied.
 * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
 * is earlier in time. Higher index is later.
 */
SyncApi.prototype._processRoomEvents = function(room, stateEventList,
                                                timelineEventList) {
    timelineEventList = timelineEventList || [];
    const client = this.client;
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    const oldStateEvents = utils.map(
        utils.deepCopy(
            stateEventList.map(function(mxEvent) {
                return mxEvent.event;
            }),
        ), client.getEventMapper(),
    );
    const stateEvents = stateEventList;

    // set the state of the room to as it was before the timeline executes
    //
    // XXX: what if we've already seen (some of) the events in the timeline,
    // and they modify some of the state set in stateEvents? In that case we'll
    // end up with the state from stateEvents, instead of the more recent state
    // from the timeline.
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(stateEvents);

    this._resolveInvites(room);

    // recalculate the room name at this point as adding events to the timeline
    // may make notifications appear which should have the right name.
    room.recalculate(this.client.credentials.userId);

    // gather our notifications into this._notifEvents
    if (client.getNotifTimelineSet()) {
        for (let i = 0; i < timelineEventList.length; i++) {
            const pushActions = client.getPushActionsForEvent(timelineEventList[i]);
            if (pushActions && pushActions.notify &&
                pushActions.tweaks && pushActions.tweaks.highlight) {
                this._notifEvents.push(timelineEventList[i]);
            }
        }
    }

    // execute the timeline events, this will begin to diverge the current state
    // if the timeline has any state events in it.
    room.addLiveEvents(timelineEventList);
};

/**
 * @return {string}
 */
SyncApi.prototype._getGuestFilter = function() {
    const guestRooms = this.client._guestRooms; // FIXME: horrible gut-wrenching
    if (!guestRooms) {
        return "{}";
    }
    // we just need to specify the filter inline if we're a guest because guests
    // can't create filters.
    return JSON.stringify({
        room: {
            timeline: {
                limit: 20,
            },
        },
    });
};

/**
 * Sets the sync state and emits an event to say so
 * @param {String} newState The new state string
 * @param {Object} data Object of additional data to emit in the event
 */
SyncApi.prototype._updateSyncState = function(newState, data) {
    const old = this._syncState;
    this._syncState = newState;
    this.client.emit("sync", this._syncState, old, data);
};

/**
 * Event handler for the 'online' event
 * This event is generally unreliable and precise behaviour
 * varies between browsers, so we poll for connectivity too,
 * but this might help us reconnect a little faster.
 */
SyncApi.prototype._onOnline = function() {
    debuglog("Browser thinks we are back online");
    this._startKeepAlives(0);
};

function createNewUser(client, userId) {
    const user = new User(userId);
    reEmit(client, user, [
        "User.avatarUrl", "User.displayName", "User.presence",
        "User.currentlyActive", "User.lastPresenceTs",
    ]);
    return user;
}

/** */
module.exports = SyncApi;
