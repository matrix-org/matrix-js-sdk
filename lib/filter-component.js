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

function _matches_wildcard(actual_value, filter_value) {
    if (filter_value.endsWith("*")) {
        type_prefix = filter_value.slice(0, -1);
        return actual_value.substr(0, type_prefix.length) === type_prefix;
    }
    else {
        return actual_value === filter_value;
    }
}

/**
 * A FilterComponent is a section of a Filter definition which defines the
 * types, rooms, senders filters etc to be applied to a particular type of resource.
 *
 * This is all ported from synapse's Filter object.
 */
FilterComponent = function(filter_json) {
    this.filter_json = filter_json;

    this.types = filter_json.types || null;
    this.not_types = filter_json.not_types || [];

    self.rooms = filter_json.rooms || null;
    self.not_rooms = filter_json.not_rooms || [];

    self.senders = filter_json.senders || null;
    self.not_senders = filter_json.not_senders || [];

    self.contains_url = filter_json.contains_url || null;
};

/**
 * Checks with the filter component matches the given event
 */
FilterComponent.prototype.check = function(event) {
    var sender = event.sender;
    if (!sender) {
        // Presence events have their 'sender' in content.user_id
        if (event.content) {
            sender = event.content.user_id;
        }
    }

    return this.checkFields(
        event.room_id,
        sender,
        event.type,
        event.content ? event.content.url !== undefined : false,
    );
};

/**
 * Checks whether the filter matches the given event fields.
 */
FilterComponent.prototype.checkFields =
    function(room_id, sender, event_type, contains_url) {
        var literal_keys = {
            "rooms": function(v) { return room_id === v; },
            "senders": function(v) { return sender === v; },
            "types": function(v) { return _matches_wildcard(event_type, v); },
        };

        Object.keys(literal_keys).forEach(function(name) {
            var match_func = literal_keys[name];
            var not_name = "not_" + name;
            var disallowed_values = this[not_name];
            if (disallowed_values.map(match_func)) {
                return false;
            }

            var allowed_values = this[name];
            if (allowed_values) {
                if (!allowed_values.map(match_func)) {
                    return false;
                }
            }
        });

        contains_url_filter = this.filter_json.contains_url;
        if (contains_url_filter !== undefined) {
            if (contains_url_filter !== contains_url) {
                return false;
            }
        }

        return true;
    }
};

FilterComponent.prototype.filter = function(events) {
    return events.filter(this.check);
};

FilterComponent.prototype.limit = function() {
    return this.filter_json.limit !== undefined ? this.filter_json.limit : 10;
};

/** The FilterComponent class */
module.exports = FilterComponent;
