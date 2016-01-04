"use strict";

/**
 * @module models/search-result
 */

var EventContext = require("./event-context");
var utils = require("../utils");

/**
 * Construct a new SearchResult
 *
 * @param {number} rank   where this SearchResult ranks in the results
 * @param {event-context.EventContext} eventContext  the matching event and its
 *    context
 *
 * @constructor
 */
function SearchResult(rank, eventContext) {
    this.rank = rank;
    this.context = eventContext;
}

/**
 * Create a SearchResponse from the response to /search
 * @static
 * @param {Object} jsonObj
 * @param {function} eventMapper
 * @return {SearchResult}
 */

SearchResult.fromJson = function(jsonObj, eventMapper) {
    var jsonContext = jsonObj.context || {};
    var events_before = jsonContext.events_before || [];
    var events_after = jsonContext.events_after || [];

    var context = new EventContext(eventMapper(jsonObj.result));

    context.setPaginateToken(jsonContext.start, true);
    context.addEvents(utils.map(events_before, eventMapper), true);
    context.addEvents(utils.map(events_after, eventMapper), false);
    context.setPaginateToken(jsonContext.end, false);

    return new SearchResult(jsonObj.rank, context);
};


/**
 * The SearchResult class
 */
module.exports = SearchResult;
