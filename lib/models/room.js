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
/**
 * @module models/room
 */
var EventEmitter = require("events").EventEmitter;

var EventStatus = require("./event").EventStatus;
var RoomState = require("./room-state");
var RoomSummary = require("./room-summary");
var MatrixEvent = require("./event").MatrixEvent;
var utils = require("../utils");
var ContentRepo = require("../content-repo");

function synthesizeReceipt(userId, event, receiptType) {
    // This is really ugly because JS has no way to express an object literal
    // where the name of a key comes from an expression
    var fakeReceipt = {
        content: {},
        type: "m.receipt",
        room_id: event.getRoomId()
    };
    fakeReceipt.content[event.getId()] = {};
    fakeReceipt.content[event.getId()][receiptType] = {};
    fakeReceipt.content[event.getId()][receiptType][userId] = {
        ts: event.getTs()
    };
    return new MatrixEvent(fakeReceipt);
}


/**
 * Construct a new Room.
 * @constructor
 * @param {string} roomId Required. The ID of this room.
 * @param {Object=} opts Configuration options
 * @param {*} opts.storageToken Optional. The token which a data store can use
 * to remember the state of the room. What this means is dependent on the store
 * implementation.
 * @param {String=} opts.pendingEventOrdering Controls where pending messages appear
 * in a room's timeline. If "<b>chronological</b>", messages will appear in the timeline
 * when the call to <code>sendEvent</code> was made. If "<b>end</b>", pending messages
 * will always appear at the end of the timeline (multiple pending messages will be sorted
 * chronologically). Default: "chronological".
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The ordered list of message events for
 * this room, with the oldest event at index 0.
 * @prop {object} tags Dict of room tags; the keys are the tag name and the values
 * are any metadata associated with the tag - e.g. { "fav" : { order: 1 } }
 * @prop {object} accountData Dict of per-room account_data events; the keys are the
 * event type and the values are the events.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the timeline.
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline.
 * @prop {RoomSummary} summary The room summary.
 * @prop {*} storageToken A token which a data store can use to remember
 * the state of the room.
 */
function Room(roomId, opts) {
    opts = opts || {};
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";

    if (["chronological", "end"].indexOf(opts.pendingEventOrdering) === -1) {
        throw new Error(
            "opts.pendingEventOrdering MUST be either 'chronological' or " +
            "'end'. Got: '" + opts.pendingEventOrdering + "'"
        );
    }

    this.roomId = roomId;
    this.name = roomId;
    this.timeline = [];
    this.tags = {
        // $tagName: { $metadata: $value },
        // $tagName: { $metadata: $value },
    };
    this.accountData = {
        // $eventType: $event
    };
    this.oldState = new RoomState(roomId);
    this.currentState = new RoomState(roomId);
    this.summary = null;
    this.storageToken = opts.storageToken;
    this._opts = opts;
    this._redactions = [];
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
    this._notificationCounts = {};
}
utils.inherits(Room, EventEmitter);

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
 * @param {Number} type The new count
 */
Room.prototype.setUnreadNotificationCount = function(type, count) {
    this._notificationCounts[type] = count;
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
    var roomAvatarEvent = this.currentState.getStateEvents("m.room.avatar", "");
    if (allowDefault === undefined) { allowDefault = true; }
    if (!roomAvatarEvent && !allowDefault) {
        return null;
    }

    var mainUrl = roomAvatarEvent ? roomAvatarEvent.getContent().url : null;
    if (mainUrl) {
        return ContentRepo.getHttpUriForMxc(
            baseUrl, mainUrl, width, height, resizeMethod
        );
    }
    else if (allowDefault) {
        return ContentRepo.getIdenticonUri(
            baseUrl, this.roomId, width, height
        );
    }

    return null;
};

/**
 * Get a member from the current room state.
 * @param {string} userId The user ID of the member.
 * @return {RoomMember} The member or <code>null</code>.
 */
 Room.prototype.getMember = function(userId) {
    var member = this.currentState.members[userId];
    if (!member) {
        return null;
    }
    return member;
 };

/**
 * Get a list of members whose membership state is "join".
 * @return {RoomMember[]} A list of currently joined members.
 */
 Room.prototype.getJoinedMembers = function() {
    return this.getMembersWithMembership("join");
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
    var member = this.getMember(userId);
    if (!member) {
        return false;
    }
    return member.membership === membership;
 };

/**
 * Add some events to this room's timeline. Will fire "Room.timeline" for
 * each event added.
 * @param {MatrixEvent[]} events A list of events to add.
 * @param {boolean} toStartOfTimeline True to add these events to the start
 * (oldest) instead of the end (newest) of the timeline. If true, the oldest
 * event will be the <b>last</b> element of 'events'.
 * @fires module:client~MatrixClient#event:"Room.timeline"
 */
Room.prototype.addEventsToTimeline = function(events, toStartOfTimeline) {
    var stateContext = toStartOfTimeline ? this.oldState : this.currentState;

    function checkForRedaction(redactEvent) {
        return function(e) {
            return e.getId() === redactEvent.event.redacts;
        };
    }

    var addLocalEchoToEnd = this._opts.pendingEventOrdering === "end";

    for (var i = 0; i < events.length; i++) {
        if (toStartOfTimeline && this._redactions.indexOf(events[i].getId()) >= 0) {
            continue; // do not add the redacted event.
        }
        var isLocalEcho = (
            !Boolean(toStartOfTimeline) && (
                events[i].status === EventStatus.SENDING ||
                events[i].status === EventStatus.QUEUED
            )
        );

        // FIXME: HORRIBLE ASSUMPTION THAT THIS PROP EXISTS
        // Exists due to client.js:815 (MatrixClient.sendEvent)
        // We should make txnId a first class citizen.
        if (!toStartOfTimeline && events[i]._txnId) {
            this._txnToEvent[events[i]._txnId] = events[i];
        }
        else if (!toStartOfTimeline && events[i].getUnsigned().transaction_id) {
            var existingEvent = this._txnToEvent[events[i].getUnsigned().transaction_id];
            if (existingEvent) {
                // no longer pending
                delete this._txnToEvent[events[i].getUnsigned().transaction_id];
                // replace the event source
                existingEvent.event = events[i].event;
                continue;
            }
        }

        setEventMetadata(events[i], stateContext, toStartOfTimeline);
        // modify state
        if (events[i].isState()) {
            stateContext.setStateEvents([events[i]]);
            // it is possible that the act of setting the state event means we
            // can set more metadata (specifically sender/target props), so try
            // it again if the prop wasn't previously set. It may also mean that
            // the sender/target is updated (if the event set was a room member event)
            // so we want to use the *updated* member (new avatar/name) instead.
            if (!events[i].sender || events[i].getType() === "m.room.member") {
                setEventMetadata(events[i], stateContext, toStartOfTimeline);
            }
        }
        if (events[i].getType() === "m.room.redaction") {
            // try to remove the element
            var removed = utils.removeElement(
                this.timeline, checkForRedaction(events[i])
            );
            if (!removed && toStartOfTimeline) {
                // redactions will trickle in BEFORE the event redacted so make
                // a note of the redacted event; we'll check it later.
                this._redactions.push(events[i].event.redacts);
            }
            // NB: We continue to add the redaction event to the timeline so clients
            // can say "so and so redacted an event" if they wish to.
        }

        // TODO: pass through filter to see if this should be added to the timeline.
        if (toStartOfTimeline) {
            this.timeline.unshift(events[i]);
        }
        else {
            // everything gets added to the end by default. What we actually want to
            // do in this scenario is *NOT* add REAL events to the end if there are
            // existing local echo events at the end.
            if (addLocalEchoToEnd && !isLocalEcho) {
                var insertIndex = this.timeline.length;
                for (var j = this.timeline.length - 1; j >= 0; j--) {
                    if (!this.timeline[j].status) { // real events don't have a status
                        insertIndex = j + 1;
                        break;
                    }
                }
                this.timeline.splice(insertIndex, 0, events[i]); // insert element
            }
            else {
                this.timeline.push(events[i]);
            }
        }

        // synthesize and inject implicit read receipts
        // Done after adding the event because otherwise the app would get a read receipt
        // pointing to an event that wasn't yet in the timeline

        // This is really ugly because JS has no way to express an object literal
        // where the name of a key comes from an expression
        if (!toStartOfTimeline && events[i].sender) {
            this.addReceipt(new MatrixEvent(synthesizeReceipt(
                events[i].sender.userId, events[i], "m.read"
            )));
        }

        this.emit("Room.timeline", events[i], this, Boolean(toStartOfTimeline), false);
    }
};

/**
 * Add some events to this room. This can include state events, message
 * events and typing notifications. These events are treated as "live" so
 * they will go to the end of the timeline.
 * @param {MatrixEvent[]} events A list of events to add.
 * @param {string} duplicateStrategy Optional. Applies to events in the
 * timeline only. If this is not specified, no duplicate suppression is
 * performed (this improves performance). If this is 'replace' then if a
 * duplicate is encountered, the event passed to this function will replace the
 * existing event in the timeline. If this is 'ignore', then the event passed to
 * this function will be ignored entirely, preserving the existing event in the
 * timeline. Events are identical based on their event ID <b>only</b>.
 * @throws If <code>duplicateStrategy</code> is not falsey, 'replace' or 'ignore'.
 */
Room.prototype.addEvents = function(events, duplicateStrategy) {
    if (duplicateStrategy && ["replace", "ignore"].indexOf(duplicateStrategy) === -1) {
        throw new Error("duplicateStrategy MUST be either 'replace' or 'ignore'");
    }
    for (var i = 0; i < events.length; i++) {
        if (events[i].getType() === "m.typing") {
            this.currentState.setTypingEvent(events[i]);
        }
        else if (events[i].getType() === "m.receipt") {
            this.addReceipt(events[i]);
        }
        // N.B. account_data is added directly by /sync to avoid
        // having to maintain an event.isAccountData() here
        else {
            if (duplicateStrategy) {
                // is there a duplicate?
                var shouldIgnore = false;
                for (var j = 0; j < this.timeline.length; j++) {
                    if (this.timeline[j].getId() === events[i].getId()) {
                        if (duplicateStrategy === "replace") {
                            // still need to set the right metadata on this event
                            setEventMetadata(
                                events[i],
                                this.currentState,
                                false
                            );
                            if (!this.timeline[j].encryptedType) {
                                this.timeline[j] = events[i];
                            }
                            // skip the insert so we don't add this event twice.
                            // Don't break in case we replace multiple events.
                            shouldIgnore = true;
                        }
                        else if (duplicateStrategy === "ignore") {
                            shouldIgnore = true;
                            break; // stop searching, we're skipping the insert
                        }
                    }
                }
                if (shouldIgnore) {
                    continue; // skip the insertion of this event.
                }
            }
            // TODO: We should have a filter to say "only add state event
            // types X Y Z to the timeline".
            this.addEventsToTimeline([events[i]]);
        }
    }
};

/**
 * Removes events from this room.
 * @param {String} event_ids A list of event_ids to remove.
 */
Room.prototype.removeEvents = function(event_ids) {
    // avoids defining a function in the loop, which is a lint error
    function removeEventWithId(timeline, id) {
        // NB. we supply reverse to search from the end,
        // on the assumption that recents events are much
        // more likley to be removed than older ones.
        return utils.removeElement(timeline, function(e) {
            return e.getId() == id;
        }, true);
    }

    for (var i = 0; i < event_ids.length; ++i) {
        var removed = removeEventWithId(this.timeline, event_ids[i]);
        if (removed) {
            this.emit("Room.timeline", removed, this, undefined, true);
        }
    }
};

/**
 * Recalculate various aspects of the room, including the room name and
 * room summary. Call this any time the room's current state is modified.
 * May fire "Room.name" if the room name is updated.
 * @param {string} userId The client's user ID.
 * @fires module:client~MatrixClient#event:"Room.name"
 */
Room.prototype.recalculate = function(userId) {
    // set fake stripped state events if this is an invite room so logic remains
    // consistent elsewhere.
    var self = this;
    var membershipEvent = this.currentState.getStateEvents(
        "m.room.member", userId
    );
    if (membershipEvent && membershipEvent.getContent().membership === "invite") {
        var strippedStateEvents = membershipEvent.event.invite_room_state || [];
        utils.forEach(strippedStateEvents, function(strippedEvent) {
            var existingEvent = self.currentState.getStateEvents(
                strippedEvent.type, strippedEvent.state_key
            );
            if (!existingEvent) {
                // set the fake stripped event instead
                self.currentState.setStateEvents([new MatrixEvent({
                    type: strippedEvent.type,
                    state_key: strippedEvent.state_key,
                    content: strippedEvent.content,
                    event_id: "$fake" + Date.now(),
                    room_id: self.roomId,
                    user_id: userId // technically a lie
                })]);
            }
        });
    }



    var oldName = this.name;
    this.name = calculateRoomName(this, userId);
    this.summary = new RoomSummary(this.roomId, {
        title: this.name
    });

    if (oldName !== this.name) {
        this.emit("Room.name", this);
    }



    // recalculate read receipts, adding implicit ones where necessary
    // NB. This is a duplication of logic for injecting implicit receipts,
    // it would be technically possible to only ever generate these
    // receipts in addEventsToTimeline but doing so means correctly
    // choosing whether to keep or replace the existing receipt which
    // is complex and slow. This is faster and more understandable.

    var usersFound = {};
    for (var i = this.timeline.length - 1; i >= 0; --i) {
        // loop through the timeline backwards looking for either an
        // event sent by each user or a real receipt from them.
        // Replace the read receipt for that user with whichever
        // occurs later in the timeline (ie. first because we're going
        // backwards).
        var e = this.timeline[i];

        var readReceiptsForEvent = this.getReceiptsForEvent(e);

        for (var receiptIt = 0; receiptIt < readReceiptsForEvent.length; ++receiptIt) {
            var receipt = readReceiptsForEvent[receiptIt];
            if (receipt.type !== "m.read") { continue; }

            if (usersFound[receipt.userId]) { continue; }

            // Then this is the receipt we keep for this user
            usersFound[receipt.userId] = 1;
        }

        if (e.sender && usersFound[e.sender.userId] === undefined) {
            // no receipt yet for this sender, so we synthesize one.

            this.addReceipt(synthesizeReceipt(e.sender.userId, e, "m.read"));

            usersFound[e.sender.userId] = 1;
        }
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
 * @return {String} ID of the latest event that the given user has read, or null.
 */
Room.prototype.getEventReadUpTo = function(userId) {
    if (
        this._receipts["m.read"] === undefined ||
        this._receipts["m.read"][userId] === undefined
    ) {
        return null;
    }

    return this._receipts["m.read"][userId].eventId;
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
 */
Room.prototype.addReceipt = function(event) {
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
    var self = this;
    utils.keys(event.getContent()).forEach(function(eventId) {
        utils.keys(event.getContent()[eventId]).forEach(function(receiptType) {
            utils.keys(event.getContent()[eventId][receiptType]).forEach(
            function(userId) {
                var receipt = event.getContent()[eventId][receiptType][userId];
                if (!self._receipts[receiptType]) {
                    self._receipts[receiptType] = {};
                }
                if (!self._receipts[receiptType][userId]) {
                    self._receipts[receiptType][userId] = {};
                }
                self._receipts[receiptType][userId] = {
                    eventId: eventId,
                    data: receipt
                };
            });
        });
    });

    // pre-cache receipts by event
    self._receiptCacheByEventId = {};
    utils.keys(self._receipts).forEach(function(receiptType) {
        utils.keys(self._receipts[receiptType]).forEach(function(userId) {
            var receipt = self._receipts[receiptType][userId];
            if (!self._receiptCacheByEventId[receipt.eventId]) {
                self._receiptCacheByEventId[receipt.eventId] = [];
            }
            self._receiptCacheByEventId[receipt.eventId].push({
                userId: userId,
                type: receiptType,
                data: receipt.data
            });
        });
    });

    // send events after we've regenerated the cache, otherwise things that
    // listened for the event would read from a stale cache
    this.emit("Room.receipt", event, this);
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
    this.tags = event.getContent().tags;

    // XXX: we could do a deep-comparison to see if the tags have really
    // changed - but do we want to bother?
    this.emit("Room.tags", event, this);
};

/**
 * Update the account_data events for this room, overwriting events of the same type.
 * @param {Array<MatrixEvent>} events an array of account_data events to add
 */
Room.prototype.addAccountData = function(events) {
    for (var i = 0; i < events.length; i++) {
        var event = events[i];
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

function setEventMetadata(event, stateContext, toStartOfTimeline) {
    // set sender and target properties
    event.sender = stateContext.getSentinelMember(
        event.getSender()
    );
    if (event.getType() === "m.room.member") {
        event.target = stateContext.getSentinelMember(
            event.getStateKey()
        );
    }
    if (event.isState()) {
        // room state has no concept of 'old' or 'current', but we want the
        // room state to regress back to previous values if toStartOfTimeline
        // is set, which means inspecting prev_content if it exists. This
        // is done by toggling the forwardLooking flag.
        if (toStartOfTimeline) {
            event.forwardLooking = false;
        }
    }
}

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
        var mRoomName = room.currentState.getStateEvents("m.room.name", "");
        if (mRoomName && mRoomName.getContent() && mRoomName.getContent().name) {
            return mRoomName.getContent().name;
        }
    }

    var alias;
    var canonicalAlias = room.currentState.getStateEvents("m.room.canonical_alias", "");
    if (canonicalAlias) {
        alias = canonicalAlias.getContent().alias;
    }

    if (!alias) {
        var mRoomAliases = room.currentState.getStateEvents("m.room.aliases")[0];
        if (mRoomAliases && utils.isArray(mRoomAliases.getContent().aliases)) {
            alias = mRoomAliases.getContent().aliases[0];
        }
    }
    if (alias) {
        return alias;
    }

    // get members that are NOT ourselves and are actually in the room.
    var members = utils.filter(room.currentState.getMembers(), function(m) {
        return (m.userId !== userId && m.membership !== "leave");
    });
    // TODO: Localisation
    if (members.length === 0) {
        var memberList = utils.filter(room.currentState.getMembers(), function(m) {
            return (m.membership !== "leave");
        });
        if (memberList.length === 1) {
            // self-chat, peeked room with 1 participant, or invite.
            if (memberList[0].membership === "invite") {
                if (memberList[0].events.member) {
                    // extract who invited us to the room
                    return "Invite from " + memberList[0].events.member.getSender();
                }
                else {
                    return "Room Invite";
                }
            }
            else {
                if (memberList[0].userId === userId) {
                    return "Empty room";
                }
                else {
                    return memberList[0].name;
                }
            }
        }
        else {
            // there really isn't anyone in this room...
            return "Empty room";
        }
    }
    else if (members.length === 1) {
        return members[0].name;
    }
    else if (members.length === 2) {
        return (
            members[0].name + " and " + members[1].name
        );
    }
    else {
        return (
            members[0].name + " and " + (members.length - 1) + " others"
        );
    }
}

/**
 * The Room class.
 */
module.exports = Room;

/**
 * Fires whenever the timeline in a room is updated.
 * @event module:client~MatrixClient#"Room.timeline"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {Room} room The room whose Room.timeline was updated.
 * @param {boolean} toStartOfTimeline True if this event was added to the start
 * @param {boolean} removed True if this event has just been removed from the timeline
 * (beginning; oldest) of the timeline e.g. due to pagination.
 * @example
 * matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline){
 *   if (toStartOfTimeline) {
 *     var messageToAppend = room.timeline[room.timeline.length - 1];
 *   }
 * });
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
