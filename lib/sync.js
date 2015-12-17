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

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
var BUFFER_PERIOD_MS = 20 * 1000;

function getFilterName(userId) {
    // scope this on the user ID because people may login on many accounts
    // and they all need to be stored!
    return "FILTER_SYNC_" + userId;
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
    opts.includeArchivedRooms = opts.includeArchivedRooms || false;
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pollTimeout = opts.pollTimeout || (30 * 1000);
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";
    this.opts = opts;
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
 * Main entry point
 */
SyncApi.prototype.sync = function() {
    console.log("SyncApi.sync");
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

        client.pushRules().done(function(result) {
            console.log("Got push rules");
            client.pushRules = result;
            getFilter(); // Now get the filter
        }, retryHandler(attempt, getPushRules));
    }

    function getFilter(attempt) {
        attempt = attempt || 0;
        attempt += 1;


        // Get or create filter
        var filterId = client.store.getFilterIdByName(
            getFilterName(client.credentials.userId)
        );
        if (filterId) {
            // super, just use that.
            console.log("Using existing filter ID %s", filterId);
            self._sync({ filterId: filterId });
            return;
        }

        // create a filter
        var filter = new Filter(client.credentials.userId);
        filter.setTimelineLimit(self.opts.initialSyncLimit);
        client.createFilter(filter.getDefinition()).done(function(filter) {
            client.store.setFilterIdByName(
                getFilterName(client.credentials.userId), filter.filterId
            );
            console.log("Created filter ", filter.filterId);
            self._sync({ filterId: filter.filterId }); // Now start the /sync loop
        }, retryHandler(attempt, getFilter));
    }

    // sets the sync state to error and waits a bit before re-invoking the function.
    function retryHandler(attempt, fnToRun) {
        return function(err) {
            startSyncingRetryTimer(client, attempt, function() {
                fnToRun(attempt);
            });
            updateSyncState(client, "ERROR", { error: err });
        };
    }

    if (client.isGuest()) {
        // no push rules for guests
        getFilter();
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

    // TODO include archived rooms flag.

    var qps = {
        filter: syncOptions.filterId,
        timeout: this.opts.pollTimeout,
        since: client.store.getSyncToken() || undefined // do not send 'null'
    };

    if (attempt > 1) {
        // we think the connection is dead. If it comes back up, we won't know
        // about it till /sync returns. If the timeout= is high, this could
        // be a long time. Set it to 1 when doing retries.
        qps.timeout = 1;
    }

    if (client._guestRooms && client._isGuest) {
        qps.room_id = client._guestRooms;
    }

    client._http.authedRequestWithPrefix(
        undefined, "GET", "/sync", qps, undefined, httpApi.PREFIX_V2_ALPHA,
        this.opts.pollTimeout + BUFFER_PERIOD_MS // normal timeout= plus buffer time
    ).done(function(data) {
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
        //          account_data: { events: [] }
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
                var stateEvents = self._mapSyncEventsFormat(inviteObj.invite_state, room);
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
                room.addEvents(ephemeralEvents);
                room.addEvents(accountDataEvents);
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
                var timelineEvents = self._mapSyncEventsFormat(leaveObj.timeline, room);
                room.addEvents(timelineEvents);

                // TODO: honour includeArchived opt

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
        console.error("/sync error (%s attempts): %s", attempt, err);
        console.error(err);
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            self._sync(syncOptions, attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
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

function retryTimeMsForAttempt(attempt) {
    // 2,4,8,16,32,64,128,128,128,... seconds
    // max 2^7 secs = 2.1 mins
    return Math.pow(2, Math.min(attempt, 7)) * 1000;
}

function startSyncingRetryTimer(client, attempt, fn) {
    client._syncingRetry = {};
    client._syncingRetry.fn = fn;
    client._syncingRetry.timeoutId = setTimeout(function() {
        fn();
    }, retryTimeMsForAttempt(attempt));
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
