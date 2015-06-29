"use strict";

var PushProcessor = require('../pushprocessor');

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
    QUEUED: "queued"
};

/**
 * Construct a Matrix Event object
 * @constructor
 * @param {Object} event The raw event to be wrapped in this DAO
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
module.exports.MatrixEvent = function MatrixEvent(event) {
    this.event = event || {};
    this.sender = null;
    this.target = null;
    this.status = null;
    this.forwardLooking = true;
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
        return this.event.user_id;
    },

    /**
     * Get the type of event.
     * @return {string} The event type, e.g. <code>m.room.message</code>
     */
    getType: function() {
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
     * Get the event content JSON.
     * @return {Object} The event content JSON, or an empty object.
     */
    getContent: function() {
        return this.event.content || {};
    },

    /**
     * Get the previous event content JSON. This will only return something for
     * state events which exist in the timeline.
     * @return {Object} The previous event content JSON, or an empty object.
     */
    getPrevContent: function() {
        return this.event.prev_content || {};
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
        return this.event.age;
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

    getPushActions: function(client) {
        if (this.pushActions === undefined) {
            var pushProcessor = new PushProcessor(client);
            this.pushActions = pushProcessor.actionsForEvent(this.event);
        }
        return this.pushActions;
    }
};
