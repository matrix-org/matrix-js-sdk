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

var EventEmitter = require("events").EventEmitter;

var utils = require('../utils.js');

/**
 * Enum for event statuses.
 * @readonly
 * @enum {string}
 */
module.exports.EventStatus = {
    /** The event was not sent and will no longer be retried. */
    NOT_SENT: "not_sent",

    /** The message is being encrypted */
    ENCRYPTING: "encrypting",

    /** The event is in the process of being sent. */
    SENDING: "sending",
    /** The event is in a queue waiting to be sent. */
    QUEUED: "queued",
    /** The event has been sent to the server, but we have not yet received the
     * echo. */
    SENT: "sent",

    /** The event was cancelled before it was successfully sent. */
    CANCELLED: "cancelled",
};

/**
 * Construct a Matrix Event object
 * @constructor
 *
 * @param {Object} event The raw event to be wrapped in this DAO
 *
 * @prop {Object} event The raw (possibly encrypted) event. <b>Do not access
 * this property</b> directly unless you absolutely have to. Prefer the getter
 * methods defined on this class. Using the getter methods shields your app
 * from changes to event JSON between Matrix versions.
 *
 * @prop {RoomMember} sender The room member who sent this event, or null e.g.
 * this is a presence event.
 * @prop {RoomMember} target The room member who is the target of this event, e.g.
 * the invitee, the person being banned, etc.
 * @prop {EventStatus} status The sending status of the event.
 * @prop {boolean} forwardLooking True if this event is 'forward looking', meaning
 * that getDirectionalContent() will return event.content and not event.prev_content.
 * Default: true. <strong>This property is experimental and may change.</strong>
 */
module.exports.MatrixEvent = function MatrixEvent(
    event
) {
    this.event = event || {};
    this.sender = null;
    this.target = null;
    this.status = null;
    this.forwardLooking = true;
    this._pushActions = null;
    this._date = this.event.origin_server_ts ?
        new Date(this.event.origin_server_ts) : null;

    this._clearEvent = {};
    this._keysProved = {};
    this._keysClaimed = {};
};
utils.inherits(module.exports.MatrixEvent, EventEmitter);


utils.extend(module.exports.MatrixEvent.prototype, {

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
     * Get the (decrypted, if necessary) type of event.
     *
     * @return {string} The event type, e.g. <code>m.room.message</code>
     */
    getType: function() {
        return this._clearEvent.type || this.event.type;
    },

    /**
     * Get the (possibly encrypted) type of the event that will be sent to the
     * homeserver.
     *
     * @return {string} The event type.
     */
    getWireType: function() {
        return this.event.type;
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
     * Get the timestamp of this event, as a Date object.
     * @return {Date} The event date, e.g. <code>new Date(1433502692297)</code>
     */
    getDate: function() {
        return this._date;
    },

    /**
     * Get the (decrypted, if necessary) event content JSON.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getContent: function() {
        return this._clearEvent.content || this.event.content || {};
    },

    /**
     * Get the (possibly encrypted) event content JSON that will be sent to the
     * homeserver.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getWireContent: function() {
        return this.event.content || {};
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
     * In practice, this means we get the chronologically earlier content value
     * for this event (this method should surely be called getEarlierContent)
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
     * Replace the content of this event with encrypted versions.
     * (This is used when sending an event; it should not be used by applications).
     *
     * @internal
     *
     * @param {string} crypto_type type of the encrypted event - typically
     * <tt>"m.room.encrypted"</tt>
     *
     * @param {object} crypto_content raw 'content' for the encrypted event.
     * @param {object} keys The local keys claimed and proved by this event.
     */
    makeEncrypted: function(crypto_type, crypto_content, keys) {
        // keep the plain-text data for 'view source'
        this._clearEvent = {
            type: this.event.type,
            content: this.event.content,
        };
        this.event.type = crypto_type;
        this.event.content = crypto_content;
        this._keysProved = keys;
        this._keysClaimed = keys;
    },

    /**
     * Update the cleartext data on this event.
     *
     * (This is used after decrypting an event; it should not be used by applications).
     *
     * @internal
     *
     * @fires module:models/event.MatrixEvent#"Event.decrypted"
     *
     * @param {Object} clearEvent The plaintext payload for the event
     *     (typically containing <tt>type</tt> and <tt>content</tt> fields).
     *
     * @param {Object=} keysProved Keys owned by the sender of this event.
     *    See {@link module:models/event.MatrixEvent#getKeysProved}.
     *
     * @param {Object=} keysClaimed Keys the sender of this event claims.
     *    See {@link module:models/event.MatrixEvent#getKeysClaimed}.
     */
    setClearData: function(clearEvent, keysProved, keysClaimed) {
        this._clearEvent = clearEvent;
        this._keysProved = keysProved || {};
        this._keysClaimed = keysClaimed || {};
        this.emit("Event.decrypted", this);
    },

    /**
     * Check if the event is encrypted.
     * @return {boolean} True if this event is encrypted.
     */
    isEncrypted: function() {
        return this.event.type === "m.room.encrypted";
    },

    /**
     * The curve25519 key that sent this event
     * @return {string}
     */
    getSenderKey: function() {
        return this.getKeysProved().curve25519 || null;
    },

    /**
     * The keys that must have been owned by the sender of this encrypted event.
     * <p>
     * These don't necessarily have to come from this event itself, but may be
     * implied by the cryptographic session.
     *
     * @return {Object<string, string>}
     */
    getKeysProved: function() {
        return this._keysProved;
    },

    /**
     * The additional keys the sender of this encrypted event claims to possess.
     * <p>
     * These don't necessarily have to come from this event itself, but may be
     * implied by the cryptographic session.
     * For example megolm messages don't claim keys directly, but instead
     * inherit a claim from the olm message that established the session.
     *
     * @return {Object<string, string>}
     */
    getKeysClaimed: function() {
        return this._keysClaimed;
    },

    getUnsigned: function() {
        return this.event.unsigned || {};
    },

    /**
     * Update the content of an event in the same way it would be by the server
     * if it were redacted before it was sent to us
     *
     * @param {module:models/event.MatrixEvent} redaction_event
     *     event causing the redaction
     */
    makeRedacted: function(redaction_event) {
        // quick sanity-check
        if (!redaction_event.event) {
            throw new Error("invalid redaction_event in makeRedacted");
        }

        // we attempt to replicate what we would see from the server if
        // the event had been redacted before we saw it.
        //
        // The server removes (most of) the content of the event, and adds a
        // "redacted_because" key to the unsigned section containing the
        // redacted event.
        if (!this.event.unsigned) {
            this.event.unsigned = {};
        }
        this.event.unsigned.redacted_because = redaction_event.event;

        var key;
        for (key in this.event) {
            if (!this.event.hasOwnProperty(key)) { continue; }
            if (!_REDACT_KEEP_KEY_MAP[key]) {
                delete this.event[key];
            }
        }

        var keeps = _REDACT_KEEP_CONTENT_MAP[this.getType()] || {};
        var content = this.getContent();
        for (key in content) {
            if (!content.hasOwnProperty(key)) { continue; }
            if (!keeps[key]) {
                delete content[key];
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

    /**
     * Get the push actions, if known, for this event
     *
     * @return {?Object} push actions
     */
     getPushActions: function() {
        return this._pushActions;
     },

    /**
     * Set the push actions for this event.
     *
     * @param {Object} pushActions push actions
     */
     setPushActions: function(pushActions) {
        this._pushActions = pushActions;
     },

     /**
      * Replace the `event` property and recalculate any properties based on it.
      * @param {Object} event the object to assign to the `event` property
      */
     handleRemoteEcho: function(event) {
        this.event = event;
        // successfully sent.
        this.status = null;
        this._date = new Date(this.event.origin_server_ts);
     }
});


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




/**
 * Fires when an event is decrypted
 *
 * @event module:models/event.MatrixEvent#"Event.decrypted"
 *
 * @param {module:models/event.MatrixEvent} event
 *    The matrix event which has been decrypted
 */
