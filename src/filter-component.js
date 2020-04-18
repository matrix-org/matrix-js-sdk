/*
Copyright 2016 OpenMarket Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/**
 * @module filter-component
 */

/**
 * Checks if a value matches a given field value, which may be a * terminated
 * wildcard pattern.
 * @param {String} actual_value  The value to be compared
 * @param {String} filter_value  The filter pattern to be compared
 * @return {bool} true if the actual_value matches the filter_value
 */
function _matches_wildcard(actual_value, filter_value) {
    if (filter_value.endsWith("*")) {
        const type_prefix = filter_value.slice(0, -1);
        return actual_value.substr(0, type_prefix.length) === type_prefix;
    } else {
        return actual_value === filter_value;
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
 * @param {Object} filter_json the definition of this filter JSON, e.g. { 'contains_url': true }
 */
export function FilterComponent(filter_json) {
    this.filter_json = filter_json;

    this.types = filter_json.types || null;
    this.not_types = filter_json.not_types || [];

    this.rooms = filter_json.rooms || null;
    this.not_rooms = filter_json.not_rooms || [];

    this.senders = filter_json.senders || null;
    this.not_senders = filter_json.not_senders || [];

    this.contains_url = filter_json.contains_url || null;
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
 * @param {String} room_id       the room_id for the event being checked
 * @param {String} sender        the sender of the event being checked
 * @param {String} event_type    the type of the event being checked
 * @param {String} contains_url  whether the event contains a content.url field
 * @return {bool} true if the event fields match the filter
 */
FilterComponent.prototype._checkFields =
    function(room_id, sender, event_type, contains_url) {
    const literal_keys = {
        "rooms": function(v) {
            return room_id === v;
        },
        "senders": function(v) {
            return sender === v;
        },
        "types": function(v) {
            return _matches_wildcard(event_type, v);
        },
    };

    const self = this;
    for (let n=0; n < Object.keys(literal_keys).length; n++) {
        const name = Object.keys(literal_keys)[n];
        const match_func = literal_keys[name];
        const not_name = "not_" + name;
        const disallowed_values = self[not_name];
        if (disallowed_values.filter(match_func).length > 0) {
            return false;
        }

        const allowed_values = self[name];
        if (allowed_values && allowed_values.length > 0) {
            const anyMatch = allowed_values.some(match_func);
            if (!anyMatch) {
                return false;
            }
        }
    }

    const contains_url_filter = this.filter_json.contains_url;
    if (contains_url_filter !== undefined) {
        if (contains_url_filter !== contains_url) {
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
    return this.filter_json.limit !== undefined ? this.filter_json.limit : 10;
};
