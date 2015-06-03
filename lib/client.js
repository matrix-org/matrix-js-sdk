"use strict";
var MatrixHttpApi = require("./http-api");
var MatrixEvent = require("./models/event").MatrixEvent;

// TODO:
// Internal: rate limiting

/*
 * Construct a Matrix Client.
 * @param {Object} credentials The credentials for this client
 * @param {Object} config The config (if any) for this client.
 *  Valid config params include:
 *      noUserAgent: true // to avoid warnings whilst setting UA headers
 *      debug: true // to use console.err() style debugging from the lib
 * @param {Object} store The data store (if any) for this client.
 * @param {Function} request The request fn to use.
 */
function MatrixClient(credentials, config, store, request) {
    if (typeof credentials === "string") {
        credentials = {
            "baseUrl": credentials
        };
    }
    var requiredKeys = [
        "baseUrl"
    ];
    for (var i = 0; i < requiredKeys.length; i++) {
        if (!credentials.hasOwnProperty(requiredKeys[i])) {
            throw new Error("Missing required key: " + requiredKeys[i]);
        }
    }
    this.config = config;
    this.credentials = credentials;
    this.store = store;

    // track our position in the overall eventstream
    this.fromToken = undefined;
    this.clientRunning = false;
    this._http = new MatrixHttpApi(credentials, config, request);
}
MatrixClient.prototype = {
    isLoggedIn: function() {
        return this.credentials.accessToken !== undefined &&
            this.credentials.userId !== undefined;
    },

    // Higher level APIs
    // =================

    // TODO: stuff to handle:
    //   local echo
    //   event dup suppression? - apparently we should still be doing this
    //   tracking current display name / avatar per-message
    //   pagination
    //   re-sending (including persisting pending messages to be sent)
    //   - Need a nice way to callback the app for arbitrary events like
    //     displayname changes
    //   due to ambiguity (or should this be on a chat-specific layer)?
    //   reconnect after connectivity outages

    /*
     * Helper method for retrieving the name of a room suitable for display
     * in the UI
     * TODO: in future, this should be being generated serverside.
     * @param {String} roomId ID of room whose name is to be resolved
     * @return {String} human-readable label for room.
     */
    getFriendlyRoomName: function(roomId) {
        // we need a store to track the inputs for calculating room names
        if (!this.store) {
            return roomId;
        }

        // check for an alias, if any. for now, assume first alias is the
        // official one.
        var alias;
        var mRoomAliases = this.store.getStateEvents(roomId, 'm.room.aliases')[0];
        if (mRoomAliases) {
            alias = mRoomAliases.event.content.aliases[0];
        }

        var mRoomName = this.store.getStateEvent(roomId, 'm.room.name', '');
        if (mRoomName) {
            return mRoomName.event.content.name + (alias ? " (" + alias + ")" : "");
        }
        else if (alias) {
            return alias;
        }
        else {
            var userId = this.credentials.userId;
            var members = this.store.getStateEvents(roomId, 'm.room.member')
                .filter(function(event) {
                    return event.event.user_id !== userId;
                });

            if (members.length === 0) {
                return "Unknown";
            }
            else if (members.length == 1) {
                return (
                    members[0].event.content.displayname ||
                        members[0].event.user_id
                );
            }
            else if (members.length == 2) {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members[1].event.content.displayname ||
                        members[1].event.user_id)
                );
            }
            else {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members.length - 1) + " others"
                );
            }
        }
    },

    /*
     * Helper method for retrieving the name of a user suitable for display
     * in the UI in the context of a room - i.e. disambiguating from any
     * other users in the room.
     * XXX: This could perhaps also be generated serverside, perhaps by just passing
     * a 'disambiguate' flag down on membership entries which have ambiguous
     * displaynames?
     * @param {String} userId ID of the user whose name is to be resolved
     * @param {String} roomId ID of room to be used as the context for
     * resolving the name.
     * @return {String} human-readable name of the user.
     */
    getFriendlyDisplayName: function(userId, roomId) {
        // we need a store to track the inputs for calculating display names
        if (!this.store) { return userId; }

        var displayName;
        var memberEvent = this.store.getStateEvent(roomId, 'm.room.member', userId);
        if (memberEvent && memberEvent.event.content.displayname) {
            displayName = memberEvent.event.content.displayname;
        }
        else {
            return userId;
        }

        var members = this.store.getStateEvents(roomId, 'm.room.member')
            .filter(function(event) {
                return event.event.content.displayname === displayName;
            });

        if (members.length > 1) {
            return displayName + " (" + userId + ")";
        }
        else {
            return displayName;
        }
    },

    /*
     * High level helper method to call initialSync, emit the resulting events,
     * and then start polling the eventStream for new events.
     * @param {function} callback Callback invoked whenever new event are available
     * @param {Number} historyLen amount of historical timeline events to
     * emit during from the initial sync.
     */
    startClient: function(callback, historyLen) {
        historyLen = historyLen || 12;

        var self = this;
        if (!this.fromToken) {
            this._http.initialSync(historyLen, function(err, data) {
                var i, j;
                if (err) {
                    if (this.config && this.config.debug) {
                        console.error(
                            "startClient error on initialSync: %s",
                            JSON.stringify(err)
                        );
                    }
                    callback(err);
                    return;
                }
                if (self.store) {
                    var eventMapper = function(event) {
                        return new MatrixEvent(event);
                    };
                    // intercept the results and put them into our store
                    self.store.setPresenceEvents(
                        map(data.presence, eventMapper)
                    );
                    for (i = 0; i < data.rooms.length; i++) {
                        self.store.setStateEvents(
                            map(data.rooms[i].state, eventMapper)
                        );
                        self.store.setEvents(
                            map(data.rooms[i].messages.chunk, eventMapper)
                        );
                    }
                }
                if (data) {
                    self.fromToken = data.end;
                    var events = [];
                    for (i = 0; i < data.presence.length; i++) {
                        events.push(new MatrixEvent(data.presence[i]));
                    }
                    for (i = 0; i < data.rooms.length; i++) {
                        for (j = 0; j < data.rooms[i].state.length; j++) {
                            events.push(new MatrixEvent(data.rooms[i].state[j]));
                        }
                        for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                            events.push(
                                new MatrixEvent(data.rooms[i].messages.chunk[j])
                            );
                        }
                    }
                    callback(undefined, events, false);
                }

                self.clientRunning = true;
                self._pollForEvents(callback);
            });
        }
        else {
            this._pollForEvents(callback);
        }
    },

    _pollForEvents: function(callback) {
        var self = this;
        if (!this.clientRunning) {
            return;
        }
        this._http.eventStream(this.fromToken, 30000, function(err, data) {
            if (err) {
                if (this.config && this.config.debug) {
                    console.error(
                        "error polling for events via eventStream: %s",
                        JSON.stringify(err)
                    );
                }
                callback(err);
                // retry every few seconds
                // FIXME: this should be exponential backoff with an option to nudge
                setTimeout(function() {
                    self._pollForEvents(callback);
                }, 2000);
                return;
            }

            if (self.store) {
                self.store.setEvents(map(data.chunk,
                    function(event) {
                        return new MatrixEvent(event);
                    }
                ));
            }
            if (data) {
                self.fromToken = data.end;
                var events = [];
                for (var j = 0; j < data.chunk.length; j++) {
                    events.push(new MatrixEvent(data.chunk[j]));
                }
                callback(undefined, events, true);
            }
            self._pollForEvents(callback);
        });
    },

    /*
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    stopClient: function() {
        this.clientRunning = false;
    },
};

var map = function(array, fn) {
    var results = new Array(array.length);
    for (var i = 0; i < array.length; i++) {
        results[i] = fn(array[i]);
    }
    return results;
};

/**
 * The high-level Matrix Client class.
 */
module.exports = MatrixClient;  // expose the class
