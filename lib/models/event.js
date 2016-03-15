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
 * This is an internal module. See {@link MatrixEvent} and {@link RoomEvent} for
 * the public classes.
 * @module models/event
 */

/**
 * Enum for event statuses.
 * @readonly
 * @enum {string}
 */
module.exports.EventStatus = {
    /** The event was not sent and will no longer be retried. */
    NOT_SENT: "not_sent",
    /** The event is in the process of being sent. */
    SENDING: "sending",
    /** The event is in a queue waiting to be sent. */
    QUEUED: "queued",
    /** The event has been sent to the server, but we have not yet received the
     * echo. */
    SENT: "sent",
};

/**
 * Construct a Matrix Event object
 * @constructor
 * @param {Object} event The raw event to be wrapped in this DAO
 * @param {boolean} encrypted Was the event encrypted
 * @prop {Object} event The raw event. <b>Do not access this property</b>
 * directly unless you absolutely have to. Prefer the getter methods defined on
 * this class. Using the getter methods shields your app from
 * changes to event JSON between Matrix versions.
 * @prop {RoomMember} sender The room member who sent this event, or null e.g.
 * this is a presence event.
 * @prop {RoomMember} target The room member who is the target of this event, e.g.
 * the invitee, the person being banned, etc.
 * @prop {EventStatus} status The sending status of the event.
 * @prop {boolean} forwardLooking True if this event is 'forward looking', meaning
 * that getDirectionalContent() will return event.content and not event.prev_content.
 * Default: true. <strong>This property is experimental and may change.</strong>
 */
module.exports.MatrixEvent = function MatrixEvent(event, encrypted) {
    this.event = event || {};
    this.sender = null;
    this.target = null;
    this.status = null;
    this.forwardLooking = true;
    this.encrypted = Boolean(encrypted);
};
module.exports.MatrixEvent.prototype = {

    /**
     * Get the event_id for this event.
     * @return {string} The event ID, e.g. <code>$143350589368169JsLZx:localhost
     * </code>
     */
    getId: function() {
        return this.event.event_id;
    },

    /**
     * Get the user_id for this event.
     * @return {string} The user ID, e.g. <code>@alice:matrix.org</code>
     */
    getSender: function() {
        return this.event.sender || this.event.user_id; // v2 / v1
    },

    /**
     * Get the type of event.
     * @return {string} The event type, e.g. <code>m.room.message</code>
     */
    getType: function() {
        return this.event.type;
    },

    /**
     * Get the type of the event that will be sent to the homeserver.
     * @return {string} The event type.
     */
    getWireType: function() {
        return this.encryptedType || this.event.type;
    },

    /**
     * Get the room_id for this event. This will return <code>undefined</code>
     * for <code>m.presence</code> events.
     * @return {string} The room ID, e.g. <code>!cURbafjkfsMDVwdRDQ:matrix.org
     * </code>
     */
    getRoomId: function() {
        return this.event.room_id;
    },

    /**
     * Get the timestamp of this event.
     * @return {Number} The event timestamp, e.g. <code>1433502692297</code>
     */
    getTs: function() {
        return this.event.origin_server_ts;
    },

    /**
     * Get the event content JSON.
     * @return {Object} The event content JSON, or an empty object.
     */
    getContent: function() {
        return this.event.content || {};
    },

    /**
     * Get the event content JSON that will be sent to the homeserver.
     * @return {Object} The event content JSON, or an empty object.
     */
    getWireContent: function() {
        return this.encryptedContent || this.event.content || {};
    },

    /**
     * Get the previous event content JSON. This will only return something for
     * state events which exist in the timeline.
     * @return {Object} The previous event content JSON, or an empty object.
     */
    getPrevContent: function() {
        // v2 then v1 then default
        return this.getUnsigned().prev_content || this.event.prev_content || {};
    },

    /**
     * Get either 'content' or 'prev_content' depending on if this event is
     * 'forward-looking' or not. This can be modified via event.forwardLooking.
     * <strong>This method is experimental and may change.</strong>
     * @return {Object} event.content if this event is forward-looking, else
     * event.prev_content.
     */
    getDirectionalContent: function() {
        return this.forwardLooking ? this.getContent() : this.getPrevContent();
    },

    /**
     * Get the age of this event. This represents the age of the event when the
     * event arrived at the device, and not the age of the event when this
     * function was called.
     * @return {Number} The age of this event in milliseconds.
     */
    getAge: function() {
        return this.getUnsigned().age || this.event.age; // v2 / v1
    },

    /**
     * Get the event state_key if it has one. This will return <code>undefined
     * </code> for message events.
     * @return {string} The event's <code>state_key</code>.
     */
    getStateKey: function() {
        return this.event.state_key;
    },

    /**
     * Check if this event is a state event.
     * @return {boolean} True if this is a state event.
     */
    isState: function() {
        return this.event.state_key !== undefined;
    },

    /**
     * Check if the event is encrypted.
     * @return {boolean} True if this event is encrypted.
     */
    isEncrypted: function() {
        return this.encrypted;
    },

    getUnsigned: function() {
        return this.event.unsigned || {};
    },

    /**
     * Update the content of an event in the same way it would be by the server
     * if it were redacted before it was sent to us
     *
     * @param {Object} the raw event causing the redaction
     */
    makeRedacted: function(redaction_event) {
        if (!this.event.unsigned) {
            this.event.unsigned = {};
        }
        this.event.unsigned.redacted_because = redaction_event;

        var key;
        for (key in this.event) {
            if (!this.event.hasOwnProperty(key)) { continue; }
            if (!_REDACT_KEEP_KEY_MAP[key]) {
                delete this.event[key];
            }
        }

        var keeps = _REDACT_KEEP_CONTENT_MAP[this.getType()] || {};
        for (key in this.event.content) {
            if (!this.event.content.hasOwnProperty(key)) { continue; }
            if (!keeps[key]) {
                delete this.event.content[key];
            }
        }
    },

    /**
     * Check if this event has been redacted
     *
     * @return {boolean} True if this event has been redacted
     */
    isRedacted: function() {
        return Boolean(this.getUnsigned().redacted_because);
    },
};


/* http://matrix.org/docs/spec/r0.0.1/client_server.html#redactions says:
 *
 * the server should strip off any keys not in the following list:
 *    event_id
 *    type
 *    room_id
 *    user_id
 *    state_key
 *    prev_state
 *    content
 *    [we keep 'unsigned' as well, since that is created by the local server]
 *
 * The content object should also be stripped of all keys, unless it is one of
 * one of the following event types:
 *    m.room.member allows key membership
 *    m.room.create allows key creator
 *    m.room.join_rules allows key join_rule
 *    m.room.power_levels allows keys ban, events, events_default, kick,
 *        redact, state_default, users, users_default.
 *    m.room.aliases allows key aliases
 */
// a map giving the keys we keep when an event is redacted
var _REDACT_KEEP_KEY_MAP = [
    'event_id', 'type', 'room_id', 'user_id', 'state_key', 'prev_state',
    'content', 'unsigned',
].reduce(function(ret, val) { ret[val] = 1; return ret; }, {});

// a map from event type to the .content keys we keep when an event is redacted
var _REDACT_KEEP_CONTENT_MAP = {
    'm.room.member': {'membership': 1},
    'm.room.create': {'creator': 1},
    'm.room.join_rules': {'join_rule': 1},
    'm.room.power_levels': {'ban': 1, 'events': 1, 'events_default': 1,
                            'kick': 1, 'redact': 1, 'state_default': 1,
                            'users': 1, 'users_default': 1,
                           },
    'm.room.aliases': {'aliases': 1},
};
