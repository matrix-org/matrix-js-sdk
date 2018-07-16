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
const EventEmitter = require("events").EventEmitter;

const utils = require("../utils");
const RoomMember = require("./room-member");

/**
 * Construct room state.
 *
 * Room State represents the state of the room at a given point.
 * It can be mutated by adding state events to it.
 * There are two types of room member associated with a state event:
 * normal member objects (accessed via getMember/getMembers) which mutate
 * with the state to represent the current state of that room/user, eg.
 * the object returned by getMember('@bob:example.com') will mutate to
 * get a different display name if Bob later changes his display name
 * in the room.
 * There are also 'sentinel' members (accessed via getSentinelMember).
 * These also represent the state of room members at the point in time
 * represented by the RoomState object, but unlike objects from getMember,
 * sentinel objects will always represent the room state as at the time
 * getSentinelMember was called, so if Bob subsequently changes his display
 * name, a room member object previously acquired with getSentinelMember
 * will still have his old display name. Calling getSentinelMember again
 * after the display name change will return a new RoomMember object
 * with Bob's new display name.
 *
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
    this._joinedMemberCount = null; // cache of the number of joined members
}
utils.inherits(RoomState, EventEmitter);

/**
 * Returns the number of joined members in this room
 * This method caches the result.
 * @return {integer} The number of members in this room whose membership is 'join'
 */
RoomState.prototype.getJoinedMemberCount = function() {
    if (this._joinedMemberCount === null) {
        this._joinedMemberCount = this.getMembers().filter((m) => {
            return m.membership === 'join';
        }).length;
    }
    return this._joinedMemberCount;
};

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
    if (!userId) return null;
    let sentinel = this._sentinels[userId];

    if (sentinel === undefined) {
        const member = this.members[userId];
        if (!member) {
            return null;
        }
        sentinel = new RoomMember();
        Object.assign(sentinel, member);
        this._sentinels[userId] = sentinel;
    }
    return sentinel;
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
    const event = this.events[eventType][stateKey];
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
    const self = this;
    this._updateModifiedTime();

    // update the core event dict
    utils.forEach(stateEvents, function(event) {
        if (event.getRoomId() !== self.roomId) {
            return;
        }
        if (!event.isState()) {
            return;
        }

        if (self.events[event.getType()] === undefined) {
            self.events[event.getType()] = {};
        }
        self.events[event.getType()][event.getStateKey()] = event;
        if (event.getType() === "m.room.member") {
            _updateDisplayNameCache(
                self, event.getStateKey(), event.getContent().displayname,
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
        if (event.getRoomId() !== self.roomId) {
            return;
        }
        if (!event.isState()) {
            return;
        }

        if (event.getType() === "m.room.member") {
            const userId = event.getStateKey();

            // leave events apparently elide the displayname or avatar_url,
            // so let's fake one up so that we don't leak user ids
            // into the timeline
            if (event.getContent().membership === "leave" ||
                event.getContent().membership === "ban") {
                event.getContent().avatar_url =
                    event.getContent().avatar_url ||
                    event.getPrevContent().avatar_url;
                event.getContent().displayname =
                    event.getContent().displayname ||
                    event.getPrevContent().displayname;
            }

            let member = self.members[userId];
            if (!member) {
                member = new RoomMember(event.getRoomId(), userId);
                self.emit("RoomState.newMember", event, self, member);
            }

            member.setMembershipEvent(event, self);
            self._updateMember(member);
            self.emit("RoomState.members", event, self, member);
        } else if (event.getType() === "m.room.power_levels") {
            const members = utils.values(self.members);
            utils.forEach(members, function(member) {
                member.setPowerLevelEvent(event);
                self.emit("RoomState.members", event, self, member);
            });

            // assume all our sentinels are now out-of-date
            self._sentinels = {};
        }
    });
};

RoomState.prototype._updateMember = function(member) {
    // this member may have a power level already, so set it.
    const pwrLvlEvent = this.getStateEvents("m.room.power_levels", "");
    if (pwrLvlEvent) {
        member.setPowerLevelEvent(pwrLvlEvent);
    }

    // blow away the sentinel which is now outdated
    delete this._sentinels[member.userId];

    this.members[member.userId] = member;
    this._joinedMemberCount = null;
}

/**
 * Sets the lazily loaded members. For now only joined members.
 * @param {Profile[]} array with {avatar_url, display_name } tuples
 */
RoomState.prototype.setJoinedMembers = function(joinedMembers) {
    const joinedRoomMembers = Object.entries(joinedMembers).map(([userId, details]) => {
        const displayName = details.display_name;
        const avatarUrl = details.avatar_url;
        const member = new RoomMember(this.roomId, userId);
        // try to find the member event for the user and set it first on the member
        // so inspection of the event is possible later on if we have it
        const membershipEvents = this.events["m.room.member"];
        const userMemberEvent = membershipEvents && membershipEvents[userId];
        if (userMemberEvent) {
            member.setMembershipEvent(userMemberEvent, this);
        }
        // override the displayName and avatarUrl from the lazily loaded members
        // as this is guaranteed to be the current state
        member.setAsJoinedMember(displayName, avatarUrl, this);
        const isNewMember = !this.members[userId];
        return {member, isNewMember};
    });
    joinedRoomMembers.forEach(({member, isNewMember}) => {
        _updateDisplayNameCache(this, member.userId, member.name);
        this._updateMember(member);
        if (isNewMember) {
            this.emit('RoomState.newMember', {}, self, member);
        }
        else {
            this.emit('RoomState.members', {}, self, member);
        }
    });
}

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
 * Returns true if userId is in room, event is not redacted and either sender of
 * mxEvent or has power level sufficient to redact events other than their own.
 * @param {MatrixEvent} mxEvent The event to test permission for
 * @param {string} userId The user ID of the user to test permission for
 * @return {boolean} true if the given used ID can redact given event
 */
RoomState.prototype.maySendRedactionForEvent = function(mxEvent, userId) {
    const member = this.getMember(userId);
    if (!member || member.membership === 'leave') return false;

    if (mxEvent.status || mxEvent.isRedacted()) return false;

    // The user may have been the sender, but they can't redact their own message
    // if redactions are blocked.
    const canRedact = this.maySendEvent("m.room.redaction", userId);
    if (mxEvent.getSender() === userId) return canRedact;

    return this._hasSufficientPowerLevelFor('redact', member.powerLevel);
};

/**
 * Returns true if the given power level is sufficient for action
 * @param {string} action The type of power level to check
 * @param {number} powerLevel The power level of the member
 * @return {boolean} true if the given power level is sufficient
 */
RoomState.prototype._hasSufficientPowerLevelFor = function(action, powerLevel) {
    const powerLevelsEvent = this.getStateEvents('m.room.power_levels', '');

    let powerLevels = {};
    if (powerLevelsEvent) {
        powerLevels = powerLevelsEvent.getContent();
    }

    let requiredLevel = 50;
    if (utils.isNumber(powerLevels[action])) {
        requiredLevel = powerLevels[action];
    }

    return powerLevel >= requiredLevel;
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
 * @param {string} eventType The type of event to test
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
 * @param {string} stateEventType The type of state events to test
 * @param {MatrixClient} cli The client to test permission for
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
 * @param {string} stateEventType The type of state events to test
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
 * @param {string} eventType The type of event to test
 * @param {string} userId The user ID of the user to test permission for
 * @param {boolean} state If true, tests if the user may send a state
                          event of this type. Otherwise tests whether
                          they may send a regular event.
 * @return {boolean} true if the given user ID should be permitted to send
 *                        the given type of event into this room,
 *                        according to the room's state.
 */
RoomState.prototype._maySendEventOfType = function(eventType, userId, state) {
    const member = this.getMember(userId);
    if (!member || member.membership == 'leave') {
        return false;
    }

    const power_levels_event = this.getStateEvents('m.room.power_levels', '');

    let power_levels;
    let events_levels = {};

    let state_default = 0;
    let events_default = 0;
    if (power_levels_event) {
        power_levels = power_levels_event.getContent();
        events_levels = power_levels.events || {};

        if (utils.isNumber(power_levels.state_default)) {
            state_default = power_levels.state_default;
        } else {
            state_default = 50;
        }
        if (utils.isNumber(power_levels.events_default)) {
            events_default = power_levels.events_default;
        }
    }

    let required_level = state ? state_default : events_default;
    if (utils.isNumber(events_levels[eventType])) {
        required_level = events_levels[eventType];
    }
    return member.powerLevel >= required_level;
};

/**
 * Returns true if the given user ID has permission to trigger notification
 * of type `notifLevelKey`
 * @param {string} notifLevelKey The level of notification to test (eg. 'room')
 * @param {string} userId The user ID of the user to test permission for
 * @return {boolean} true if the given user ID has permission to trigger a
 *                        notification of this type.
 */
RoomState.prototype.mayTriggerNotifOfType = function(notifLevelKey, userId) {
    const member = this.getMember(userId);
    if (!member) {
        return false;
    }

    const powerLevelsEvent = this.getStateEvents('m.room.power_levels', '');

    let notifLevel = 50;
    if (
        powerLevelsEvent &&
        powerLevelsEvent.getContent() &&
        powerLevelsEvent.getContent().notifications &&
        utils.isNumber(powerLevelsEvent.getContent().notifications[notifLevelKey])
    ) {
        notifLevel = powerLevelsEvent.getContent().notifications[notifLevelKey];
    }

    return member.powerLevel >= notifLevel;
};

/**
 * The RoomState class.
 */
module.exports = RoomState;


function _updateThirdPartyTokenCache(roomState, memberEvent) {
    if (!memberEvent.getContent().third_party_invite) {
        return;
    }
    const token = (memberEvent.getContent().third_party_invite.signed || {}).token;
    if (!token) {
        return;
    }
    const threePidInvite = roomState.getStateEvents(
        "m.room.third_party_invite", token,
    );
    if (!threePidInvite) {
        return;
    }
    roomState._tokenToInvite[token] = memberEvent;
}

function _updateDisplayNameCache(roomState, userId, displayName) {
    const oldName = roomState._userIdsToDisplayNames[userId];
    delete roomState._userIdsToDisplayNames[userId];
    if (oldName) {
        // Remove the old name from the cache.
        // We clobber the user_id > name lookup but the name -> [user_id] lookup
        // means we need to remove that user ID from that array rather than nuking
        // the lot.
        const existingUserIds = roomState._displayNameToUserIds[oldName] || [];
        for (let i = 0; i < existingUserIds.length; i++) {
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
