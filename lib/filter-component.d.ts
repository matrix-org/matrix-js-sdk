import { MatrixEvent } from "./models/event";
export interface IFilterComponent {
    types?: string[];
    not_types?: string[];
    rooms?: string[];
    not_rooms?: string[];
    senders?: string[];
    not_senders?: string[];
    contains_url?: boolean;
    limit?: number;
}
/**
 * FilterComponent is a section of a Filter definition which defines the
 * types, rooms, senders filters etc to be applied to a particular type of resource.
 * This is all ported over from synapse's Filter object.
 *
 * N.B. that synapse refers to these as 'Filters', and what js-sdk refers to as
 * 'Filters' are referred to as 'FilterCollections'.
 *
 * @constructor
 * @param {Object} filterJson the definition of this filter JSON, e.g. { 'contains_url': true }
 */
export declare class FilterComponent {
    private filterJson;
    constructor(filterJson: IFilterComponent);
    /**
     * Checks with the filter component matches the given event
     * @param {MatrixEvent} event event to be checked against the filter
     * @return {boolean} true if the event matches the filter
     */
    check(event: MatrixEvent): boolean;
    /**
     * Converts the filter component into the form expected over the wire
     */
    toJSON(): object;
    /**
     * Checks whether the filter component matches the given event fields.
     * @param {String} roomId        the roomId for the event being checked
     * @param {String} sender        the sender of the event being checked
     * @param {String} eventType     the type of the event being checked
     * @param {boolean} containsUrl  whether the event contains a content.url field
     * @return {boolean} true if the event fields match the filter
     */
    private checkFields;
    /**
     * Filters a list of events down to those which match this filter component
     * @param {MatrixEvent[]} events  Events to be checked against the filter component
     * @return {MatrixEvent[]} events which matched the filter component
     */
    filter(events: MatrixEvent[]): MatrixEvent[];
    /**
     * Returns the limit field for a given filter component, providing a default of
     * 10 if none is otherwise specified. Cargo-culted from Synapse.
     * @return {Number} the limit for this filter component.
     */
    limit(): number;
}
//# sourceMappingURL=filter-component.d.ts.map