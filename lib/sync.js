/*
Copyright 2015, 2016 OpenMarket Ltd

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
var q = require("q");
var User = require("./models/user");
var Room = require("./models/room");
var utils = require("./utils");
var httpApi = require("./http-api");
var Filter = require("./filter");

var DEBUG = true;

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
var BUFFER_PERIOD_MS = 80 * 1000;

function getFilterName(userId, suffix) {
    // scope this on the user ID because people may login on many accounts
    // and they all need to be stored!
    return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
}

function debuglog() {
    if (!DEBUG) { return; }
    console.log.apply(console, arguments);
}


/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 */
function SyncApi(client, opts) {
    this.client = client;
    opts = opts || {};
    opts.initialSyncLimit = opts.initialSyncLimit || 8;
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pollTimeout = opts.pollTimeout || (30 * 1000);
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";
    this.opts = opts;
    this._peekRoomId = null;
    this._syncConnectionLost = false;
    this._currentSyncRequest = null;
}

/**
 * @param {string} roomId
 * @return {Room}
 */
SyncApi.prototype.createRoom = function(roomId) {
    var client = this.client;
    var room = new Room(roomId, {
        pendingEventOrdering: this.opts.pendingEventOrdering
    });
    reEmit(client, room, ["Room.name", "Room.timeline", "Room.receipt", "Room.tags"]);

    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember"
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership"
            ]
        );
    });
    return room;
};

/**
 * Sync rooms the user has left.
 * @return {Promise} Resolved when they've been added to the store.
 */
SyncApi.prototype.syncLeftRooms = function() {
    var client = this.client;
    var self = this;

    // grab a filter with limit=1 and include_leave=true
    var filter = new Filter(this.client.credentials.userId);
    filter.setTimelineLimit(1);
    filter.setIncludeLeaveRooms(true);

    var localTimeoutMs = this.opts.pollTimeout + BUFFER_PERIOD_MS;
    var qps = {
        timeout: 0 // don't want to block since this is a single isolated req
    };

    return this._getOrCreateFilter(
        getFilterName(client.credentials.userId, "LEFT_ROOMS"), filter
    ).then(function(filterId) {
        qps.filter = filterId;
        return client._http.authedRequestWithPrefix(
            undefined, "GET", "/sync", qps, undefined, httpApi.PREFIX_V2_ALPHA,
            localTimeoutMs
        );
    }).then(function(data) {
        var leaveRooms = [];
        if (data.rooms && data.rooms.leave) {
            leaveRooms = self._mapSyncResponseToRoomArray(data.rooms.leave);
        }
        var rooms = [];
        leaveRooms.forEach(function(leaveObj) {
            var room = leaveObj.room;
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
            var timelineEvents =
                self._mapSyncEventsFormat(leaveObj.timeline, room);
            var stateEvents = self._mapSyncEventsFormat(leaveObj.state, room);
            var paginationToken = (
                leaveObj.timeline.limited ? leaveObj.timeline.prev_batch : null
            );
            self._processRoomEvents(
                room, stateEvents, timelineEvents, paginationToken
            );
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
    var self = this;
    var client = this.client;
    this._peekRoomId = roomId;
    return this.client.roomInitialSync(roomId, 20).then(function(response) {
        // make sure things are init'd
        response.messages = response.messages || {};
        response.messages.chunk = response.messages.chunk || [];
        response.state = response.state || [];

        var peekRoom = self.createRoom(roomId);

        // FIXME: Mostly duplicated from _processRoomEvents but not entirely
        // because "state" in this API is at the BEGINNING of the chunk
        var oldStateEvents = utils.map(
            utils.deepCopy(response.state), client.getEventMapper()
        );
        var stateEvents = utils.map(
            response.state, client.getEventMapper()
        );
        var messages = utils.map(
            response.messages.chunk, client.getEventMapper()
        );

        if (response.messages.start) {
            peekRoom.oldState.paginationToken = response.messages.start;
        }

        // set the state of the room to as it was after the timeline executes
        peekRoom.oldState.setStateEvents(oldStateEvents);
        peekRoom.currentState.setStateEvents(stateEvents);

        self._resolveInvites(peekRoom);
        peekRoom.recalculate(self.client.credentials.userId);

        // roll backwards to diverge old state:
        peekRoom.addEventsToTimeline(messages.reverse(), true);

        client.store.storeRoom(peekRoom);
        client.emit("Room", peekRoom);

        self._peekPoll(roomId);
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
 * @param {string} roomId
 * @param {string} token from= token
 */
SyncApi.prototype._peekPoll = function(roomId, token) {
    if (this._peekRoomId !== roomId) {
        debuglog("Stopped peeking in room %s", roomId);
        return;
    }

    var self = this;
    // FIXME: gut wrenching; hard-coded timeout values
    this.client._http.authedRequestWithPrefix(undefined, "GET", "/events", {
        room_id: roomId,
        timeout: 30 * 1000,
        from: token
    }, undefined, httpApi.PREFIX_V1, 50 * 1000).done(function(res) {
        // strip out events which aren't for the given room_id (e.g presence)
        var events = res.chunk.filter(function(e) {
            return e.room_id === roomId;
        }).map(self.client.getEventMapper());
        var room = self.client.getRoom(roomId);
        room.addEvents(events);
        self._peekPoll(roomId, res.end);
    }, function(err) {
        console.error("[%s] Peek poll failed: %s", roomId, err);
        setTimeout(function() {
            self._peekPoll(roomId, token);
        }, 30 * 1000);
    });
};

/**
 * Main entry point
 */
SyncApi.prototype.sync = function() {
    debuglog("SyncApi.sync");
    var client = this.client;
    var self = this;

    // We need to do one-off checks before we can begin the /sync loop.
    // These are:
    //   1) We need to get push rules so we can check if events should bing as we get
    //      them from /sync.
    //   2) We need to get/create a filter which we can use for /sync.

    function getPushRules(attempt) {
        attempt = attempt || 0;
        attempt += 1;

        client.getPushRules().done(function(result) {
            debuglog("Got push rules");
            client.pushRules = result;
            getFilter(); // Now get the filter
        }, retryHandler(attempt, getPushRules));
    }

    function getFilter(attempt) {
        attempt = attempt || 0;
        attempt += 1;

        var filter = new Filter(client.credentials.userId);
        filter.setTimelineLimit(self.opts.initialSyncLimit);

        self._getOrCreateFilter(
            getFilterName(client.credentials.userId), filter
        ).done(function(filterId) {
            debuglog("Using existing filter ID %s", filterId);
            self._sync({ filterId: filterId });
        }, retryHandler(attempt, getFilter));
    }

    // sets the sync state to error and waits a bit before re-invoking the function.
    function retryHandler(attempt, fnToRun) {
        return function(err) {
            startSyncingRetryTimer(client, attempt, function(newAttempt) {
                fnToRun(newAttempt);
            });
            updateSyncState(client, "ERROR", { error: err });
        };
    }

    if (client.isGuest()) {
        // no push rules for guests, no access to POST filter for guests.
        self._sync({});
    }
    else {
        getPushRules();
    }
};

/**
 * Invoke me to do /sync calls
 * @param {Object} syncOptions
 * @param {string} syncOptions.filterId
 * @param {boolean} syncOptions.hasSyncedBefore
 * @param {Number=} attempt
 */
SyncApi.prototype._sync = function(syncOptions, attempt) {
    var client = this.client;
    var self = this;
    attempt = attempt || 1;

    var filterId = syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = this._getGuestFilter();
    }

    var qps = {
        filter: filterId,
        timeout: this.opts.pollTimeout,
        since: client.store.getSyncToken() || undefined // do not send 'null'
    };

    if (attempt > 1) {
        // we think the connection is dead. If it comes back up, we won't know
        // about it till /sync returns. If the timeout= is high, this could
        // be a long time. Set it to 0 when doing retries.
        qps.timeout = 0;
    }

    // normal timeout= plus buffer time
    var clientSideTimeoutMs = this.opts.pollTimeout + BUFFER_PERIOD_MS;

    this._currentSyncRequest = client._http.authedRequestWithPrefix(
        undefined, "GET", "/sync", qps, undefined, httpApi.PREFIX_V2_ALPHA,
        clientSideTimeoutMs
    );

    this._currentSyncRequest.done(function(data) {
        self._syncConnectionLost = false;
        // data looks like:
        // {
        //    next_batch: $token,
        //    presence: { events: [] },
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
        //    }
        // }

        // set the sync token NOW *before* processing the events. We do this so
        // if something barfs on an event we can skip it rather than constantly
        // polling with the same token.
        client.store.setSyncToken(data.next_batch);

        // TODO-arch:
        // - Each event we pass through needs to be emitted via 'event', can we
        //   do this in one place?
        // - The isBrandNewRoom boilerplate is boilerplatey.

        try {
            // handle presence events (User objects)
            if (data.presence && utils.isArray(data.presence.events)) {
                data.presence.events.map(client.getEventMapper()).forEach(
                function(presenceEvent) {
                    var user = client.store.getUser(presenceEvent.getSender());
                    if (user) {
                        user.setPresenceEvent(presenceEvent);
                    }
                    else {
                        user = createNewUser(client, presenceEvent.getSender());
                        user.setPresenceEvent(presenceEvent);
                        client.store.storeUser(user);
                    }
                    client.emit("event", presenceEvent);
                });
            }

            // the returned json structure is abit crap, so make it into a
            // nicer form (array) after applying sanity to make sure we don't fail
            // on missing keys (on the off chance)
            var inviteRooms = [];
            var joinRooms = [];
            var leaveRooms = [];

            if (data.rooms) {
                if (data.rooms.invite) {
                    inviteRooms = self._mapSyncResponseToRoomArray(data.rooms.invite);
                }
                if (data.rooms.join) {
                    joinRooms = self._mapSyncResponseToRoomArray(data.rooms.join);
                }
                if (data.rooms.leave) {
                    leaveRooms = self._mapSyncResponseToRoomArray(data.rooms.leave);
                }
            }

            // Handle invites
            inviteRooms.forEach(function(inviteObj) {
                var room = inviteObj.room;
                var stateEvents =
                    self._mapSyncEventsFormat(inviteObj.invite_state, room);
                self._processRoomEvents(room, stateEvents);
                if (inviteObj.isBrandNewRoom) {
                    room.recalculate(client.credentials.userId);
                    client.store.storeRoom(room);
                    client.emit("Room", room);
                }
                stateEvents.forEach(function(e) { client.emit("event", e); });
            });

            // Handle joins
            joinRooms.forEach(function(joinObj) {
                var room = joinObj.room;
                var stateEvents = self._mapSyncEventsFormat(joinObj.state, room);
                var timelineEvents = self._mapSyncEventsFormat(joinObj.timeline, room);
                var ephemeralEvents = self._mapSyncEventsFormat(joinObj.ephemeral);
                var accountDataEvents = self._mapSyncEventsFormat(joinObj.account_data);

                // we do this first so it's correct when any of the events fire
                if (joinObj.unread_notifications) {
                    room.setUnreadNotificationCount(
                        'total', joinObj.unread_notifications.notification_count
                    );
                    room.setUnreadNotificationCount(
                        'highlight', joinObj.unread_notifications.highlight_count
                    );
                }

                joinObj.timeline = joinObj.timeline || {};

                if (joinObj.timeline.limited) {
                    // nuke the timeline so we don't get holes
                    room.timeline = [];
                }

                // we want to set a new pagination token if this is the first time
                // we've made this room or if we're nuking the timeline
                var paginationToken = null;
                if (joinObj.isBrandNewRoom || joinObj.timeline.limited) {
                    paginationToken = joinObj.timeline.prev_batch;
                }

                self._processRoomEvents(
                    room, stateEvents, timelineEvents, paginationToken
                );

                // XXX: should we be adding ephemeralEvents to the timeline?
                // It feels like that for symmetry with room.addAccountData()
                // there should be a room.addEphemeralEvents() or similar.
                room.addEvents(ephemeralEvents);

                // we deliberately don't add accountData to the timeline
                room.addAccountData(accountDataEvents);

                room.recalculate(client.credentials.userId);
                if (joinObj.isBrandNewRoom) {
                    client.store.storeRoom(room);
                    client.emit("Room", room);
                }
                stateEvents.forEach(function(e) { client.emit("event", e); });
                timelineEvents.forEach(function(e) { client.emit("event", e); });
                ephemeralEvents.forEach(function(e) { client.emit("event", e); });
                accountDataEvents.forEach(function(e) { client.emit("event", e); });
            });

            // Handle leaves
            leaveRooms.forEach(function(leaveObj) {
                // Do the bear minimum to register rejected invites / you leaving rooms
                var room = leaveObj.room;
                var timelineEvents =
                    self._mapSyncEventsFormat(leaveObj.timeline, room);
                room.addEvents(timelineEvents);
                timelineEvents.forEach(function(e) { client.emit("event", e); });
            });
        }
        catch (e) {
            console.error("Caught /sync error:");
            console.error(e);
        }

        // emit synced events
        if (!syncOptions.hasSyncedBefore) {
            updateSyncState(client, "PREPARED");
            syncOptions.hasSyncedBefore = true;
        }

        // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
        updateSyncState(client, "SYNCING");

        self._sync(syncOptions);
    }, function(err) {
        if (!self._syncConnectionLost) {
            debuglog("Starting keep-alive");
            self._syncConnectionLost = true;
            retryPromise(self._pokeKeepAlive.bind(self), 2000).done(function() {
                debuglog("Keep-alive successful.");
                // blow away the current /sync request if the connection is still
                // dead. It may be black-holed.
                if (!self._syncConnectionLost) {
                    return;
                }
                if (self._currentSyncRequest.abort) {
                    // kill the current sync request
                    debuglog("Aborting current /sync.");
                    self._currentSyncRequest.abort();
                }
            });
        }
        console.error("/sync error (%s attempts): %s", attempt, err);
        console.error(err);
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function(newAttempt) {
            self._sync(syncOptions, newAttempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
};

/**
 * @return {Promise}
 */
SyncApi.prototype._pokeKeepAlive = function() {
    return this.client._http.requestWithPrefix(
        undefined, "GET", "/_matrix/client/versions", undefined,
        undefined, "", 5 * 1000
    );
};

/**
 * @param {string} filterName
 * @param {Filter} filter
 * @return {Promise<String>} Filter ID
 */
SyncApi.prototype._getOrCreateFilter = function(filterName, filter) {
    var client = this.client;
    var filterId = client.store.getFilterIdByName(filterName);
    if (filterId) {
        // super, just use that.
        return q(filterId);
    }

    // create a filter
    return client.createFilter(filter.getDefinition()).then(function(createdFilter) {
        client.store.setFilterIdByName(filterName, createdFilter.filterId);
        return createdFilter.filterId;
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
    var client = this.client;
    var self = this;
    return utils.keys(obj).map(function(roomId) {
        var arrObj = obj[roomId];
        var room = client.store.getRoom(roomId);
        var isBrandNewRoom = false;
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
    var mapper = this.client.getEventMapper();
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
    var client = this.client;
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        var user = client.getUser(member.userId);
        var promise;
        if (user) {
            promise = q({
                avatar_url: user.avatarUrl,
                displayname: user.displayName
            });
        }
        else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            var inviteEvent = member.events.member;
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
 * @param {?MatrixEvent[]} timelineEventList A list of timeline events. Lower index
 * is earlier in time. Higher index is later.
 * @param {string=} paginationToken
 */
SyncApi.prototype._processRoomEvents = function(room, stateEventList,
                                                timelineEventList, paginationToken) {
    timelineEventList = timelineEventList || [];
    var client = this.client;
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    var oldStateEvents = utils.map(
        utils.deepCopy(
            stateEventList.map(function(mxEvent) { return mxEvent.event; })
        ), client.getEventMapper()
    );
    var stateEvents = stateEventList;

    // Set the pagination token BEFORE adding events to the timeline: it's not
    // unreasonable for clients to call scrollback() in response to Room.timeline
    // events which addEventsToTimeline will emit-- we want to make sure they use
    // the right token if and when they do.
    if (paginationToken) {
        room.oldState.paginationToken = paginationToken;
    }

    // set the state of the room to as it was before the timeline executes
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(stateEvents);

    this._resolveInvites(room);

    // recalculate the room name at this point as adding events to the timeline
    // may make notifications appear which should have the right name.
    room.recalculate(this.client.credentials.userId);

    // execute the timeline events, this will begin to diverge the current state
    // if the timeline has any state events in it.
    room.addEventsToTimeline(timelineEventList);
};

/**
 * @return {string}
 */
SyncApi.prototype._getGuestFilter = function() {
    var guestRooms = this.client._guestRooms; // FIXME: horrible gut-wrenching
    if (!guestRooms) {
        return "{}";
    }
    // we just need to specify the filter inline if we're a guest because guests
    // can't create filters.
    return JSON.stringify({
        room: {
            timeline: {
                limit: 20
            }
        }
    });
};

function retryTimeMsForAttempt(attempt) {
    // 2,4,8,16,32,32,32,32,... seconds
    // max 2^5 secs = 32 secs
    return Math.pow(2, Math.min(attempt, 5)) * 1000;
}

function retryPromise(promiseFn, delay) {
    delay = delay || 0;
    return promiseFn().catch(function(reason) { // if it fails
        // retry after waiting the delay time
        return q.delay(delay).then(retryPromise.bind(null, promiseFn, delay));
    });
}

function startSyncingRetryTimer(client, attempt, fn) {
    client._syncingRetry = {};
    client._syncingRetry.fn = fn;
    var newAttempt = attempt;
    var timeBeforeWaitingMs = Date.now();
    var timeToWaitMs = retryTimeMsForAttempt(attempt);
    client._syncingRetry.timeoutId = setTimeout(function() {
        var timeAfterWaitingMs = Date.now();
        var timeDeltaMs = timeAfterWaitingMs - timeBeforeWaitingMs;
        if (timeDeltaMs > (2 * timeToWaitMs)) {
            // we've waited more than twice what we were supposed to. Reset the
            // attempt number back to 1. This can happen when the comp goes to
            // sleep whilst the timer is running.
            newAttempt = 1;
            console.warn(
                "Sync retry timer: Tried to wait %s ms but actually waited %s ms",
                timeToWaitMs, timeDeltaMs
            );
        }
        fn(newAttempt);
    }, timeToWaitMs);
}

function updateSyncState(client, newState, data) {
    var old = client._syncState;
    client._syncState = newState;
    client.emit("sync", client._syncState, old, data);
}

function createNewUser(client, userId) {
    var user = new User(userId);
    reEmit(client, user, ["User.avatarUrl", "User.displayName", "User.presence"]);
    return user;
}

function reEmit(reEmitEntity, emittableEntity, eventNames) {
    utils.forEach(eventNames, function(eventName) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function() {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            var newArgs = [eventName];
            for (var i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit.apply(reEmitEntity, newArgs);
        });
    });
}

/** */
module.exports = SyncApi;
