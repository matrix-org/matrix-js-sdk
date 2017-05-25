/*
Copyright 2016 OpenMarket Ltd

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
 * @module filter-component
 */

/**
 * Checks if a value matches a given field value, which may be a * terminated
 * wildcard pattern.
 * @param {String} actualValue  The value to be compared
 * @param {String} filterValue  The filter pattern to be compared
 * @return {bool} true if the actualValue matches the filterValue
 */
function _matchesWildcard(actualValue, filterValue) {
    if (filterValue.endsWith("*")) {
        const typePrefix = filterValue.slice(0, -1);
        return actualValue.substr(0, typePrefix.length) === typePrefix;
    } else {
        return actualValue === filterValue;
    }
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
 * @param {Object} filterJson the definition of this filter JSON, e.g. { 'containsUrl': true }
 */
function FilterComponent(filterJson) {
    this.filterJson = filterJson;

    this.types = filterJson.types || null;
    this.not_types = filterJson.not_types || [];

    this.rooms = filterJson.rooms || null;
    this.not_rooms = filterJson.not_rooms || [];

    this.senders = filterJson.senders || null;
    this.not_senders = filterJson.not_senders || [];

    this.containsUrl = filterJson.containsUrl || null;
}

/**
 * Checks with the filter component matches the given event
 * @param {MatrixEvent} event event to be checked against the filter
 * @return {bool} true if the event matches the filter
 */
FilterComponent.prototype.check = function(event) {
    return this._checkFields(
        event.getRoomId(),
        event.getSender(),
        event.getType(),
        event.getContent() ? event.getContent().url !== undefined : false,
    );
};

/**
 * Checks whether the filter component matches the given event fields.
 * @param {String} roomId       the roomId for the event being checked
 * @param {String} sender        the sender of the event being checked
 * @param {String} eventType    the type of the event being checked
 * @param {String} containsUrl  whether the event contains a content.url field
 * @return {bool} true if the event fields match the filter
 */
FilterComponent.prototype._checkFields =
    function(roomId, sender, eventType, containsUrl) {
    const literalKeys = {
        "rooms": function(v) {
            return roomId === v;
        },
        "senders": function(v) {
            return sender === v;
        },
        "types": function(v) {
            return _matchesWildcard(eventType, v);
        },
    };

    const self = this;
    Object.keys(literalKeys).forEach(function(name) {
        const matchFunc = literalKeys[name];
        const notName = "not_" + name;
        const disallowedValues = self[notName];
        if (disallowedValues.map(matchFunc)) {
            return false;
        }

        const allowedValues = self[name];
        if (allowedValues) {
            if (!allowedValues.map(matchFunc)) {
                return false;
            }
        }
    });

    const containsUrlFilter = this.filterJson.containsUrl;
    if (containsUrlFilter !== undefined) {
        if (containsUrlFilter !== containsUrl) {
            return false;
        }
    }

    return true;
};

/**
 * Filters a list of events down to those which match this filter component
 * @param {MatrixEvent[]} events  Events to be checked againt the filter component
 * @return {MatrixEvent[]} events which matched the filter component
 */
FilterComponent.prototype.filter = function(events) {
    return events.filter(this.check, this);
};

/**
 * Returns the limit field for a given filter component, providing a default of
 * 10 if none is otherwise specified.  Cargo-culted from Synapse.
 * @return {Number} the limit for this filter component.
 */
FilterComponent.prototype.limit = function() {
    return this.filterJson.limit !== undefined ? this.filterJson.limit : 10;
};

/** The FilterComponent class */
module.exports = FilterComponent;
