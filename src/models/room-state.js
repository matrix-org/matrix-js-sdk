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
 * @module models/room-state
 */
var EventEmitter = require("events").EventEmitter;

var utils = require("../utils");
var RoomMember = require("./room-member");

/**
 * Construct room state.
 * @constructor
 * @param {?string} roomId Optional. The ID of the room which has this state.
 * If none is specified it just tracks paginationTokens, useful for notifTimelineSet
 * @prop {Object.<string, RoomMember>} members The room member dictionary, keyed
 * on the user's ID.
 * @prop {Object.<string, Object.<string, MatrixEvent>>} events The state
 * events dictionary, keyed on the event type and then the state_key value.
 * @prop {string} paginationToken The pagination token for this state.
 */
function RoomState(roomId) {
    this.roomId = roomId;
    this.members = {
        // userId: RoomMember
    };
    this.events = {
        // eventType: { stateKey: MatrixEvent }
    };
    this.paginationToken = null;

    this._sentinels = {
        // userId: RoomMember
    };
    this._updateModifiedTime();
    this._displayNameToUserIds = {};
    this._userIdsToDisplayNames = {};
    this._tokenToInvite = {}; // 3pid invite state_key to m.room.member invite
}
utils.inherits(RoomState, EventEmitter);

/**
 * Get all RoomMembers in this room.
 * @return {Array<RoomMember>} A list of RoomMembers.
 */
RoomState.prototype.getMembers = function() {
    return utils.values(this.members);
};

/**
 * Get a room member by their user ID.
 * @param {string} userId The room member's user ID.
 * @return {RoomMember} The member or null if they do not exist.
 */
RoomState.prototype.getMember = function(userId) {
    return this.members[userId] || null;
};

/**
 * Get a room member whose properties will not change with this room state. You
 * typically want this if you want to attach a RoomMember to a MatrixEvent which
 * may no longer be represented correctly by Room.currentState or Room.oldState.
 * The term 'sentinel' refers to the fact that this RoomMember is an unchanging
 * guardian for state at this particular point in time.
 * @param {string} userId The room member's user ID.
 * @return {RoomMember} The member or null if they do not exist.
 */
RoomState.prototype.getSentinelMember = function(userId) {
    return this._sentinels[userId] || null;
};

/**
 * Get state events from the state of the room.
 * @param {string} eventType The event type of the state event.
 * @param {string} stateKey Optional. The state_key of the state event. If
 * this is <code>undefined</code> then all matching state events will be
 * returned.
 * @return {MatrixEvent[]|MatrixEvent} A list of events if state_key was
 * <code>undefined</code>, else a single event (or null if no match found).
 */
RoomState.prototype.getStateEvents = function(eventType, stateKey) {
    if (!this.events[eventType]) {
        // no match
        return stateKey === undefined ? [] : null;
    }
    if (stateKey === undefined) { // return all values
        return utils.values(this.events[eventType]);
    }
    var event = this.events[eventType][stateKey];
    return event ? event : null;
};

/**
 * Add an array of one or more state MatrixEvents, overwriting
 * any existing state with the same {type, stateKey} tuple. Will fire
 * "RoomState.events" for every event added. May fire "RoomState.members"
 * if there are <code>m.room.member</code> events.
 * @param {MatrixEvent[]} stateEvents a list of state events for this room.
 * @fires module:client~MatrixClient#event:"RoomState.members"
 * @fires module:client~MatrixClient#event:"RoomState.newMember"
 * @fires module:client~MatrixClient#event:"RoomState.events"
 */
RoomState.prototype.setStateEvents = function(stateEvents) {
    var self = this;
    this._updateModifiedTime();

    // update the core event dict
    utils.forEach(stateEvents, function(event) {
        if (event.getRoomId() !== self.roomId) { return; }
        if (!event.isState()) { return; }

        if (self.events[event.getType()] === undefined) {
            self.events[event.getType()] = {};
        }
        self.events[event.getType()][event.getStateKey()] = event;
        if (event.getType() === "m.room.member") {
            _updateDisplayNameCache(
                self, event.getStateKey(), event.getContent().displayname
            );
            _updateThirdPartyTokenCache(self, event);
        }
        self.emit("RoomState.events", event, self);
    });

    // update higher level data structures. This needs to be done AFTER the
    // core event dict as these structures may depend on other state events in
    // the given array (e.g. disambiguating display names in one go to do both
    // clashing names rather than progressively which only catches 1 of them).
    utils.forEach(stateEvents, function(event) {
        if (event.getRoomId() !== self.roomId) { return; }
        if (!event.isState()) { return; }

        if (event.getType() === "m.room.member") {
            var userId = event.getStateKey();

            // leave events apparently elide the displayname or avatar_url,
            // so let's fake one up so that we don't leak user ids
            // into the timeline
            if (event.getContent().membership === "leave" ||
                event.getContent().membership === "ban")
            {
                event.getContent().avatar_url =
                    event.getContent().avatar_url ||
                    event.getPrevContent().avatar_url;
                event.getContent().displayname =
                    event.getContent().displayname ||
                    event.getPrevContent().displayname;
            }

            var member = self.members[userId];
            if (!member) {
                member = new RoomMember(event.getRoomId(), userId);
                self.emit("RoomState.newMember", event, self, member);
            }
            // Add a new sentinel for this change. We apply the same
            // operations to both sentinel and member rather than deep copying
            // so we don't make assumptions about the properties of RoomMember
            // (e.g. and manage to break it because deep copying doesn't do
            // everything).
            var sentinel = new RoomMember(event.getRoomId(), userId);
            utils.forEach([member, sentinel], function(roomMember) {
                roomMember.setMembershipEvent(event, self);
                // this member may have a power level already, so set it.
                var pwrLvlEvent = self.getStateEvents("m.room.power_levels", "");
                if (pwrLvlEvent) {
                    roomMember.setPowerLevelEvent(pwrLvlEvent);
                }
            });

            self._sentinels[userId] = sentinel;
            self.members[userId] = member;
            self.emit("RoomState.members", event, self, member);
        }
        else if (event.getType() === "m.room.power_levels") {
            var members = utils.values(self.members);
            utils.forEach(members, function(member) {
                member.setPowerLevelEvent(event);
                self.emit("RoomState.members", event, self, member);
            });
        }
    });
};

/**
 * Set the current typing event for this room.
 * @param {MatrixEvent} event The typing event
 */
RoomState.prototype.setTypingEvent = function(event) {
    utils.forEach(utils.values(this.members), function(member) {
        member.setTypingEvent(event);
    });
};

/**
 * Get the m.room.member event which has the given third party invite token.
 *
 * @param {string} token The token
 * @return {?MatrixEvent} The m.room.member event or null
 */
RoomState.prototype.getInviteForThreePidToken = function(token) {
    return this._tokenToInvite[token] || null;
};

/**
 * Update the last modified time to the current time.
 */
RoomState.prototype._updateModifiedTime = function() {
    this._modified = Date.now();
};

/**
 * Get the timestamp when this room state was last updated. This timestamp is
 * updated when this object has received new state events.
 * @return {number} The timestamp
 */
RoomState.prototype.getLastModifiedTime = function() {
    return this._modified;
};

/**
 * Get user IDs with the specified display name.
 * @param {string} displayName The display name to get user IDs from.
 * @return {string[]} An array of user IDs or an empty array.
 */
RoomState.prototype.getUserIdsWithDisplayName = function(displayName) {
    return this._displayNameToUserIds[displayName] || [];
};

/**
 * Short-form for maySendEvent('m.room.message', userId)
 * @param {string} userId The user ID of the user to test permission for
 * @return {boolean} true if the given user ID should be permitted to send
 *                   message events into the given room.
 */
RoomState.prototype.maySendMessage = function(userId) {
    return this._maySendEventOfType('m.room.message', userId, false);
};

/**
 * Returns true if the given user ID has permission to send a normal
 * event of type `eventType` into this room.
 * @param {string} type The type of event to test
 * @param {string} userId The user ID of the user to test permission for
 * @return {boolean} true if the given user ID should be permitted to send
 *                        the given type of event into this room,
 *                        according to the room's state.
 */
RoomState.prototype.maySendEvent = function(eventType, userId) {
    return this._maySendEventOfType(eventType, userId, false);
};


/**
 * Returns true if the given MatrixClient has permission to send a state
 * event of type `stateEventType` into this room.
 * @param {string} type The type of state events to test
 * @param {MatrixClient}  The client to test permission for
 * @return {boolean} true if the given client should be permitted to send
 *                        the given type of state event into this room,
 *                        according to the room's state.
 */
RoomState.prototype.mayClientSendStateEvent = function(stateEventType, cli) {
    if (cli.isGuest()) {
        return false;
    }
    return this.maySendStateEvent(stateEventType, cli.credentials.userId);
};

/**
 * Returns true if the given user ID has permission to send a state
 * event of type `stateEventType` into this room.
 * @param {string} type The type of state events to test
 * @param {string} userId The user ID of the user to test permission for
 * @return {boolean} true if the given user ID should be permitted to send
 *                        the given type of state event into this room,
 *                        according to the room's state.
 */
RoomState.prototype.maySendStateEvent = function(stateEventType, userId) {
    return this._maySendEventOfType(stateEventType, userId, true);
};

/**
 * Returns true if the given user ID has permission to send a normal or state
 * event of type `eventType` into this room.
 * @param {string} type The type of event to test
 * @param {string} userId The user ID of the user to test permission for
 * @param {boolean} state If true, tests if the user may send a state
                          event of this type. Otherwise tests whether
                          they may send a regular event.
 * @return {boolean} true if the given user ID should be permitted to send
 *                        the given type of event into this room,
 *                        according to the room's state.
 */
RoomState.prototype._maySendEventOfType = function(eventType, userId, state) {
    var member = this.getMember(userId);
    if (!member || member.membership == 'leave') { return false; }

    var power_levels_event = this.getStateEvents('m.room.power_levels', '');

    var power_levels;
    var events_levels = {};

    var default_user_level = 0;
    var user_levels = [];

    var state_default = 0;
    var events_default = 0;
    if (power_levels_event) {
        power_levels = power_levels_event.getContent();
        events_levels = power_levels.events || {};

        default_user_level = parseInt(power_levels.users_default || 0);
        user_levels = power_levels.users || {};

        if (power_levels.state_default !== undefined) {
            state_default = power_levels.state_default;
        } else {
            state_default = 50;
        }
        if (power_levels.events_default !== undefined) {
            events_default = power_levels.events_default;
        }
    }

    var required_level = state ? state_default : events_default;
    if (events_levels[eventType] !== undefined) {
        required_level = events_levels[eventType];
    }
    return member.powerLevel >= required_level;
};

/**
 * The RoomState class.
 */
module.exports = RoomState;


function _updateThirdPartyTokenCache(roomState, memberEvent) {
    if (!memberEvent.getContent().third_party_invite) {
        return;
    }
    var token = (memberEvent.getContent().third_party_invite.signed || {}).token;
    if (!token) {
        return;
    }
    var threePidInvite = roomState.getStateEvents(
        "m.room.third_party_invite", token
    );
    if (!threePidInvite) {
        return;
    }
    roomState._tokenToInvite[token] = memberEvent;
}

function _updateDisplayNameCache(roomState, userId, displayName) {
    var oldName = roomState._userIdsToDisplayNames[userId];
    delete roomState._userIdsToDisplayNames[userId];
    if (oldName) {
        // Remove the old name from the cache.
        // We clobber the user_id > name lookup but the name -> [user_id] lookup
        // means we need to remove that user ID from that array rather than nuking
        // the lot.
        var existingUserIds = roomState._displayNameToUserIds[oldName] || [];
        for (var i = 0; i < existingUserIds.length; i++) {
            if (existingUserIds[i] === userId) {
                // remove this user ID from this array
                existingUserIds.splice(i, 1);
                i--;
            }
        }
        roomState._displayNameToUserIds[oldName] = existingUserIds;
    }

    roomState._userIdsToDisplayNames[userId] = displayName;
    if (!roomState._displayNameToUserIds[displayName]) {
        roomState._displayNameToUserIds[displayName] = [];
    }
    roomState._displayNameToUserIds[displayName].push(userId);
}

/**
 * Fires whenever the event dictionary in room state is updated.
 * @event module:client~MatrixClient#"RoomState.events"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomState} state The room state whose RoomState.events dictionary
 * was updated.
 * @example
 * matrixClient.on("RoomState.events", function(event, state){
 *   var newStateEvent = event;
 * });
 */

/**
 * Fires whenever a member in the members dictionary is updated in any way.
 * @event module:client~MatrixClient#"RoomState.members"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomState} state The room state whose RoomState.members dictionary
 * was updated.
 * @param {RoomMember} member The room member that was updated.
 * @example
 * matrixClient.on("RoomState.members", function(event, state, member){
 *   var newMembershipState = member.membership;
 * });
 */

 /**
 * Fires whenever a member is added to the members dictionary. The RoomMember
 * will not be fully populated yet (e.g. no membership state).
 * @event module:client~MatrixClient#"RoomState.newMember"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomState} state The room state whose RoomState.members dictionary
 * was updated with a new entry.
 * @param {RoomMember} member The room member that was added.
 * @example
 * matrixClient.on("RoomState.newMember", function(event, state, member){
 *   // add event listeners on 'member'
 * });
 */
