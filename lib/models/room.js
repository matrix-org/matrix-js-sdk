"use strict";
/**
 * @module models/room
 */
var EventEmitter = require("events").EventEmitter;

var RoomState = require("./room-state");
var RoomSummary = require("./room-summary");
var MatrixEvent = require("./event").MatrixEvent;
var utils = require("../utils");
var ContentRepo = require("../content-repo");

/**
 * Construct a new Room.
 * @constructor
 * @param {string} roomId Required. The ID of this room.
 * @param {*} storageToken Optional. The token which a data store can use
 * to remember the state of the room. What this means is dependent on the store
 * implementation.
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The ordered list of message events for
 * this room.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the timeline.
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline.
 * @prop {RoomSummary} summary The room summary.
 * @prop {*} storageToken A token which a data store can use to remember
 * the state of the room.
 */
function Room(roomId, storageToken) {
    this.roomId = roomId;
    this.name = roomId;
    this.timeline = [];
    this.oldState = new RoomState(roomId);
    this.currentState = new RoomState(roomId);
    this.summary = null;
    this.storageToken = storageToken;
    this._redactions = [];
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
}
utils.inherits(Room, EventEmitter);

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
 * Check if the given user_id has the given membership state.
 * @param {string} userId The user ID to check.
 * @param {string} membership The membership e.g. <code>'join'</code>
 * @return {boolean} True if this user_id has the given membership state.
 */
 Room.prototype.hasMembershipState = function(userId, membership) {
    return utils.filter(this.currentState.getMembers(), function(m) {
        return m.membership === membership && m.userId === userId;
    }).length > 0;
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

    for (var i = 0; i < events.length; i++) {
        if (toStartOfTimeline && this._redactions.indexOf(events[i].getId()) >= 0) {
            continue; // do not add the redacted event.
        }

        setEventMetadata(events[i], stateContext, toStartOfTimeline);
        // modify state
        if (events[i].isState()) {
            stateContext.setStateEvents([events[i]]);
            // it is possible that the act of setting the state event means we
            // can set more metadata (specifically sender/target props), so try
            // it again if the prop wasn't previously set.
            if (!events[i].sender) {
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
            this.timeline.push(events[i]);
        }

        // synthesize and inject implicit read receipts
        // Done after adding the event because otherwise the app would get a read receipt
        // pointing to an event that wasn't yet in the timeline

        // This is really ugly because JS has no way to express an object literal
        // where the name of a key comes from an expression
        if (!toStartOfTimeline && events[i].sender) {
            this.addReceipt(new MatrixEvent(this._synthesizeReceipt(
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

            var userId = receipt.userId;
            if (usersFound[userId]) { continue; }

            // Then this is the receipt we keep for this user
            usersFound[userId] = 1;
        }

        if (e.sender && usersFound[e.sender.userId] === undefined) {
            // no receipt yet for this sender, so we synthesize one.

            this.addReceipt(this._synthesizeReceipt(e.sender.userId, e, "m.read"));

            usersFound[e.sender.userId] = 1;
        }
    }
};

Room.prototype._synthesizeReceipt = function(userId, event, receiptType) {
    // This is really ugly because JS has no way to express an object literal
    // where the name of a key comes from an expression
    var fakeReceipt = {content: {}};
    fakeReceipt.content[event.getId()] = {};
    fakeReceipt.content[event.getId()][receiptType] = {};
    fakeReceipt.content[event.getId()][receiptType][userId] = {
        ts: event
    };
    return new MatrixEvent(fakeReceipt);
}


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
 * @return {string} The calculated room name.
 */
function calculateRoomName(room, userId) {
    // check for an alias, if any. for now, assume first alias is the
    // official one.
    var mRoomName = room.currentState.getStateEvents("m.room.name", "");
    if (mRoomName && mRoomName.getContent() && mRoomName.getContent().name) {
        return mRoomName.getContent().name;
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
            // we exist, but no one else... self-chat or invite.
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
                return userId;
            }
        }
        else {
            // there really isn't anyone in this room...
            return "?";
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
