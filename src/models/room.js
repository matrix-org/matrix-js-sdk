/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2018 New Vector Ltd

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
 * @module models/room
 */
const EventEmitter = require("events").EventEmitter;

const EventStatus = require("./event").EventStatus;
const RoomSummary = require("./room-summary");
const RoomMember = require("./room-member");
const MatrixEvent = require("./event").MatrixEvent;
const utils = require("../utils");
const ContentRepo = require("../content-repo");
const EventTimeline = require("./event-timeline");
const EventTimelineSet = require("./event-timeline-set");

import ReEmitter from '../ReEmitter';

const LATEST_ROOM_VERSION = '1';

function synthesizeReceipt(userId, event, receiptType) {
    // console.log("synthesizing receipt for "+event.getId());
    // This is really ugly because JS has no way to express an object literal
    // where the name of a key comes from an expression
    const fakeReceipt = {
        content: {},
        type: "m.receipt",
        room_id: event.getRoomId(),
    };
    fakeReceipt.content[event.getId()] = {};
    fakeReceipt.content[event.getId()][receiptType] = {};
    fakeReceipt.content[event.getId()][receiptType][userId] = {
        ts: event.getTs(),
    };
    return new MatrixEvent(fakeReceipt);
}


/**
 * Construct a new Room.
 *
 * <p>For a room, we store an ordered sequence of timelines, which may or may not
 * be continuous. Each timeline lists a series of events, as well as tracking
 * the room state at the start and the end of the timeline. It also tracks
 * forward and backward pagination tokens, as well as containing links to the
 * next timeline in the sequence.
 *
 * <p>There is one special timeline - the 'live' timeline, which represents the
 * timeline to which events are being added in real-time as they are received
 * from the /sync API. Note that you should not retain references to this
 * timeline - even if it is the current timeline right now, it may not remain
 * so if the server gives us a timeline gap in /sync.
 *
 * <p>In order that we can find events from their ids later, we also maintain a
 * map from event_id to timeline and index.
 *
 * @constructor
 * @alias module:models/room
 * @param {string} roomId Required. The ID of this room.
 * @param {MatrixClient} client Required. The client, used to lazy load members.
 * @param {string} myUserId Required. The ID of the syncing user.
 * @param {Object=} opts Configuration options
 * @param {*} opts.storageToken Optional. The token which a data store can use
 * to remember the state of the room. What this means is dependent on the store
 * implementation.
 *
 * @param {String=} opts.pendingEventOrdering Controls where pending messages
 * appear in a room's timeline. If "<b>chronological</b>", messages will appear
 * in the timeline when the call to <code>sendEvent</code> was made. If
 * "<b>detached</b>", pending messages will appear in a separate list,
 * accessbile via {@link module:models/room#getPendingEvents}. Default:
 * "chronological".
 *
 * @param {boolean} [opts.timelineSupport = false] Set to true to enable improved
 * timeline support.
 *
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The live event timeline for this room,
 * with the oldest event at index 0. Present for backwards compatibility -
 * prefer getLiveTimeline().getEvents().
 * @prop {object} tags Dict of room tags; the keys are the tag name and the values
 * are any metadata associated with the tag - e.g. { "fav" : { order: 1 } }
 * @prop {object} accountData Dict of per-room account_data events; the keys are the
 * event type and the values are the events.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the live timeline. Present for backwards compatibility -
 * prefer getLiveTimeline().getState(EventTimeline.BACKWARDS).
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline. Present for backwards compatibility -
 * prefer getLiveTimeline().getState(EventTimeline.FORWARDS).
 * @prop {RoomSummary} summary The room summary.
 * @prop {*} storageToken A token which a data store can use to remember
 * the state of the room.
 */
function Room(roomId, client, myUserId, opts) {
    opts = opts || {};
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";

    this.reEmitter = new ReEmitter(this);

    if (["chronological", "detached"].indexOf(opts.pendingEventOrdering) === -1) {
        throw new Error(
            "opts.pendingEventOrdering MUST be either 'chronological' or " +
            "'detached'. Got: '" + opts.pendingEventOrdering + "'",
        );
    }

    this.myUserId = myUserId;
    this.roomId = roomId;
    this.name = roomId;
    this.tags = {
        // $tagName: { $metadata: $value },
        // $tagName: { $metadata: $value },
    };
    this.accountData = {
        // $eventType: $event
    };
    this.summary = null;
    this.storageToken = opts.storageToken;
    this._opts = opts;
    this._txnToEvent = {}; // Pending in-flight requests { string: MatrixEvent }
    // receipts should clobber based on receipt_type and user_id pairs hence
    // the form of this structure. This is sub-optimal for the exposed APIs
    // which pass in an event ID and get back some receipts, so we also store
    // a pre-cached list for this purpose.
    this._receipts = {
        // receipt_type: {
        //   user_id: {
        //     eventId: <event_id>,
        //     data: <receipt_data>
        //   }
        // }
    };
    this._receiptCacheByEventId = {
        // $event_id: [{
        //   type: $type,
        //   userId: $user_id,
        //   data: <receipt data>
        // }]
    };
    // only receipts that came from the server, not synthesized ones
    this._realReceipts = {};

    this._notificationCounts = {};

    // all our per-room timeline sets. the first one is the unfiltered ones;
    // the subsequent ones are the filtered ones in no particular order.
    this._timelineSets = [new EventTimelineSet(this, opts)];
    this.reEmitter.reEmit(this.getUnfilteredTimelineSet(),
           ["Room.timeline", "Room.timelineReset"]);

    this._fixUpLegacyTimelineFields();

    // any filtered timeline sets we're maintaining for this room
    this._filteredTimelineSets = {
        // filter_id: timelineSet
    };

    if (this._opts.pendingEventOrdering == "detached") {
        this._pendingEventList = [];
    }

    // read by megolm; boolean value - null indicates "use global value"
    this._blacklistUnverifiedDevices = null;
    this._selfMembership = null;
    this._summaryHeroes = null;
    // awaited by getEncryptionTargetMembers while room members are loading

    this._client = client;
    if (!this._opts.lazyLoadMembers) {
        this._membersPromise = Promise.resolve();
    } else {
        this._membersPromise = null;
    }
}

utils.inherits(Room, EventEmitter);

/**
 * Gets the version of the room
 * @returns {string} The version of the room, or null if it could not be determined
 */
Room.prototype.getVersion = function() {
    const createEvent = this.currentState.getStateEvents("m.room.create", "");
    if (!createEvent) {
        console.warn("Room " + this.room_id + " does not have an m.room.create event");
        return '1';
    }
    const ver = createEvent.getContent()['room_version'];
    if (ver === undefined) return '1';
    return ver;
};

/**
 * Determines whether this room needs to be upgraded to a new version
 * @returns {string?} What version the room should be upgraded to, or null if
 *     the room does not require upgrading at this time.
 */
Room.prototype.shouldUpgradeToVersion = function() {
    // This almost certainly won't be the way this actually works - this
    // is essentially a stub method.
    if (this.getVersion() === LATEST_ROOM_VERSION) return null;
    return LATEST_ROOM_VERSION;
};

/**
 * Determines whether the given user is permitted to perform a room upgrade
 * @param {String} userId The ID of the user to test against
 * @returns {bool} True if the given user is permitted to upgrade the room
 */
Room.prototype.userMayUpgradeRoom = function(userId) {
    return this.currentState.maySendStateEvent("m.room.tombstone", userId);
};

/**
 * Get the list of pending sent events for this room
 *
 * @return {module:models/event.MatrixEvent[]} A list of the sent events
 * waiting for remote echo.
 *
 * @throws If <code>opts.pendingEventOrdering</code> was not 'detached'
 */
Room.prototype.getPendingEvents = function() {
    if (this._opts.pendingEventOrdering !== "detached") {
        throw new Error(
            "Cannot call getPendingEventList with pendingEventOrdering == " +
                this._opts.pendingEventOrdering);
    }

    return this._pendingEventList;
};

/**
 * Get the live unfiltered timeline for this room.
 *
 * @return {module:models/event-timeline~EventTimeline} live timeline
 */
Room.prototype.getLiveTimeline = function() {
    return this.getUnfilteredTimelineSet().getLiveTimeline();
};

/**
 * @param {string} myUserId the user id for the logged in member
 * @return {string} the membership type (join | leave | invite) for the logged in user
 */
Room.prototype.getMyMembership = function() {
    return this._selfMembership;
};

/**
 * If this room is a DM we're invited to,
 * try to find out who invited us
 * @return {string} user id of the inviter
 */
Room.prototype.getDMInviter = function() {
    if (this.myUserId) {
        const me = this.getMember(this.myUserId);
        if (me) {
            return me.getDMInviter();
        }
    }
    if (this._selfMembership === "invite") {
        // fall back to summary information
        const memberCount = this.getInvitedAndJoinedMemberCount();
        if (memberCount == 2 && this._summaryHeroes.length) {
            return this._summaryHeroes[0];
        }
    }
};

/**
 * Assuming this room is a DM room, tries to guess with which user.
 * @return {string} user id of the other member (could be syncing user)
 */
Room.prototype.guessDMUserId = function() {
    const me = this.getMember(this.myUserId);
    if (me) {
        const inviterId = me.getDMInviter();
        if (inviterId) {
            return inviterId;
        }
    }
    // remember, we're assuming this room is a DM,
    // so returning the first member we find should be fine
    const hasHeroes = Array.isArray(this._summaryHeroes) &&
        this._summaryHeroes.length;
    if (hasHeroes) {
        return this._summaryHeroes[0];
    }
    const members = this.currentState.getMembers();
    const anyMember = members.find((m) => m.userId !== this.myUserId);
    if (anyMember) {
        return anyMember.userId;
    }
    // it really seems like I'm the only user in the room
    // so I probably created a room with just me in it
    // and marked it as a DM. Ok then
    return this.myUserId;
};

Room.prototype.getAvatarFallbackMember = function() {
    const memberCount = this.getInvitedAndJoinedMemberCount();
    if (memberCount > 2) {
        return;
    }
    const hasHeroes = Array.isArray(this._summaryHeroes) &&
        this._summaryHeroes.length;
    if (hasHeroes) {
        const availableMember = this._summaryHeroes.map((userId) => {
            return this.getMember(userId);
        }).find((member) => !!member);
        if (availableMember) {
            return availableMember;
        }
    }
    const members = this.currentState.getMembers();
    // could be different than memberCount
    // as this includes left members
    if (members.length <= 2) {
        const availableMember = members.find((m) => {
            return m.userId !== this.myUserId;
        });
        if (availableMember) {
            return availableMember;
        }
    }
    // if all else fails, try falling back to a user,
    // and create a one-off member for it
    if (hasHeroes) {
        const availableUser = this._summaryHeroes.map((userId) => {
            return this._client.getUser(userId);
        }).find((user) => !!user);
        if (availableUser) {
            const member = new RoomMember(
                this.roomId, availableUser.userId);
            member.user = availableUser;
            return member;
        }
    }
};

/**
 * Sets the membership this room was received as during sync
 * @param {string} membership join | leave | invite
 */
Room.prototype.updateMyMembership = function(membership) {
    const prevMembership = this._selfMembership;
    this._selfMembership = membership;
    if (prevMembership !== membership) {
        if (membership === "leave") {
            this._cleanupAfterLeaving();
        }
        this.emit("Room.myMembership", this, membership, prevMembership);
    }
};

Room.prototype._loadMembersFromServer = async function() {
    const lastSyncToken = this._client.store.getSyncToken();
    const queryString = utils.encodeParams({
        not_membership: "leave",
        at: lastSyncToken,
    });
    const path = utils.encodeUri("/rooms/$roomId/members?" + queryString,
        {$roomId: this.roomId});
    const http = this._client._http;
    const response = await http.authedRequest(undefined, "GET", path);
    return response.chunk;
};


Room.prototype._loadMembers = async function() {
    // were the members loaded from the server?
    let fromServer = false;
    let rawMembersEvents =
        await this._client.store.getOutOfBandMembers(this.roomId);
    if (rawMembersEvents === null) {
        fromServer = true;
        rawMembersEvents = await this._loadMembersFromServer();
        console.log(`LL: got ${rawMembersEvents.length} ` +
            `members from server for room ${this.roomId}`);
    }
    const memberEvents = rawMembersEvents.map(this._client.getEventMapper());
    return {memberEvents, fromServer};
};

/**
 * Preloads the member list in case lazy loading
 * of memberships is in use. Can be called multiple times,
 * it will only preload once.
 * @return {Promise} when preloading is done and
 * accessing the members on the room will take
 * all members in the room into account
 */
Room.prototype.loadMembersIfNeeded = function() {
    if (this._membersPromise) {
        return this._membersPromise;
    }

    // mark the state so that incoming messages while
    // the request is in flight get marked as superseding
    // the OOB members
    this.currentState.markOutOfBandMembersStarted();

    const inMemoryUpdate = this._loadMembers().then((result) => {
        this.currentState.setOutOfBandMembers(result.memberEvents);
        // now the members are loaded, start to track the e2e devices if needed
        if (this._client.isRoomEncrypted(this.roomId)) {
            this._client._crypto.trackRoomDevices(this.roomId);
        }
        return result.fromServer;
    }).catch((err) => {
        // allow retries on fail
        this._membersPromise = null;
        this.currentState.markOutOfBandMembersFailed();
        throw err;
    });
    // update members in storage, but don't wait for it
    inMemoryUpdate.then((fromServer) => {
        if (fromServer) {
            const oobMembers = this.currentState.getMembers()
                .filter((m) => m.isOutOfBand())
                .map((m) => m.events.member.event);
            console.log(`LL: telling store to write ${oobMembers.length}`
                + ` members for room ${this.roomId}`);
            const store = this._client.store;
            return store.setOutOfBandMembers(this.roomId, oobMembers)
                // swallow any IDB error as we don't want to fail
                // because of this
                .catch((err) => {
                    console.log("LL: storing OOB room members failed, oh well",
                        err);
                });
        }
    }).catch((err) => {
        // as this is not awaited anywhere,
        // at least show the error in the console
        console.error(err);
    });

    this._membersPromise = inMemoryUpdate;

    return this._membersPromise;
};

/**
 * Removes the lazily loaded members from storage if needed
 */
Room.prototype.clearLoadedMembersIfNeeded = async function() {
    if (this._opts.lazyLoadMembers && this._membersPromise) {
        await this.loadMembersIfNeeded();
        await this._client.store.clearOutOfBandMembers(this.roomId);
        this.currentState.clearOutOfBandMembers();
        this._membersPromise = null;
    }
};

/**
 * called when sync receives this room in the leave section
 * to do cleanup after leaving a room. Possibly called multiple times.
 */
Room.prototype._cleanupAfterLeaving = function() {
    this.clearLoadedMembersIfNeeded().catch((err) => {
        console.error(`error after clearing loaded members from ` +
            `room ${this.roomId} after leaving`);
        console.dir(err);
    });
};

/**
 * Reset the live timeline of all timelineSets, and start new ones.
 *
 * <p>This is used when /sync returns a 'limited' timeline.
 *
 * @param {string=} backPaginationToken   token for back-paginating the new timeline
 * @param {string=} forwardPaginationToken token for forward-paginating the old live timeline,
 * if absent or null, all timelines are reset, removing old ones (including the previous live
 * timeline which would otherwise be unable to paginate forwards without this token).
 * Removing just the old live timeline whilst preserving previous ones is not supported.
 */
Room.prototype.resetLiveTimeline = function(backPaginationToken, forwardPaginationToken) {
    for (let i = 0; i < this._timelineSets.length; i++) {
        this._timelineSets[i].resetLiveTimeline(
            backPaginationToken, forwardPaginationToken,
        );
    }

    this._fixUpLegacyTimelineFields();
};

/**
 * Fix up this.timeline, this.oldState and this.currentState
 *
 * @private
 */
Room.prototype._fixUpLegacyTimelineFields = function() {
    // maintain this.timeline as a reference to the live timeline,
    // and this.oldState and this.currentState as references to the
    // state at the start and end of that timeline. These are more
    // for backwards-compatibility than anything else.
    this.timeline = this.getLiveTimeline().getEvents();
    this.oldState = this.getLiveTimeline()
                        .getState(EventTimeline.BACKWARDS);
    this.currentState = this.getLiveTimeline()
                            .getState(EventTimeline.FORWARDS);
};

/**
 * Return the timeline sets for this room.
 * @return {EventTimelineSet[]} array of timeline sets for this room
 */
Room.prototype.getTimelineSets = function() {
    return this._timelineSets;
};

/**
 * Helper to return the main unfiltered timeline set for this room
 * @return {EventTimelineSet} room's unfiltered timeline set
 */
Room.prototype.getUnfilteredTimelineSet = function() {
    return this._timelineSets[0];
};

/**
 * Get the timeline which contains the given event from the unfiltered set, if any
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event-timeline~EventTimeline} timeline containing
 * the given event, or null if unknown
 */
Room.prototype.getTimelineForEvent = function(eventId) {
    return this.getUnfilteredTimelineSet().getTimelineForEvent(eventId);
};

/**
 * Add a new timeline to this room's unfiltered timeline set
 *
 * @return {module:models/event-timeline~EventTimeline} newly-created timeline
 */
Room.prototype.addTimeline = function() {
    return this.getUnfilteredTimelineSet().addTimeline();
};

/**
 * Get an event which is stored in our unfiltered timeline set
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event.MatrixEvent} the given event, or undefined if unknown
 */
Room.prototype.findEventById = function(eventId) {
    return this.getUnfilteredTimelineSet().findEventById(eventId);
};

/**
 * Get one of the notification counts for this room
 * @param {String} type The type of notification count to get. default: 'total'
 * @return {Number} The notification count, or undefined if there is no count
 *                  for this type.
 */
Room.prototype.getUnreadNotificationCount = function(type) {
    type = type || 'total';
    return this._notificationCounts[type];
};

/**
 * Set one of the notification counts for this room
 * @param {String} type The type of notification count to set.
 * @param {Number} count The new count
 */
Room.prototype.setUnreadNotificationCount = function(type, count) {
    this._notificationCounts[type] = count;
};

Room.prototype.setSummary = function(summary) {
    const heroes = summary["m.heroes"];
    const joinedCount = summary["m.joined_member_count"];
    const invitedCount = summary["m.invited_member_count"];
    if (Number.isInteger(joinedCount)) {
        this.currentState.setJoinedMemberCount(joinedCount);
    }
    if (Number.isInteger(invitedCount)) {
        this.currentState.setInvitedMemberCount(invitedCount);
    }
    if (Array.isArray(heroes)) {
        // be cautious about trusting server values,
        // and make sure heroes doesn't contain our own id
        // just to be sure
        this._summaryHeroes = heroes.filter((userId) => {
            return userId !== this.myUserId;
        });
    }
};

/**
 * Whether to send encrypted messages to devices within this room.
 * @param {Boolean} value true to blacklist unverified devices, null
 * to use the global value for this room.
 */
Room.prototype.setBlacklistUnverifiedDevices = function(value) {
    this._blacklistUnverifiedDevices = value;
};

/**
 * Whether to send encrypted messages to devices within this room.
 * @return {Boolean} true if blacklisting unverified devices, null
 * if the global value should be used for this room.
 */
Room.prototype.getBlacklistUnverifiedDevices = function() {
    return this._blacklistUnverifiedDevices;
};

/**
 * Get the avatar URL for a room if one was set.
 * @param {String} baseUrl The homeserver base URL. See
 * {@link module:client~MatrixClient#getHomeserverUrl}.
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {boolean} allowDefault True to allow an identicon for this room if an
 * avatar URL wasn't explicitly set. Default: true.
 * @return {?string} the avatar URL or null.
 */
Room.prototype.getAvatarUrl = function(baseUrl, width, height, resizeMethod,
                                       allowDefault) {
    const roomAvatarEvent = this.currentState.getStateEvents("m.room.avatar", "");
    if (allowDefault === undefined) {
        allowDefault = true;
    }
    if (!roomAvatarEvent && !allowDefault) {
        return null;
    }

    const mainUrl = roomAvatarEvent ? roomAvatarEvent.getContent().url : null;
    if (mainUrl) {
        return ContentRepo.getHttpUriForMxc(
            baseUrl, mainUrl, width, height, resizeMethod,
        );
    } else if (allowDefault) {
        return ContentRepo.getIdenticonUri(
            baseUrl, this.roomId, width, height,
        );
    }

    return null;
};

/**
 * Get the aliases this room has according to the room's state
 * The aliases returned by this function may not necessarily
 * still point to this room.
 * @return {array} The room's alias as an array of strings
 */
Room.prototype.getAliases = function() {
    const alias_strings = [];

    const alias_events = this.currentState.getStateEvents("m.room.aliases");
    if (alias_events) {
        for (let i = 0; i < alias_events.length; ++i) {
            const alias_event = alias_events[i];
            if (utils.isArray(alias_event.getContent().aliases)) {
                Array.prototype.push.apply(
                    alias_strings, alias_event.getContent().aliases,
                );
            }
        }
    }
    return alias_strings;
};

/**
 * Get this room's canonical alias
 * The alias returned by this function may not necessarily
 * still point to this room.
 * @return {?string} The room's canonical alias, or null if there is none
 */
Room.prototype.getCanonicalAlias = function() {
    const canonicalAlias = this.currentState.getStateEvents("m.room.canonical_alias", "");
    if (canonicalAlias) {
        return canonicalAlias.getContent().alias;
    }
    return null;
};

/**
 * Add events to a timeline
 *
 * <p>Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent[]} events A list of events to add.
 *
 * @param {boolean} toStartOfTimeline   True to add these events to the start
 * (oldest) instead of the end (newest) of the timeline. If true, the oldest
 * event will be the <b>last</b> element of 'events'.
 *
 * @param {module:models/event-timeline~EventTimeline} timeline   timeline to
 *    add events to.
 *
 * @param {string=} paginationToken   token for the next batch of events
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 */
Room.prototype.addEventsToTimeline = function(events, toStartOfTimeline,
                                              timeline, paginationToken) {
    timeline.getTimelineSet().addEventsToTimeline(
        events, toStartOfTimeline,
        timeline, paginationToken,
    );
};

/**
 * Get a member from the current room state.
 * @param {string} userId The user ID of the member.
 * @return {RoomMember} The member or <code>null</code>.
 */
 Room.prototype.getMember = function(userId) {
    return this.currentState.getMember(userId);
 };

/**
 * Get a list of members whose membership state is "join".
 * @return {RoomMember[]} A list of currently joined members.
 */
 Room.prototype.getJoinedMembers = function() {
    return this.getMembersWithMembership("join");
 };

/**
 * Returns the number of joined members in this room
 * This method caches the result.
 * This is a wrapper around the method of the same name in roomState, returning
 * its result for the room's current state.
 * @return {integer} The number of members in this room whose membership is 'join'
 */
Room.prototype.getJoinedMemberCount = function() {
    return this.currentState.getJoinedMemberCount();
};

/**
 * Returns the number of invited members in this room
 * @return {integer} The number of members in this room whose membership is 'invite'
 */
Room.prototype.getInvitedMemberCount = function() {
    return this.currentState.getInvitedMemberCount();
};

/**
 * Returns the number of invited + joined members in this room
 * @return {integer} The number of members in this room whose membership is 'invite' or 'join'
 */
Room.prototype.getInvitedAndJoinedMemberCount = function() {
    return this.getInvitedMemberCount() + this.getJoinedMemberCount();
};

/**
 * Get a list of members with given membership state.
 * @param {string} membership The membership state.
 * @return {RoomMember[]} A list of members with the given membership state.
 */
 Room.prototype.getMembersWithMembership = function(membership) {
    return utils.filter(this.currentState.getMembers(), function(m) {
        return m.membership === membership;
    });
 };

 /**
  * Get a list of members we should be encrypting for in this room
  * @return {Promise<RoomMember[]>} A list of members who
  * we should encrypt messages for in this room.
  */
 Room.prototype.getEncryptionTargetMembers = async function() {
    await this.loadMembersIfNeeded();
    let members = this.getMembersWithMembership("join");
    if (this.shouldEncryptForInvitedMembers()) {
        members = members.concat(this.getMembersWithMembership("invite"));
    }
    return members;
 };

 /**
  * Determine whether we should encrypt messages for invited users in this room
  * @return {boolean} if we should encrypt messages for invited users
  */
 Room.prototype.shouldEncryptForInvitedMembers = function() {
    const ev = this.currentState.getStateEvents("m.room.history_visibility", "");
    return (ev && ev.getContent() && ev.getContent().history_visibility !== "joined");
 };

 /**
  * Get the default room name (i.e. what a given user would see if the
  * room had no m.room.name)
  * @param {string} userId The userId from whose perspective we want
  * to calculate the default name
  * @return {string} The default room name
  */
 Room.prototype.getDefaultRoomName = function(userId) {
    return calculateRoomName(this, userId, true);
 };


 /**
 * Check if the given user_id has the given membership state.
 * @param {string} userId The user ID to check.
 * @param {string} membership The membership e.g. <code>'join'</code>
 * @return {boolean} True if this user_id has the given membership state.
 */
 Room.prototype.hasMembershipState = function(userId, membership) {
    const member = this.getMember(userId);
    if (!member) {
        return false;
    }
    return member.membership === membership;
 };

/**
 * Add a timelineSet for this room with the given filter
 * @param {Filter} filter  The filter to be applied to this timelineSet
 * @return {EventTimelineSet}  The timelineSet
 */
Room.prototype.getOrCreateFilteredTimelineSet = function(filter) {
    if (this._filteredTimelineSets[filter.filterId]) {
        return this._filteredTimelineSets[filter.filterId];
    }
    const opts = Object.assign({ filter: filter }, this._opts);
    const timelineSet = new EventTimelineSet(this, opts);
    this.reEmitter.reEmit(timelineSet, ["Room.timeline", "Room.timelineReset"]);
    this._filteredTimelineSets[filter.filterId] = timelineSet;
    this._timelineSets.push(timelineSet);

    // populate up the new timelineSet with filtered events from our live
    // unfiltered timeline.
    //
    // XXX: This is risky as our timeline
    // may have grown huge and so take a long time to filter.
    // see https://github.com/vector-im/vector-web/issues/2109

    const unfilteredLiveTimeline = this.getLiveTimeline();

    unfilteredLiveTimeline.getEvents().forEach(function(event) {
        timelineSet.addLiveEvent(event);
    });

    // find the earliest unfiltered timeline
    let timeline = unfilteredLiveTimeline;
    while (timeline.getNeighbouringTimeline(EventTimeline.BACKWARDS)) {
        timeline = timeline.getNeighbouringTimeline(EventTimeline.BACKWARDS);
    }

    timelineSet.getLiveTimeline().setPaginationToken(
        timeline.getPaginationToken(EventTimeline.BACKWARDS),
        EventTimeline.BACKWARDS,
    );

    // alternatively, we could try to do something like this to try and re-paginate
    // in the filtered events from nothing, but Mark says it's an abuse of the API
    // to do so:
    //
    // timelineSet.resetLiveTimeline(
    //      unfilteredLiveTimeline.getPaginationToken(EventTimeline.FORWARDS)
    // );

    return timelineSet;
};

/**
 * Forget the timelineSet for this room with the given filter
 *
 * @param {Filter} filter  the filter whose timelineSet is to be forgotten
 */
Room.prototype.removeFilteredTimelineSet = function(filter) {
    const timelineSet = this._filteredTimelineSets[filter.filterId];
    delete this._filteredTimelineSets[filter.filterId];
    const i = this._timelineSets.indexOf(timelineSet);
    if (i > -1) {
        this._timelineSets.splice(i, 1);
    }
};

/**
 * Add an event to the end of this room's live timelines. Will fire
 * "Room.timeline".
 *
 * @param {MatrixEvent} event Event to be added
 * @param {string?} duplicateStrategy 'ignore' or 'replace'
 * @fires module:client~MatrixClient#event:"Room.timeline"
 * @private
 */
Room.prototype._addLiveEvent = function(event, duplicateStrategy) {
    let i;
    if (event.getType() === "m.room.redaction") {
        const redactId = event.event.redacts;

        // if we know about this event, redact its contents now.
        const redactedEvent = this.getUnfilteredTimelineSet().findEventById(redactId);
        if (redactedEvent) {
            redactedEvent.makeRedacted(event);
            this.emit("Room.redaction", event, this);

            // TODO: we stash user displaynames (among other things) in
            // RoomMember objects which are then attached to other events
            // (in the sender and target fields). We should get those
            // RoomMember objects to update themselves when the events that
            // they are based on are changed.
        }

        // FIXME: apply redactions to notification list

        // NB: We continue to add the redaction event to the timeline so
        // clients can say "so and so redacted an event" if they wish to. Also
        // this may be needed to trigger an update.
    }

    if (event.getUnsigned().transaction_id) {
        const existingEvent = this._txnToEvent[event.getUnsigned().transaction_id];
        if (existingEvent) {
            // remote echo of an event we sent earlier
            this._handleRemoteEcho(event, existingEvent);
            return;
        }
    }

    // add to our timeline sets
    for (i = 0; i < this._timelineSets.length; i++) {
        this._timelineSets[i].addLiveEvent(event, duplicateStrategy);
    }

    // synthesize and inject implicit read receipts
    // Done after adding the event because otherwise the app would get a read receipt
    // pointing to an event that wasn't yet in the timeline
    // Don't synthesize RR for m.room.redaction as this causes the RR to go missing.
    if (event.sender && event.getType() !== "m.room.redaction") {
        this.addReceipt(synthesizeReceipt(
            event.sender.userId, event, "m.read",
        ), true);

        // Any live events from a user could be taken as implicit
        // presence information: evidence that they are currently active.
        // ...except in a world where we use 'user.currentlyActive' to reduce
        // presence spam, this isn't very useful - we'll get a transition when
        // they are no longer currently active anyway. So don't bother to
        // reset the lastActiveAgo and lastPresenceTs from the RoomState's user.
    }
};


/**
 * Add a pending outgoing event to this room.
 *
 * <p>The event is added to either the pendingEventList, or the live timeline,
 * depending on the setting of opts.pendingEventOrdering.
 *
 * <p>This is an internal method, intended for use by MatrixClient.
 *
 * @param {module:models/event.MatrixEvent} event The event to add.
 *
 * @param {string} txnId   Transaction id for this outgoing event
 *
 * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
 *
 * @throws if the event doesn't have status SENDING, or we aren't given a
 * unique transaction id.
 */
Room.prototype.addPendingEvent = function(event, txnId) {
    if (event.status !== EventStatus.SENDING) {
        throw new Error("addPendingEvent called on an event with status " +
                        event.status);
    }

    if (this._txnToEvent[txnId]) {
        throw new Error("addPendingEvent called on an event with known txnId " +
                        txnId);
    }

    // call setEventMetadata to set up event.sender etc
    // as event is shared over all timelineSets, we set up its metadata based
    // on the unfiltered timelineSet.
    EventTimeline.setEventMetadata(
        event,
        this.getLiveTimeline().getState(EventTimeline.FORWARDS),
        false,
    );

    this._txnToEvent[txnId] = event;

    if (this._opts.pendingEventOrdering == "detached") {
        if (this._pendingEventList.some((e) => e.status === EventStatus.NOT_SENT)) {
            console.warn("Setting event as NOT_SENT due to messages in the same state");
            event.status = EventStatus.NOT_SENT;
        }
        this._pendingEventList.push(event);
    } else {
        for (let i = 0; i < this._timelineSets.length; i++) {
            const timelineSet = this._timelineSets[i];
            if (timelineSet.getFilter()) {
                if (this._filter.filterRoomTimeline([event]).length) {
                    timelineSet.addEventToTimeline(event,
                        timelineSet.getLiveTimeline(), false);
                }
            } else {
                timelineSet.addEventToTimeline(event,
                    timelineSet.getLiveTimeline(), false);
            }
        }
    }

    this.emit("Room.localEchoUpdated", event, this, null, null);
};

/**
 * Deal with the echo of a message we sent.
 *
 * <p>We move the event to the live timeline if it isn't there already, and
 * update it.
 *
 * @param {module:models/event.MatrixEvent} remoteEvent   The event received from
 *    /sync
 * @param {module:models/event.MatrixEvent} localEvent    The local echo, which
 *    should be either in the _pendingEventList or the timeline.
 *
 * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
 * @private
 */
Room.prototype._handleRemoteEcho = function(remoteEvent, localEvent) {
    const oldEventId = localEvent.getId();
    const newEventId = remoteEvent.getId();
    const oldStatus = localEvent.status;

    // no longer pending
    delete this._txnToEvent[remoteEvent.transaction_id];

    // if it's in the pending list, remove it
    if (this._pendingEventList) {
        utils.removeElement(
            this._pendingEventList,
            function(ev) {
                return ev.getId() == oldEventId;
            }, false,
        );
    }

    // replace the event source (this will preserve the plaintext payload if
    // any, which is good, because we don't want to try decoding it again).
    localEvent.handleRemoteEcho(remoteEvent.event);

    for (let i = 0; i < this._timelineSets.length; i++) {
        const timelineSet = this._timelineSets[i];

        // if it's already in the timeline, update the timeline map. If it's not, add it.
        timelineSet.handleRemoteEcho(localEvent, oldEventId, newEventId);
    }

    this.emit("Room.localEchoUpdated", localEvent, this,
              oldEventId, oldStatus);
};

/* a map from current event status to a list of allowed next statuses
 */
const ALLOWED_TRANSITIONS = {};

ALLOWED_TRANSITIONS[EventStatus.ENCRYPTING] = [
    EventStatus.SENDING,
    EventStatus.NOT_SENT,
];

ALLOWED_TRANSITIONS[EventStatus.SENDING] = [
    EventStatus.ENCRYPTING,
    EventStatus.QUEUED,
    EventStatus.NOT_SENT,
    EventStatus.SENT,
];

ALLOWED_TRANSITIONS[EventStatus.QUEUED] =
    [EventStatus.SENDING, EventStatus.CANCELLED];

ALLOWED_TRANSITIONS[EventStatus.SENT] =
    [];

ALLOWED_TRANSITIONS[EventStatus.NOT_SENT] =
    [EventStatus.SENDING, EventStatus.QUEUED, EventStatus.CANCELLED];

ALLOWED_TRANSITIONS[EventStatus.CANCELLED] =
    [];

/**
 * Update the status / event id on a pending event, to reflect its transmission
 * progress.
 *
 * <p>This is an internal method.
 *
 * @param {MatrixEvent} event      local echo event
 * @param {EventStatus} newStatus  status to assign
 * @param {string} newEventId      new event id to assign. Ignored unless
 *    newStatus == EventStatus.SENT.
 * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
 */
Room.prototype.updatePendingEvent = function(event, newStatus, newEventId) {
    console.log(`setting pendingEvent status to ${newStatus} in ${event.getRoomId()}`);

    // if the message was sent, we expect an event id
    if (newStatus == EventStatus.SENT && !newEventId) {
        throw new Error("updatePendingEvent called with status=SENT, " +
                        "but no new event id");
    }

    // SENT races against /sync, so we have to special-case it.
    if (newStatus == EventStatus.SENT) {
        const timeline = this.getUnfilteredTimelineSet().eventIdToTimeline(newEventId);
        if (timeline) {
            // we've already received the event via the event stream.
            // nothing more to do here.
            return;
        }
    }

    const oldStatus = event.status;
    const oldEventId = event.getId();

    if (!oldStatus) {
        throw new Error("updatePendingEventStatus called on an event which is " +
                        "not a local echo.");
    }

    const allowed = ALLOWED_TRANSITIONS[oldStatus];
    if (!allowed || allowed.indexOf(newStatus) < 0) {
        throw new Error("Invalid EventStatus transition " + oldStatus + "->" +
                        newStatus);
    }

    event.status = newStatus;

    if (newStatus == EventStatus.SENT) {
        // update the event id
        event.event.event_id = newEventId;

        // if the event was already in the timeline (which will be the case if
        // opts.pendingEventOrdering==chronological), we need to update the
        // timeline map.
        for (let i = 0; i < this._timelineSets.length; i++) {
            this._timelineSets[i].replaceEventId(oldEventId, newEventId);
        }
    } else if (newStatus == EventStatus.CANCELLED) {
        // remove it from the pending event list, or the timeline.
        if (this._pendingEventList) {
            utils.removeElement(
                this._pendingEventList,
                function(ev) {
                    return ev.getId() == oldEventId;
                }, false,
            );
        }
        this.removeEvent(oldEventId);
    }

    this.emit("Room.localEchoUpdated", event, this, oldEventId, oldStatus);
};


/**
 * Add some events to this room. This can include state events, message
 * events and typing notifications. These events are treated as "live" so
 * they will go to the end of the timeline.
 *
 * @param {MatrixEvent[]} events A list of events to add.
 *
 * @param {string} duplicateStrategy Optional. Applies to events in the
 * timeline only. If this is 'replace' then if a duplicate is encountered, the
 * event passed to this function will replace the existing event in the
 * timeline. If this is not specified, or is 'ignore', then the event passed to
 * this function will be ignored entirely, preserving the existing event in the
 * timeline. Events are identical based on their event ID <b>only</b>.
 *
 * @throws If <code>duplicateStrategy</code> is not falsey, 'replace' or 'ignore'.
 */
Room.prototype.addLiveEvents = function(events, duplicateStrategy) {
    let i;
    if (duplicateStrategy && ["replace", "ignore"].indexOf(duplicateStrategy) === -1) {
        throw new Error("duplicateStrategy MUST be either 'replace' or 'ignore'");
    }

    // sanity check that the live timeline is still live
    for (i = 0; i < this._timelineSets.length; i++) {
        const liveTimeline = this._timelineSets[i].getLiveTimeline();
        if (liveTimeline.getPaginationToken(EventTimeline.FORWARDS)) {
            throw new Error(
                "live timeline " + i + " is no longer live - it has a pagination token " +
                "(" + liveTimeline.getPaginationToken(EventTimeline.FORWARDS) + ")",
            );
        }
        if (liveTimeline.getNeighbouringTimeline(EventTimeline.FORWARDS)) {
            throw new Error(
                "live timeline " + i + " is no longer live - " +
                "it has a neighbouring timeline",
            );
        }
    }

    for (i = 0; i < events.length; i++) {
        if (events[i].getType() === "m.typing") {
            this.currentState.setTypingEvent(events[i]);
        } else if (events[i].getType() === "m.receipt") {
            this.addReceipt(events[i]);
        }
        // N.B. account_data is added directly by /sync to avoid
        // having to maintain an event.isAccountData() here
        else {
            // TODO: We should have a filter to say "only add state event
            // types X Y Z to the timeline".
            this._addLiveEvent(events[i], duplicateStrategy);
        }
    }
};

/**
 * Removes events from this room.
 * @param {String[]} event_ids A list of event_ids to remove.
 */
Room.prototype.removeEvents = function(event_ids) {
    for (let i = 0; i < event_ids.length; ++i) {
        this.removeEvent(event_ids[i]);
    }
};

/**
 * Removes a single event from this room.
 *
 * @param {String} eventId  The id of the event to remove
 *
 * @return {bool} true if the event was removed from any of the room's timeline sets
 */
Room.prototype.removeEvent = function(eventId) {
    let removedAny = false;
    for (let i = 0; i < this._timelineSets.length; i++) {
        const removed = this._timelineSets[i].removeEvent(eventId);
        if (removed) {
            removedAny = true;
        }
    }
    return removedAny;
};


/**
 * Recalculate various aspects of the room, including the room name and
 * room summary. Call this any time the room's current state is modified.
 * May fire "Room.name" if the room name is updated.
 * @fires module:client~MatrixClient#event:"Room.name"
 */
Room.prototype.recalculate = function() {
    // set fake stripped state events if this is an invite room so logic remains
    // consistent elsewhere.
    const self = this;
    const membershipEvent = this.currentState.getStateEvents(
        "m.room.member", this.myUserId,
    );
    if (membershipEvent && membershipEvent.getContent().membership === "invite") {
        const strippedStateEvents = membershipEvent.event.invite_room_state || [];
        utils.forEach(strippedStateEvents, function(strippedEvent) {
            const existingEvent = self.currentState.getStateEvents(
                strippedEvent.type, strippedEvent.state_key,
            );
            if (!existingEvent) {
                // set the fake stripped event instead
                self.currentState.setStateEvents([new MatrixEvent({
                    type: strippedEvent.type,
                    state_key: strippedEvent.state_key,
                    content: strippedEvent.content,
                    event_id: "$fake" + Date.now(),
                    room_id: self.roomId,
                    user_id: self.myUserId, // technically a lie
                })]);
            }
        });
    }

    const oldName = this.name;
    this.name = calculateRoomName(this, this.myUserId);
    this.summary = new RoomSummary(this.roomId, {
        title: this.name,
    });

    if (oldName !== this.name) {
        this.emit("Room.name", this);
    }
};

/**
 * Get a list of user IDs who have <b>read up to</b> the given event.
 * @param {MatrixEvent} event the event to get read receipts for.
 * @return {String[]} A list of user IDs.
 */
Room.prototype.getUsersReadUpTo = function(event) {
    return this.getReceiptsForEvent(event).filter(function(receipt) {
        return receipt.type === "m.read";
    }).map(function(receipt) {
        return receipt.userId;
    });
};

/**
 * Get the ID of the event that a given user has read up to, or null if we
 * have received no read receipts from them.
 * @param {String} userId The user ID to get read receipt event ID for
 * @param {Boolean} ignoreSynthesized If true, return only receipts that have been
 *                                    sent by the server, not implicit ones generated
 *                                    by the JS SDK.
 * @return {String} ID of the latest event that the given user has read, or null.
 */
Room.prototype.getEventReadUpTo = function(userId, ignoreSynthesized) {
    let receipts = this._receipts;
    if (ignoreSynthesized) {
        receipts = this._realReceipts;
    }

    if (
        receipts["m.read"] === undefined ||
        receipts["m.read"][userId] === undefined
    ) {
        return null;
    }

    return receipts["m.read"][userId].eventId;
};

/**
 * Get a list of receipts for the given event.
 * @param {MatrixEvent} event the event to get receipts for
 * @return {Object[]} A list of receipts with a userId, type and data keys or
 * an empty list.
 */
Room.prototype.getReceiptsForEvent = function(event) {
    return this._receiptCacheByEventId[event.getId()] || [];
};

/**
 * Add a receipt event to the room.
 * @param {MatrixEvent} event The m.receipt event.
 * @param {Boolean} fake True if this event is implicit
 */
Room.prototype.addReceipt = function(event, fake) {
    // event content looks like:
    // content: {
    //   $event_id: {
    //     $receipt_type: {
    //       $user_id: {
    //         ts: $timestamp
    //       }
    //     }
    //   }
    // }
    if (fake === undefined) {
        fake = false;
    }
    if (!fake) {
        this._addReceiptsToStructure(event, this._realReceipts);
        // we don't bother caching real receipts by event ID
        // as there's nothing that would read it.
    }
    this._addReceiptsToStructure(event, this._receipts);
    this._receiptCacheByEventId = this._buildReceiptCache(this._receipts);

    // send events after we've regenerated the cache, otherwise things that
    // listened for the event would read from a stale cache
    this.emit("Room.receipt", event, this);
};

/**
 * Add a receipt event to the room.
 * @param {MatrixEvent} event The m.receipt event.
 * @param {Object} receipts The object to add receipts to
 */
Room.prototype._addReceiptsToStructure = function(event, receipts) {
    const self = this;
    utils.keys(event.getContent()).forEach(function(eventId) {
        utils.keys(event.getContent()[eventId]).forEach(function(receiptType) {
            utils.keys(event.getContent()[eventId][receiptType]).forEach(
            function(userId) {
                const receipt = event.getContent()[eventId][receiptType][userId];

                if (!receipts[receiptType]) {
                    receipts[receiptType] = {};
                }

                const existingReceipt = receipts[receiptType][userId];

                if (!existingReceipt) {
                    receipts[receiptType][userId] = {};
                } else {
                    // we only want to add this receipt if we think it is later
                    // than the one we already have. (This is managed
                    // server-side, but because we synthesize RRs locally we
                    // have to do it here too.)
                    const ordering = self.getUnfilteredTimelineSet().compareEventOrdering(
                        existingReceipt.eventId, eventId);
                    if (ordering !== null && ordering >= 0) {
                        return;
                    }
                }

                receipts[receiptType][userId] = {
                    eventId: eventId,
                    data: receipt,
                };
            });
        });
    });
};

/**
 * Build and return a map of receipts by event ID
 * @param {Object} receipts A map of receipts
 * @return {Object} Map of receipts by event ID
 */
Room.prototype._buildReceiptCache = function(receipts) {
    const receiptCacheByEventId = {};
    utils.keys(receipts).forEach(function(receiptType) {
        utils.keys(receipts[receiptType]).forEach(function(userId) {
            const receipt = receipts[receiptType][userId];
            if (!receiptCacheByEventId[receipt.eventId]) {
                receiptCacheByEventId[receipt.eventId] = [];
            }
            receiptCacheByEventId[receipt.eventId].push({
                userId: userId,
                type: receiptType,
                data: receipt.data,
            });
        });
    });
    return receiptCacheByEventId;
};


/**
 * Add a temporary local-echo receipt to the room to reflect in the
 * client the fact that we've sent one.
 * @param {string} userId The user ID if the receipt sender
 * @param {MatrixEvent} e The event that is to be acknowledged
 * @param {string} receiptType The type of receipt
 */
Room.prototype._addLocalEchoReceipt = function(userId, e, receiptType) {
    this.addReceipt(synthesizeReceipt(userId, e, receiptType), true);
};

/**
 * Update the room-tag event for the room.  The previous one is overwritten.
 * @param {MatrixEvent} event the m.tag event
 */
Room.prototype.addTags = function(event) {
    // event content looks like:
    // content: {
    //    tags: {
    //       $tagName: { $metadata: $value },
    //       $tagName: { $metadata: $value },
    //    }
    // }

    // XXX: do we need to deep copy here?
    this.tags = event.getContent().tags || {};

    // XXX: we could do a deep-comparison to see if the tags have really
    // changed - but do we want to bother?
    this.emit("Room.tags", event, this);
};

/**
 * Update the account_data events for this room, overwriting events of the same type.
 * @param {Array<MatrixEvent>} events an array of account_data events to add
 */
Room.prototype.addAccountData = function(events) {
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.getType() === "m.tag") {
            this.addTags(event);
        }
        this.accountData[event.getType()] = event;
        this.emit("Room.accountData", event, this);
    }
};

/**
 * Access account_data event of given event type for this room
 * @param {string} type the type of account_data event to be accessed
 * @return {?MatrixEvent} the account_data event in question
 */
Room.prototype.getAccountData = function(type) {
    return this.accountData[type];
};


/**
 * Returns wheter the syncing user has permission to send a message in the room
 * @return {boolean} true if the user should be permitted to send
 *                   message events into the room.
 */
Room.prototype.maySendMessage = function() {
    return this.getMyMembership() === 'join' &&
        this.currentState.maySendEvent('m.room.message', this.myUserId);
};

/**
 * This is an internal method. Calculates the name of the room from the current
 * room state.
 * @param {Room} room The matrix room.
 * @param {string} userId The client's user ID. Used to filter room members
 * correctly.
 * @param {bool} ignoreRoomNameEvent Return the implicit room name that we'd see if there
 * was no m.room.name event.
 * @return {string} The calculated room name.
 */
function calculateRoomName(room, userId, ignoreRoomNameEvent) {
    if (!ignoreRoomNameEvent) {
        // check for an alias, if any. for now, assume first alias is the
        // official one.
        const mRoomName = room.currentState.getStateEvents("m.room.name", "");
        if (mRoomName && mRoomName.getContent() && mRoomName.getContent().name) {
            return mRoomName.getContent().name;
        }
    }

    let alias = room.getCanonicalAlias();

    if (!alias) {
        const aliases = room.getAliases();

        if (aliases.length) {
            alias = aliases[0];
        }
    }
    if (alias) {
        return alias;
    }

    const joinedMemberCount = room.currentState.getJoinedMemberCount();
    const invitedMemberCount = room.currentState.getInvitedMemberCount();
    // -1 because these numbers include the syncing user
    const inviteJoinCount = joinedMemberCount + invitedMemberCount - 1;

    // get members that are NOT ourselves and are actually in the room.
    let otherNames = null;
    if (room._summaryHeroes) {
        // if we have a summary, the member state events
        // should be in the room state
        otherNames = room._summaryHeroes.map((userId) => {
            const member = room.getMember(userId);
            return member ? member.name : userId;
        });
    } else {
        let otherMembers = room.currentState.getMembers().filter((m) => {
            return m.userId !== userId &&
                (m.membership === "invite" || m.membership === "join");
        });
        // make sure members have stable order
        otherMembers.sort((a, b) => a.userId.localeCompare(b.userId));
        // only 5 first members, immitate _summaryHeroes
        otherMembers = otherMembers.slice(0, 5);
        otherNames = otherMembers.map((m) => m.name);
    }

    if (inviteJoinCount) {
        return memberNamesToRoomName(otherNames, inviteJoinCount);
    }

    const myMembership = room.getMyMembership();
    // if I have created a room and invited people throuh
    // 3rd party invites
    if (myMembership == 'join') {
        const thirdPartyInvites =
            room.currentState.getStateEvents("m.room.third_party_invite");

        if (thirdPartyInvites && thirdPartyInvites.length) {
            const thirdPartyNames = thirdPartyInvites.map((i) => {
                return i.getContent().display_name;
            });

            return `Inviting ${memberNamesToRoomName(thirdPartyNames)}`;
        }
    }
    // let's try to figure out who was here before
    let leftNames = otherNames;
    // if we didn't have heroes, try finding them in the room state
    if(!leftNames.length) {
        leftNames = room.currentState.getMembers().filter((m) => {
            return m.userId !== userId &&
                m.membership !== "invite" &&
                m.membership !== "join";
        }).map((m) => m.name);
    }
    if(leftNames.length) {
        return `Empty room (was ${memberNamesToRoomName(leftNames)})`;
    } else {
        return "Empty room";
    }
}

function memberNamesToRoomName(names, count = (names.length + 1)) {
    const countWithoutMe = count - 1;
    if (!names.length) {
       return "Empty room";
    } else if (names.length === 1 && countWithoutMe <= 1) {
        return names[0];
    } else if (names.length === 2 && countWithoutMe <= 2) {
        return `${names[0]} and ${names[1]}`;
    } else {
        const plural = countWithoutMe > 1;
        if (plural) {
            return `${names[0]} and ${countWithoutMe} others`;
        } else {
            return `${names[0]} and 1 other`;
        }
    }
}

/**
 * The Room class.
 */
module.exports = Room;

/**
 * Fires when an event we had previously received is redacted.
 *
 * (Note this is *not* fired when the redaction happens before we receive the
 * event).
 *
 * @event module:client~MatrixClient#"Room.redaction"
 * @param {MatrixEvent} event The matrix event which was redacted
 * @param {Room} room The room containing the redacted event
 */

/**
 * Fires whenever the name of a room is updated.
 * @event module:client~MatrixClient#"Room.name"
 * @param {Room} room The room whose Room.name was updated.
 * @example
 * matrixClient.on("Room.name", function(room){
 *   var newName = room.name;
 * });
 */

/**
 * Fires whenever a receipt is received for a room
 * @event module:client~MatrixClient#"Room.receipt"
 * @param {event} event The receipt event
 * @param {Room} room The room whose receipts was updated.
 * @example
 * matrixClient.on("Room.receipt", function(event, room){
 *   var receiptContent = event.getContent();
 * });
 */

/**
 * Fires whenever a room's tags are updated.
 * @event module:client~MatrixClient#"Room.tags"
 * @param {event} event The tags event
 * @param {Room} room The room whose Room.tags was updated.
 * @example
 * matrixClient.on("Room.tags", function(event, room){
 *   var newTags = event.getContent().tags;
 *   if (newTags["favourite"]) showStar(room);
 * });
 */

/**
 * Fires whenever a room's account_data is updated.
 * @event module:client~MatrixClient#"Room.accountData"
 * @param {event} event The account_data event
 * @param {Room} room The room whose account_data was updated.
 * @example
 * matrixClient.on("Room.accountData", function(event, room){
 *   if (event.getType() === "m.room.colorscheme") {
 *       applyColorScheme(event.getContents());
 *   }
 * });
 */

/**
 * Fires when the status of a transmitted event is updated.
 *
 * <p>When an event is first transmitted, a temporary copy of the event is
 * inserted into the timeline, with a temporary event id, and a status of
 * 'SENDING'.
 *
 * <p>Once the echo comes back from the server, the content of the event
 * (MatrixEvent.event) is replaced by the complete event from the homeserver,
 * thus updating its event id, as well as server-generated fields such as the
 * timestamp. Its status is set to null.
 *
 * <p>Once the /send request completes, if the remote echo has not already
 * arrived, the event is updated with a new event id and the status is set to
 * 'SENT'. The server-generated fields are of course not updated yet.
 *
 * <p>If the /send fails, In this case, the event's status is set to
 * 'NOT_SENT'. If it is later resent, the process starts again, setting the
 * status to 'SENDING'. Alternatively, the message may be cancelled, which
 * removes the event from the room, and sets the status to 'CANCELLED'.
 *
 * <p>This event is raised to reflect each of the transitions above.
 *
 * @event module:client~MatrixClient#"Room.localEchoUpdated"
 *
 * @param {MatrixEvent} event The matrix event which has been updated
 *
 * @param {Room} room The room containing the redacted event
 *
 * @param {string} oldEventId The previous event id (the temporary event id,
 *    except when updating a successfully-sent event when its echo arrives)
 *
 * @param {EventStatus} oldStatus The previous event status.
 */
