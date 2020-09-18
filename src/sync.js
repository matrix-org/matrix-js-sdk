/*
Copyright 2015, 2016 OpenMarket Ltd
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

/*
 * TODO:
 * This class mainly serves to take all the syncing logic out of client.js and
 * into a separate file. It's all very fluid, and this class gut wrenches a lot
 * of MatrixClient props (e.g. _http). Given we want to support WebSockets as
 * an alternative syncing API, we may want to have a proper syncing interface
 * for HTTP and WS at some point.
 */

import {User} from "./models/user";
import {Room} from "./models/room";
import {Group} from "./models/group";
import * as utils from "./utils";
import {Filter} from "./filter";
import {EventTimeline} from "./models/event-timeline";
import {PushProcessor} from "./pushprocessor";
import {logger} from './logger';
import {InvalidStoreError} from './errors';

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
 * @param {Boolean=} opts.disablePresence True to perform syncing without automatically
 * updating presence.
 */
export function SyncApi(client, opts) {
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
    this._syncStateData = null; // additional data (eg. error object for failed sync)
    this._catchingUp = false;
    this._running = false;
    this._keepAliveTimer = null;
    this._connectionReturnedDefer = null;
    this._notifEvents = []; // accumulator of sync events in the current sync response
    this._failedSyncCount = 0; // Number of consecutive failed /sync requests
    this._storeIsInvalid = false; // flag set if the store needs to be cleared before we can start

    if (client.getNotifTimelineSet()) {
        client.reEmitter.reEmit(client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

/**
 * @param {string} roomId
 * @return {Room}
 */
SyncApi.prototype.createRoom = function(roomId) {
    const client = this.client;
    const {
        timelineSupport,
        unstableClientRelationAggregation,
    } = client;
    const room = new Room(roomId, client, client.getUserId(), {
        lazyLoadMembers: this.opts.lazyLoadMembers,
        pendingEventOrdering: this.opts.pendingEventOrdering,
        timelineSupport,
        unstableClientRelationAggregation,
    });
    client.reEmitter.reEmit(room, ["Room.name", "Room.timeline",
                          "Room.redaction",
                          "Room.redactionCancelled",
                          "Room.receipt", "Room.tags",
                          "Room.timelineReset",
                          "Room.localEchoUpdated",
                          "Room.accountData",
                          "Room.myMembership",
                          "Room.replaceEvent",
                         ]);
    this._registerStateListeners(room);
    return room;
};

/**
 * @param {string} groupId
 * @return {Group}
 */
SyncApi.prototype.createGroup = function(groupId) {
    const client = this.client;
    const group = new Group(groupId);
    client.reEmitter.reEmit(group, ["Group.profile", "Group.myMembership"]);
    client.store.storeGroup(group);
    return group;
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
    client.reEmitter.reEmit(room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember",
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        client.reEmitter.reEmit(
            member,
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

            room.recalculate();
            client.store.storeRoom(room);
            client.emit("Room", room);

            self._processEventsForNotifs(room, timelineEvents);
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
        peekRoom.recalculate();

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
    }, undefined, 50 * 1000).then(function(res) {
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
        // and also ephemeral events (which we're assuming is anything without
        // and event ID because the /events API doesn't separate them).
        const events = res.chunk.filter(function(e) {
            return e.room_id === peekRoom.roomId && e.event_id;
        }).map(self.client.getEventMapper());

        peekRoom.addLiveEvents(events);
        self._peekPoll(peekRoom, res.end);
    }, function(err) {
        logger.error("[%s] Peek poll failed: %s", peekRoom.roomId, err);
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
 * Returns the additional data object associated with
 * the current sync state, or null if there is no
 * such data.
 * Sync errors, if available, are put in the 'error' key of
 * this object.
 * @return {?Object}
 */
SyncApi.prototype.getSyncStateData = function() {
    return this._syncStateData;
};

SyncApi.prototype.recoverFromSyncStartupError = async function(savedSyncPromise, err) {
    // Wait for the saved sync to complete - we send the pushrules and filter requests
    // before the saved sync has finished so they can run in parallel, but only process
    // the results after the saved sync is done. Equivalently, we wait for it to finish
    // before reporting failures from these functions.
    await savedSyncPromise;
    const keepaliveProm = this._startKeepAlives();
    this._updateSyncState("ERROR", { error: err });
    await keepaliveProm;
};

/**
 * Is the lazy loading option different than in previous session?
 * @param {bool} lazyLoadMembers current options for lazy loading
 * @return {bool} whether or not the option has changed compared to the previous session */
SyncApi.prototype._wasLazyLoadingToggled = async function(lazyLoadMembers) {
    lazyLoadMembers = !!lazyLoadMembers;
    // assume it was turned off before
    // if we don't know any better
    let lazyLoadMembersBefore = false;
    const isStoreNewlyCreated = await this.client.store.isNewlyCreated();
    if (!isStoreNewlyCreated) {
        const prevClientOptions = await this.client.store.getClientOptions();
        if (prevClientOptions) {
            lazyLoadMembersBefore = !!prevClientOptions.lazyLoadMembers;
        }
        return lazyLoadMembersBefore !== lazyLoadMembers;
    }
    return false;
};

SyncApi.prototype._shouldAbortSync = function(error) {
    if (error.errcode === "M_UNKNOWN_TOKEN") {
        // The logout already happened, we just need to stop.
        logger.warn("Token no longer valid - assuming logout");
        this.stop();
        return true;
    }
    return false;
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

    let savedSyncPromise = Promise.resolve();
    let savedSyncToken = null;

    // We need to do one-off checks before we can begin the /sync loop.
    // These are:
    //   1) We need to get push rules so we can check if events should bing as we get
    //      them from /sync.
    //   2) We need to get/create a filter which we can use for /sync.
    //   3) We need to check the lazy loading option matches what was used in the
    //       stored sync. If it doesn't, we can't use the stored sync.

    async function getPushRules() {
        try {
            debuglog("Getting push rules...");
            const result = await client.getPushRules();
            debuglog("Got push rules");

            client.pushRules = result;
        } catch (err) {
            logger.error("Getting push rules failed", err);
            if (self._shouldAbortSync(err)) return;
            // wait for saved sync to complete before doing anything else,
            // otherwise the sync state will end up being incorrect
            debuglog("Waiting for saved sync before retrying push rules...");
            await self.recoverFromSyncStartupError(savedSyncPromise, err);
            getPushRules();
            return;
        }
        checkLazyLoadStatus(); // advance to the next stage
    }

    function buildDefaultFilter() {
        const filter = new Filter(client.credentials.userId);
        filter.setTimelineLimit(self.opts.initialSyncLimit);
        return filter;
    }

    const checkLazyLoadStatus = async () => {
        debuglog("Checking lazy load status...");
        if (this.opts.lazyLoadMembers && client.isGuest()) {
            this.opts.lazyLoadMembers = false;
        }
        if (this.opts.lazyLoadMembers) {
            debuglog("Checking server lazy load support...");
            const supported = await client.doesServerSupportLazyLoading();
            if (supported) {
                debuglog("Enabling lazy load on sync filter...");
                if (!this.opts.filter) {
                    this.opts.filter = buildDefaultFilter();
                }
                this.opts.filter.setLazyLoadMembers(true);
            } else {
                debuglog("LL: lazy loading requested but not supported " +
                    "by server, so disabling");
                this.opts.lazyLoadMembers = false;
            }
        }
        // need to vape the store when enabling LL and wasn't enabled before
        debuglog("Checking whether lazy loading has changed in store...");
        const shouldClear = await this._wasLazyLoadingToggled(this.opts.lazyLoadMembers);
        if (shouldClear) {
            this._storeIsInvalid = true;
            const reason = InvalidStoreError.TOGGLED_LAZY_LOADING;
            const error = new InvalidStoreError(reason, !!this.opts.lazyLoadMembers);
            this._updateSyncState("ERROR", { error });
            // bail out of the sync loop now: the app needs to respond to this error.
            // we leave the state as 'ERROR' which isn't great since this normally means
            // we're retrying. The client must be stopped before clearing the stores anyway
            // so the app should stop the client, clear the store and start it again.
            logger.warn("InvalidStoreError: store is not usable: stopping sync.");
            return;
        }
        if (this.opts.lazyLoadMembers && this.opts.crypto) {
            this.opts.crypto.enableLazyLoading();
        }
        try {
            debuglog("Storing client options...");
            await this.client._storeClientOptions();
            debuglog("Stored client options");
        } catch (err) {
            logger.error("Storing client options failed", err);
            throw err;
        }

        getFilter(); // Now get the filter and start syncing
    };

    async function getFilter() {
        debuglog("Getting filter...");
        let filter;
        if (self.opts.filter) {
            filter = self.opts.filter;
        } else {
            filter = buildDefaultFilter();
        }

        let filterId;
        try {
            filterId = await client.getOrCreateFilter(
                getFilterName(client.credentials.userId), filter,
            );
        } catch (err) {
            logger.error("Getting filter failed", err);
            if (self._shouldAbortSync(err)) return;
            // wait for saved sync to complete before doing anything else,
            // otherwise the sync state will end up being incorrect
            debuglog("Waiting for saved sync before retrying filter...");
            await self.recoverFromSyncStartupError(savedSyncPromise, err);
            getFilter();
            return;
        }
        // reset the notifications timeline to prepare it to paginate from
        // the current point in time.
        // The right solution would be to tie /sync pagination tokens into
        // /notifications API somehow.
        client.resetNotifTimelineSet();

        if (self._currentSyncRequest === null) {
            // Send this first sync request here so we can then wait for the saved
            // sync data to finish processing before we process the results of this one.
            debuglog("Sending first sync request...");
            self._currentSyncRequest = self._doSyncRequest({ filterId }, savedSyncToken);
        }

        // Now wait for the saved sync to finish...
        debuglog("Waiting for saved sync before starting sync processing...");
        await savedSyncPromise;
        self._sync({ filterId });
    }

    if (client.isGuest()) {
        // no push rules for guests, no access to POST filter for guests.
        self._sync({});
    } else {
        // Pull the saved sync token out first, before the worker starts sending
        // all the sync data which could take a while. This will let us send our
        // first incremental sync request before we've processed our saved data.
        debuglog("Getting saved sync token...");
        savedSyncPromise = client.store.getSavedSyncToken().then((tok) => {
            debuglog("Got saved sync token");
            savedSyncToken = tok;
            debuglog("Getting saved sync...");
            return client.store.getSavedSync();
        }).then((savedSync) => {
            debuglog(`Got reply from saved sync, exists? ${!!savedSync}`);
            if (savedSync) {
                return self._syncFromCache(savedSync);
            }
        }).catch(err => {
            logger.error("Getting saved sync failed", err);
        });
        // Now start the first incremental sync request: this can also
        // take a while so if we set it going now, we can wait for it
        // to finish while we process our saved sync data.
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
 * Process a single set of cached sync data.
 * @param {Object} savedSync a saved sync that was persisted by a store. This
 * should have been acquired via client.store.getSavedSync().
 */
SyncApi.prototype._syncFromCache = async function(savedSync) {
    debuglog("sync(): not doing HTTP hit, instead returning stored /sync data");

    const nextSyncToken = savedSync.nextBatch;

    // Set sync token for future incremental syncing
    this.client.store.setSyncToken(nextSyncToken);

    // No previous sync, set old token to null
    const syncEventData = {
        oldSyncToken: null,
        nextSyncToken,
        catchingUp: false,
        fromCache: true,
    };

    const data = {
        next_batch: nextSyncToken,
        rooms: savedSync.roomsData,
        groups: savedSync.groupsData,
        account_data: {
            events: savedSync.accountData,
        },
    };

    try {
        await this._processSyncResponse(syncEventData, data);
    } catch (e) {
        logger.error("Error processing cached sync", e.stack || e);
    }

    // Don't emit a prepared if we've bailed because the store is invalid:
    // in this case the client will not be usable until stopped & restarted
    // so this would be useless and misleading.
    if (!this._storeIsInvalid) {
        this._updateSyncState("PREPARED", syncEventData);
    }
};

/**
 * Invoke me to do /sync calls
 * @param {Object} syncOptions
 * @param {string} syncOptions.filterId
 * @param {boolean} syncOptions.hasSyncedBefore
 */
SyncApi.prototype._sync = async function(syncOptions) {
    const client = this.client;

    if (!this._running) {
        debuglog("Sync no longer running: exiting.");
        if (this._connectionReturnedDefer) {
            this._connectionReturnedDefer.reject();
            this._connectionReturnedDefer = null;
        }
        this._updateSyncState("STOPPED");
        return;
    }

    const syncToken = client.store.getSyncToken();

    let data;
    try {
        //debuglog('Starting sync since=' + syncToken);
        if (this._currentSyncRequest === null) {
            this._currentSyncRequest = this._doSyncRequest(syncOptions, syncToken);
        }
        data = await this._currentSyncRequest;
    } catch (e) {
        this._onSyncError(e, syncOptions);
        return;
    } finally {
        this._currentSyncRequest = null;
    }

    //debuglog('Completed sync, next_batch=' + data.next_batch);

    // set the sync token NOW *before* processing the events. We do this so
    // if something barfs on an event we can skip it rather than constantly
    // polling with the same token.
    client.store.setSyncToken(data.next_batch);

    // Reset after a successful sync
    this._failedSyncCount = 0;

    await client.store.setSyncData(data);

    const syncEventData = {
        oldSyncToken: syncToken,
        nextSyncToken: data.next_batch,
        catchingUp: this._catchingUp,
    };

    if (this.opts.crypto) {
        // tell the crypto module we're about to process a sync
        // response
        await this.opts.crypto.onSyncWillProcess(syncEventData);
    }

    try {
        await this._processSyncResponse(syncEventData, data);
    } catch (e) {
        // log the exception with stack if we have it, else fall back
        // to the plain description
        logger.error("Caught /sync error", e.stack || e);

        // Emit the exception for client handling
        this.client.emit("sync.unexpectedError", e);
    }

    // update this as it may have changed
    syncEventData.catchingUp = this._catchingUp;

    // emit synced events
    if (!syncOptions.hasSyncedBefore) {
        this._updateSyncState("PREPARED", syncEventData);
        syncOptions.hasSyncedBefore = true;
    }

    // tell the crypto module to do its processing. It may block (to do a
    // /keys/changes request).
    if (this.opts.crypto) {
        await this.opts.crypto.onSyncCompleted(syncEventData);
    }

    // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
    this._updateSyncState("SYNCING", syncEventData);

    if (client.store.wantsSave()) {
        // We always save the device list (if it's dirty) before saving the sync data:
        // this means we know the saved device list data is at least as fresh as the
        // stored sync data which means we don't have to worry that we may have missed
        // device changes. We can also skip the delay since we're not calling this very
        // frequently (and we don't really want to delay the sync for it).
        if (this.opts.crypto) {
            await this.opts.crypto.saveDeviceList(0);
        }

        // tell databases that everything is now in a consistent state and can be saved.
        client.store.save();
    }

    // Begin next sync
    this._sync(syncOptions);
};

SyncApi.prototype._doSyncRequest = function(syncOptions, syncToken) {
    const qps = this._getSyncParams(syncOptions, syncToken);
    return this.client._http.authedRequest(
        undefined, "GET", "/sync", qps, undefined,
        qps.timeout + BUFFER_PERIOD_MS,
    );
};

SyncApi.prototype._getSyncParams = function(syncOptions, syncToken) {
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

    let filterId = syncOptions.filterId;
    if (this.client.isGuest() && !filterId) {
        filterId = this._getGuestFilter();
    }

    const qps = {
        filter: filterId,
        timeout: pollTimeout,
    };

    if (this.opts.disablePresence) {
        qps.set_presence = "offline";
    }

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

    return qps;
};

SyncApi.prototype._onSyncError = function(err, syncOptions) {
    if (!this._running) {
        debuglog("Sync no longer running: exiting");
        if (this._connectionReturnedDefer) {
            this._connectionReturnedDefer.reject();
            this._connectionReturnedDefer = null;
        }
        this._updateSyncState("STOPPED");
        return;
    }

    logger.error("/sync error %s", err);
    logger.error(err);

    if (this._shouldAbortSync(err)) {
        return;
    }

    this._failedSyncCount++;
    logger.log('Number of consecutive failed sync requests:', this._failedSyncCount);

    debuglog("Starting keep-alive");
    // Note that we do *not* mark the sync connection as
    // lost yet: we only do this if a keepalive poke
    // fails, since long lived HTTP connections will
    // go away sometimes and we shouldn't treat this as
    // erroneous. We set the state to 'reconnecting'
    // instead, so that clients can observe this state
    // if they wish.
    this._startKeepAlives().then((connDidFail) => {
        // Only emit CATCHUP if we detected a connectivity error: if we didn't,
        // it's quite likely the sync will fail again for the same reason and we
        // want to stay in ERROR rather than keep flip-flopping between ERROR
        // and CATCHUP.
        if (connDidFail && this.getSyncState() === 'ERROR') {
            this._updateSyncState("CATCHUP", {
                oldSyncToken: null,
                nextSyncToken: null,
                catchingUp: true,
            });
        }
        this._sync(syncOptions);
    });

    this._currentSyncRequest = null;
    // Transition from RECONNECTING to ERROR after a given number of failed syncs
    this._updateSyncState(
        this._failedSyncCount >= FAILED_SYNC_ERROR_THRESHOLD ?
            "ERROR" : "RECONNECTING",
        { error: err },
    );
};

/**
 * Process data returned from a sync response and propagate it
 * into the model objects
 *
 * @param {Object} syncEventData Object containing sync tokens associated with this sync
 * @param {Object} data The response from /sync
 */
SyncApi.prototype._processSyncResponse = async function(
    syncEventData, data,
) {
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
    //          summary: {
    //             m.heroes: [ $user_id ],
    //             m.joined_member_count: $count,
    //             m.invited_member_count: $count
    //          },
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
    //    groups: {
    //        invite: {
    //            $groupId: {
    //                inviter: $inviter,
    //                profile: {
    //                    avatar_url: $avatarUrl,
    //                    name: $groupName,
    //                },
    //            },
    //        },
    //        join: {},
    //        leave: {},
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
        const prevEventsMap = events.reduce((m, c) => {
            m[c.getId()] = client.store.getAccountData(c.getType());
            return m;
        }, {});
        client.store.storeAccountDataEvents(events);
        events.forEach(
            function(accountDataEvent) {
                // Honour push rules that come down the sync stream but also
                // honour push rules that were previously cached. Base rules
                // will be updated when we receive push rules via getPushRules
                // (see SyncApi.prototype.sync) before syncing over the network.
                if (accountDataEvent.getType() === 'm.push_rules') {
                    const rules = accountDataEvent.getContent();
                    client.pushRules = PushProcessor.rewriteDefaultRules(rules);
                }
                const prevEvent = prevEventsMap[accountDataEvent.getId()];
                client.emit("accountData", accountDataEvent, prevEvent);
                return accountDataEvent;
            },
        );
    }

    // handle to-device events
    if (data.to_device && utils.isArray(data.to_device.events) &&
        data.to_device.events.length > 0
       ) {
        const cancelledKeyVerificationTxns = [];
        data.to_device.events
            .map(client.getEventMapper())
            .map((toDeviceEvent) => { // map is a cheap inline forEach
                // We want to flag m.key.verification.start events as cancelled
                // if there's an accompanying m.key.verification.cancel event, so
                // we pull out the transaction IDs from the cancellation events
                // so we can flag the verification events as cancelled in the loop
                // below.
                if (toDeviceEvent.getType() === "m.key.verification.cancel") {
                    const txnId = toDeviceEvent.getContent()['transaction_id'];
                    if (txnId) {
                        cancelledKeyVerificationTxns.push(txnId);
                    }
                }

                // as mentioned above, .map is a cheap inline forEach, so return
                // the unmodified event.
                return toDeviceEvent;
            })
            .forEach(
                function(toDeviceEvent) {
                    const content = toDeviceEvent.getContent();
                    if (
                        toDeviceEvent.getType() == "m.room.message" &&
                            content.msgtype == "m.bad.encrypted"
                    ) {
                        // the mapper already logged a warning.
                        logger.log(
                            'Ignoring undecryptable to-device event from ' +
                                toDeviceEvent.getSender(),
                        );
                        return;
                    }

                    if (toDeviceEvent.getType() === "m.key.verification.start"
                        || toDeviceEvent.getType() === "m.key.verification.request") {
                        const txnId = content['transaction_id'];
                        if (cancelledKeyVerificationTxns.includes(txnId)) {
                            toDeviceEvent.flagCancelled();
                        }
                    }

                    client.emit("toDeviceEvent", toDeviceEvent);
                },
            );
    } else {
        // no more to-device events: we can stop polling with a short timeout.
        this._catchingUp = false;
    }

    if (data.groups) {
        if (data.groups.invite) {
            this._processGroupSyncEntry(data.groups.invite, 'invite');
        }

        if (data.groups.join) {
            this._processGroupSyncEntry(data.groups.join, 'join');
        }

        if (data.groups.leave) {
            this._processGroupSyncEntry(data.groups.leave, 'leave');
        }
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
            room.recalculate();
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        room.updateMyMembership("invite");
    });

    // Handle joins
    await utils.promiseMapSeries(joinRooms, async function(joinObj) {
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

            // We track unread notifications ourselves in encrypted rooms, so don't
            // bother setting it here. We trust our calculations better than the
            // server's for this case, and therefore will assume that our non-zero
            // count is accurate.
            const encrypted = client.isRoomEncrypted(room.roomId);
            if (!encrypted
                || (encrypted && room.getUnreadNotificationCount('highlight') <= 0)) {
                room.setUnreadNotificationCount(
                    'highlight', joinObj.unread_notifications.highlight_count,
                );
            }
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
                self._deregisterStateListeners(room);
                room.resetLiveTimeline(
                    joinObj.timeline.prev_batch,
                    self.opts.canResetEntireTimeline(room.roomId) ?
                        null : syncEventData.oldSyncToken,
                );

                // We have to assume any gap in any timeline is
                // reason to stop incrementally tracking notifications and
                // reset the timeline.
                client.resetNotifTimelineSet();

                self._registerStateListeners(room);
            }
        }

        self._processRoomEvents(room, stateEvents,
            timelineEvents, syncEventData.fromCache);

        // set summary after processing events,
        // because it will trigger a name calculation
        // which needs the room state to be up to date
        if (joinObj.summary) {
            room.setSummary(joinObj.summary);
        }

        // we deliberately don't add ephemeral events to the timeline
        room.addEphemeralEvents(ephemeralEvents);

        // we deliberately don't add accountData to the timeline
        room.addAccountData(accountDataEvents);

        room.recalculate();
        if (joinObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }

        self._processEventsForNotifs(room, timelineEvents);

        async function processRoomEvent(e) {
            client.emit("event", e);
            if (e.isState() && e.getType() == "m.room.encryption" && self.opts.crypto) {
                await self.opts.crypto.onCryptoEvent(e);
            }
            if (e.isState() && e.getType() === "im.vector.user_status") {
                let user = client.store.getUser(e.getStateKey());
                if (user) {
                    user._unstable_updateStatusMessage(e);
                } else {
                    user = createNewUser(client, e.getStateKey());
                    user._unstable_updateStatusMessage(e);
                    client.store.storeUser(user);
                }
            }
        }

        await utils.promiseMapSeries(stateEvents, processRoomEvent);
        await utils.promiseMapSeries(timelineEvents, processRoomEvent);
        ephemeralEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });

        room.updateMyMembership("join");
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

        room.recalculate();
        if (leaveObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }

        self._processEventsForNotifs(room, timelineEvents);

        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        timelineEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });

        room.updateMyMembership("leave");
    });

    // update the notification timeline, if appropriate.
    // we only do this for live events, as otherwise we can't order them sanely
    // in the timeline relative to ones paginated in by /notifications.
    // XXX: we could fix this by making EventTimeline support chronological
    // ordering... but it doesn't, right now.
    if (syncEventData.oldSyncToken && this._notifEvents.length) {
        this._notifEvents.sort(function(a, b) {
            return a.getTs() - b.getTs();
        });
        this._notifEvents.forEach(function(event) {
            client.getNotifTimelineSet().addLiveEvent(event);
        });
    }

    // Handle device list updates
    if (data.device_lists) {
        if (this.opts.crypto) {
            await this.opts.crypto.handleDeviceListChanges(
                syncEventData, data.device_lists,
            );
        } else {
            // FIXME if we *don't* have a crypto module, we still need to
            // invalidate the device lists. But that would require a
            // substantial bit of rework :/.
        }
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
        this._connectionReturnedDefer = utils.defer();
    }
    return this._connectionReturnedDefer.promise;
};

/**
 * Make a dummy call to /_matrix/client/versions, to see if the HS is
 * reachable.
 *
 * On failure, schedules a call back to itself. On success, resolves
 * this._connectionReturnedDefer.
 *
 * @param {bool} connDidFail True if a connectivity failure has been detected. Optional.
 */
SyncApi.prototype._pokeKeepAlive = function(connDidFail) {
    if (connDidFail === undefined) connDidFail = false;
    const self = this;
    function success() {
        clearTimeout(self._keepAliveTimer);
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.resolve(connDidFail);
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
    ).then(function() {
        success();
    }, function(err) {
        if (err.httpStatus == 400 || err.httpStatus == 404) {
            // treat this as a success because the server probably just doesn't
            // support /versions: point is, we're getting a response.
            // We wait a short time though, just in case somehow the server
            // is in a mode where it 400s /versions responses and sync etc.
            // responses fail, this will mean we don't hammer in a loop.
            self._keepAliveTimer = setTimeout(success, 2000);
        } else {
            connDidFail = true;
            self._keepAliveTimer = setTimeout(
                self._pokeKeepAlive.bind(self, connDidFail),
                5000 + Math.floor(Math.random() * 5000),
            );
            // A keepalive has failed, so we emit the
            // error state (whether or not this is the
            // first failure).
            // Note we do this after setting the timer:
            // this lets the unit tests advance the mock
            // clock when they get the error.
            self._updateSyncState("ERROR", { error: err });
        }
    });
};

/**
 * @param {Object} groupsSection Groups section object, eg. response.groups.invite
 * @param {string} sectionName Which section this is ('invite', 'join' or 'leave')
 */
SyncApi.prototype._processGroupSyncEntry = function(groupsSection, sectionName) {
    // Processes entries from 'groups' section of the sync stream
    for (const groupId of Object.keys(groupsSection)) {
        const groupInfo = groupsSection[groupId];
        let group = this.client.store.getGroup(groupId);
        const isBrandNew = group === null;
        if (group === null) {
            group = this.createGroup(groupId);
        }
        if (groupInfo.profile) {
            group.setProfile(
                groupInfo.profile.name, groupInfo.profile.avatar_url,
            );
        }
        if (groupInfo.inviter) {
            group.setInviter({userId: groupInfo.inviter});
        }
        group.setMyMembership(sectionName);
        if (isBrandNew) {
            // Now we've filled in all the fields, emit the Group event
            this.client.emit("Group", group);
        }
    }
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
        promise.then(function(info) {
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
 * @param {boolean} fromCache whether the sync response came from cache
 * is earlier in time. Higher index is later.
 */
SyncApi.prototype._processRoomEvents = function(room, stateEventList,
                                                timelineEventList, fromCache) {
    // If there are no events in the timeline yet, initialise it with
    // the given state events
    const liveTimeline = room.getLiveTimeline();
    const timelineWasEmpty = liveTimeline.getEvents().length == 0;
    if (timelineWasEmpty) {
        // Passing these events into initialiseState will freeze them, so we need
        // to compute and cache the push actions for them now, otherwise sync dies
        // with an attempt to assign to read only property.
        // XXX: This is pretty horrible and is assuming all sorts of behaviour from
        // these functions that it shouldn't be. We should probably either store the
        // push actions cache elsewhere so we can freeze MatrixEvents, or otherwise
        // find some solution where MatrixEvents are immutable but allow for a cache
        // field.
        for (const ev of stateEventList) {
            this.client.getPushActionsForEvent(ev);
        }
        liveTimeline.initialiseState(stateEventList);
    }

    this._resolveInvites(room);

    // recalculate the room name at this point as adding events to the timeline
    // may make notifications appear which should have the right name.
    // XXX: This looks suspect: we'll end up recalculating the room once here
    // and then again after adding events (_processSyncResponse calls it after
    // calling us) even if no state events were added. It also means that if
    // one of the room events in timelineEventList is something that needs
    // a recalculation (like m.room.name) we won't recalculate until we've
    // finished adding all the events, which will cause the notification to have
    // the old room name rather than the new one.
    room.recalculate();

    // If the timeline wasn't empty, we process the state events here: they're
    // defined as updates to the state before the start of the timeline, so this
    // starts to roll the state forward.
    // XXX: That's what we *should* do, but this can happen if we were previously
    // peeking in a room, in which case we obviously do *not* want to add the
    // state events here onto the end of the timeline. Historically, the js-sdk
    // has just set these new state events on the old and new state. This seems
    // very wrong because there could be events in the timeline that diverge the
    // state, in which case this is going to leave things out of sync. However,
    // for now I think it;s best to behave the same as the code has done previously.
    if (!timelineWasEmpty) {
        // XXX: As above, don't do this...
        //room.addLiveEvents(stateEventList || []);
        // Do this instead...
        room.oldState.setStateEvents(stateEventList || []);
        room.currentState.setStateEvents(stateEventList || []);
    }
    // execute the timeline events. This will continue to diverge the current state
    // if the timeline has any state events in it.
    // This also needs to be done before running push rules on the events as they need
    // to be decorated with sender etc.
    room.addLiveEvents(timelineEventList || [], null, fromCache);
};

/**
 * Takes a list of timelineEvents and adds and adds to _notifEvents
 * as appropriate.
 * This must be called after the room the events belong to has been stored.
 *
 * @param {Room} room
 * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
 * is earlier in time. Higher index is later.
 */
SyncApi.prototype._processEventsForNotifs = function(room, timelineEventList) {
    // gather our notifications into this._notifEvents
    if (this.client.getNotifTimelineSet()) {
        for (let i = 0; i < timelineEventList.length; i++) {
            const pushActions = this.client.getPushActionsForEvent(timelineEventList[i]);
            if (pushActions && pushActions.notify &&
                pushActions.tweaks && pushActions.tweaks.highlight) {
                this._notifEvents.push(timelineEventList[i]);
            }
        }
    }
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
    this._syncStateData = data;
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
    client.reEmitter.reEmit(user, [
        "User.avatarUrl", "User.displayName", "User.presence",
        "User.currentlyActive", "User.lastPresenceTs",
    ]);
    return user;
}

