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
 * @module models/search-result
 */

const EventContext = require("./event-context");
const utils = require("../utils");

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
    const jsonContext = jsonObj.context || {};
    const events_before = jsonContext.events_before || [];
    const events_after = jsonContext.events_after || [];

    const context = new EventContext(eventMapper(jsonObj.result));

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
