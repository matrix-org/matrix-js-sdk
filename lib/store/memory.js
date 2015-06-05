"use strict";
/**
 * This is an internal module. See {@link MatrixInMemoryStore} for the public class.
 * @module store/memory
 */

/**
 * Construct a new in-memory data store for the Matrix Client.
 * @constructor
 */
module.exports.MatrixInMemoryStore = function MatrixInMemoryStore() {
    this.rooms = {
        // state: { },
        // timeline: [ ],
    };

    this.presence = {
        // presence objects keyed by userId
    };
};

// XXX: this is currently quite procedural - we could possibly pass back
// models of Rooms, Users, Events, etc instead.
module.exports.MatrixInMemoryStore.prototype = {

    /*
     * Add an array of one or more state MatrixEvents into the store, overwriting
     * any existing state with the same {room, type, stateKey} tuple.
     */
    setStateEvents: function(stateEvents) {
        // we store stateEvents indexed by room, event type and state key.
        for (var i = 0; i < stateEvents.length; i++) {
            var event = stateEvents[i].event;
            var roomId = event.room_id;
            if (this.rooms[roomId] === undefined) {
                this.rooms[roomId] = {};
            }
            if (this.rooms[roomId].state === undefined) {
                this.rooms[roomId].state = {};
            }
            if (this.rooms[roomId].state[event.type] === undefined) {
                this.rooms[roomId].state[event.type] = {};
            }
            this.rooms[roomId].state[event.type][event.state_key] = stateEvents[i];
        }
    },

    /*
     * Add a single state MatrixEvents into the store, overwriting
     * any existing state with the same {room, type, stateKey} tuple.
     */
    setStateEvent: function(stateEvent) {
        this.setStateEvents([stateEvent]);
    },

    /*
     * Return a list of MatrixEvents from the store
     * @param {String} roomId the Room ID whose state is to be returned
     * @param {String} type the type of the state events to be returned (optional)
     * @param {String} stateKey the stateKey of the state events to be returned
     *                 (optional, requires type to be specified)
     * @return {MatrixEvent[]} an array of MatrixEvents from the store,
     * filtered by roomid, type and state key.
     */
    getStateEvents: function(roomId, type, stateKey) {
        var stateEvents = [];
        if (stateKey === undefined && type === undefined) {
            for (type in this.rooms[roomId].state) {
                if (this.rooms[roomId].state.hasOwnProperty(type)) {
                    for (stateKey in this.rooms[roomId].state[type]) {
                        if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                            stateEvents.push(
                                this.rooms[roomId].state[type][stateKey]
                            );
                        }
                    }
                }
            }
            return stateEvents;
        }
        else if (stateKey === undefined) {
            for (stateKey in this.rooms[roomId].state[type]) {
                if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                    stateEvents.push(this.rooms[roomId].state[type][stateKey]);
                }
            }
            return stateEvents;
        }
        else {
            return [this.rooms[roomId].state[type][stateKey]];
        }
    },

    /*
     * Return a single state MatrixEvent from the store for the given roomId
     * and type.
     * @param {String} roomId the Room ID whose state is to be returned
     * @param {String} type the type of the state events to be returned
     * @param {String} stateKey the stateKey of the state events to be returned
     * @return {MatrixEvent} a single MatrixEvent from the store, filtered
     * by roomid, type and state key.
     */
    getStateEvent: function(roomId, type, stateKey) {
        return this.rooms[roomId].state[type][stateKey];
    },

    /*
     * Adds a list of arbitrary MatrixEvents into the store.
     * If the event is a state event, it is also updates state.
     */
    setEvents: function(events) {
        for (var i = 0; i < events.length; i++) {
            var event = events[i].event;
            if (event.type === "m.presence") {
                this.setPresenceEvents([events[i]]);
                continue;
            }
            var roomId = event.room_id;
            if (this.rooms[roomId] === undefined) {
                this.rooms[roomId] = {};
            }
            if (this.rooms[roomId].timeline === undefined) {
                this.rooms[roomId].timeline = [];
            }
            if (event.state_key !== undefined) {
                this.setStateEvents([events[i]]);
            }
            this.rooms[roomId].timeline.push(events[i]);
        }
    },

    /*
     * Get the timeline of events for a given room
     * TODO: ordering!
     */
    getEvents: function(roomId) {
        return this.rooms[roomId].timeline;
    },

    setPresenceEvents: function(presenceEvents) {
        for (var i = 0; i < presenceEvents.length; i++) {
            var matrixEvent = presenceEvents[i];
            this.presence[matrixEvent.event.user_id] = matrixEvent;
        }
    },

    getPresenceEvents: function(userId) {
        return this.presence[userId];
    },

    getRoomList: function() {
        var roomIds = [];
        for (var roomId in this.rooms) {
            if (this.rooms.hasOwnProperty(roomId)) {
                roomIds.push(roomId);
            }
        }
        return roomIds;
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};
