"use strict";
/**
 * @module filter
 */

/**
 * @param {Object} obj
 * @param {string} keyNesting
 * @param {*} val
 */
function setProp(obj, keyNesting, val) {
    var nestedKeys = keyNesting.split(".");
    var currentObj = obj;
    for (var i = 0; i < (nestedKeys.length - 1); i++) {
        if (!currentObj[nestedKeys[i]]) {
            currentObj[nestedKeys[i]] = {};
        }
        currentObj = currentObj[nestedKeys[i]];
    }
    currentObj[nestedKeys.length - 1] = val;
}

/**
 * Construct a new Filter.
 * @constructor
 * @param {string} userId The user ID for this filter.
 * @param {string=} filterId The filter ID if known.
 */
function Filter(userId, filterId) {
    this.userId = userId;
    this.filterId = filterId;
    this.body = {
        event_format: "client"
    };
}

/**
 * Get the JSON body of the filter.
 * @return {Object} The JSON body
 */
Filter.prototype.getBody = function() {
    return this.body;
};

/**
 * Set the JSON body of the filter
 * @param {Object} body
 */
Filter.prototype.setBody = function(body) {
    this.body = body;
};

/**
 * Set the max number of events to return for each room's timeline.
 * @param {Number} limit The max number of events to return for each room.
 */
Filter.prototype.setTimelineLimit = function(limit) {
    setProp(this.body, "room.timeline.limit", limit);
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
    var filter = new Filter(userId, filterId);
    filter.setBody(jsonObj);
    return filter;
};

/** The Filter class */
module.exports = Filter;
