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
 * @module filter
 */

const FilterComponent = require("./filter-component");

/**
 * @param {Object} obj
 * @param {string} keyNesting
 * @param {*} val
 */
function setProp(obj, keyNesting, val) {
    const nestedKeys = keyNesting.split(".");
    let currentObj = obj;
    for (let i = 0; i < (nestedKeys.length - 1); i++) {
        if (!currentObj[nestedKeys[i]]) {
            currentObj[nestedKeys[i]] = {};
        }
        currentObj = currentObj[nestedKeys[i]];
    }
    currentObj[nestedKeys[nestedKeys.length - 1]] = val;
}

/**
 * Construct a new Filter.
 * @constructor
 * @param {string} userId The user ID for this filter.
 * @param {string=} filterId The filter ID if known.
 * @prop {string} userId The user ID of the filter
 * @prop {?string} filterId The filter ID
 */
function Filter(userId, filterId) {
    this.userId = userId;
    this.filterId = filterId;
    this.definition = {};
}

Filter.LAZY_LOADING_MESSAGES_FILTER = {
    lazy_load_members: true,
};

Filter.LAZY_LOADING_SYNC_FILTER = {
    room: {
        state: Filter.LAZY_LOADING_MESSAGES_FILTER,
    },
};


/**
 * Get the ID of this filter on your homeserver (if known)
 * @return {?Number} The filter ID
 */
Filter.prototype.getFilterId = function() {
    return this.filterId;
};

/**
 * Get the JSON body of the filter.
 * @return {Object} The filter definition
 */
Filter.prototype.getDefinition = function() {
    return this.definition;
};

/**
 * Set the JSON body of the filter
 * @param {Object} definition The filter definition
 */
Filter.prototype.setDefinition = function(definition) {
    this.definition = definition;

    // This is all ported from synapse's FilterCollection()

    // definitions look something like:
    // {
    //   "room": {
    //     "rooms": ["!abcde:example.com"],
    //     "not_rooms": ["!123456:example.com"],
    //     "state": {
    //       "types": ["m.room.*"],
    //       "not_rooms": ["!726s6s6q:example.com"],
    //     },
    //     "timeline": {
    //       "limit": 10,
    //       "types": ["m.room.message"],
    //       "not_rooms": ["!726s6s6q:example.com"],
    //       "not_senders": ["@spam:example.com"]
    //       "contains_url": true
    //     },
    //     "ephemeral": {
    //       "types": ["m.receipt", "m.typing"],
    //       "not_rooms": ["!726s6s6q:example.com"],
    //       "not_senders": ["@spam:example.com"]
    //     }
    //   },
    //   "presence": {
    //     "types": ["m.presence"],
    //     "not_senders": ["@alice:example.com"]
    //   },
    //   "event_format": "client",
    //   "event_fields": ["type", "content", "sender"]
    // }

    const room_filter_json = definition.room;

    // consider the top level rooms/not_rooms filter
    const room_filter_fields = {};
    if (room_filter_json) {
        if (room_filter_json.rooms) {
            room_filter_fields.rooms = room_filter_json.rooms;
        }
        if (room_filter_json.rooms) {
            room_filter_fields.not_rooms = room_filter_json.not_rooms;
        }

        this._include_leave = room_filter_json.include_leave || false;
    }

    this._room_filter = new FilterComponent(room_filter_fields);
    this._room_timeline_filter = new FilterComponent(
        room_filter_json ? (room_filter_json.timeline || {}) : {},
    );

    // don't bother porting this from synapse yet:
    // this._room_state_filter =
    //     new FilterComponent(room_filter_json.state || {});
    // this._room_ephemeral_filter =
    //     new FilterComponent(room_filter_json.ephemeral || {});
    // this._room_account_data_filter =
    //     new FilterComponent(room_filter_json.account_data || {});
    // this._presence_filter =
    //     new FilterComponent(definition.presence || {});
    // this._account_data_filter =
    //     new FilterComponent(definition.account_data || {});
};

/**
 * Get the room.timeline filter component of the filter
 * @return {FilterComponent} room timeline filter component
 */
Filter.prototype.getRoomTimelineFilterComponent = function() {
    return this._room_timeline_filter;
};

/**
 * Filter the list of events based on whether they are allowed in a timeline
 * based on this filter
 * @param {MatrixEvent[]} events  the list of events being filtered
 * @return {MatrixEvent[]} the list of events which match the filter
 */
Filter.prototype.filterRoomTimeline = function(events) {
    return this._room_timeline_filter.filter(this._room_filter.filter(events));
};

/**
 * Set the max number of events to return for each room's timeline.
 * @param {Number} limit The max number of events to return for each room.
 */
Filter.prototype.setTimelineLimit = function(limit) {
    setProp(this.definition, "room.timeline.limit", limit);
};

/**
 * Control whether left rooms should be included in responses.
 * @param {boolean} includeLeave True to make rooms the user has left appear
 * in responses.
 */
Filter.prototype.setIncludeLeaveRooms = function(includeLeave) {
    setProp(this.definition, "room.include_leave", includeLeave);
};

/**
 * Create a filter from existing data.
 * @static
 * @param {string} userId
 * @param {string} filterId
 * @param {Object} jsonObj
 * @return {Filter}
 */
Filter.fromJson = function(userId, filterId, jsonObj) {
    const filter = new Filter(userId, filterId);
    filter.setDefinition(jsonObj);
    return filter;
};

/** The Filter class */
module.exports = Filter;
