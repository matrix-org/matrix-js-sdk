"use strict";
/**
 * This is an internal module. See {@link MatrixEvent} and {@link RoomEvent} for
 * the public classes.
 * @module models/event
 */

/**
 * Construct a Matrix Event object
 * @constructor
 * @param {Object} event The raw event to be wrapped in this DAO
 * @prop {Object} event The raw event. <b>Do not access this property</b>
 * directly unless you absolutely have to. Prefer the getter methods defined on
 * this class. Using the getter methods shields your app from
 * changes to event JSON between Matrix versions.
 */
module.exports.MatrixEvent = function MatrixEvent(event) {
    this.event = event || {};
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
     * @return {Object} The event content JSON.
     */
    getContent: function() {
        return this.event.content;
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
    }
};
