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
};

/**
 * Set the max number of events to return for each room's timeline.
 * @param {Number} limit The max number of events to return for each room.
 */
Filter.prototype.setTimelineLimit = function(limit) {
    setProp(this.definition, "room.timeline.limit", limit);
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
    filter.setDefinition(jsonObj);
    return filter;
};

/** The Filter class */
module.exports = Filter;
