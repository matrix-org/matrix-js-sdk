/**
 * @module models/search-result
 */
import { EventContext } from "./event-context";
import { EventMapper } from "../event-mapper";
import { ISearchResult } from "../@types/search";
export declare class SearchResult {
    readonly rank: number;
    readonly context: EventContext;
    /**
     * Create a SearchResponse from the response to /search
     * @static
     * @param {Object} jsonObj
     * @param {function} eventMapper
     * @return {SearchResult}
     */
    static fromJson(jsonObj: ISearchResult, eventMapper: EventMapper): SearchResult;
    /**
     * Construct a new SearchResult
     *
     * @param {number} rank   where this SearchResult ranks in the results
     * @param {event-context.EventContext} context  the matching event and its
     *    context
     *
     * @constructor
     */
    constructor(rank: number, context: EventContext);
}
//# sourceMappingURL=search-result.d.ts.map