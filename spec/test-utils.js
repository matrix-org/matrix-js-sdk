"use strict";
var sdk = require("..");
var MatrixEvent = sdk.MatrixEvent;

/**
 * Perform common actions before each test case, e.g. printing the test case
 * name to stdout.
 * @param {TestCase} testCase The test case that is about to be run.
 */
module.exports.beforeEach = function(testCase) {
    var desc = testCase.suite.description + " : " + testCase.description;
    console.log(desc);
    console.log(new Array(1 + desc.length).join("="));
};

/**
 * Create a spy for an object and automatically spy its methods.
 * @param {*} constr The class constructor (used with 'new')
 * @param {string} name The name of the class
 * @return {Object} An instantiated object with spied methods/properties.
 */
module.exports.mock = function(constr, name) {
    // By Tim Buschtöns
    // http://eclipsesource.com/blogs/2014/03/27/mocks-in-jasmine-tests/
    var HelperConstr = new Function(); // jshint ignore:line
    HelperConstr.prototype = constr.prototype;
    var result = new HelperConstr();
    result.jasmineToString = function() {
        return "mock" + (name ? " of " + name : "");
    };
    for (var key in constr.prototype) { // jshint ignore:line
        try {
            if (constr.prototype[key] instanceof Function) {
                result[key] = jasmine.createSpy((name || "mock") + '.' + key);
            }
        }
        catch (ex) {
            // Direct access to some non-function fields of DOM prototypes may
            // cause exceptions.
            // Overwriting will not work either in that case.
        }
    }
    return result;
};

/**
 * Create a JSON object representing an Event.
 * @param {string} type The event.type
 * @param {string} room The event.room_id
 * @param {string} userId The event.user_id
 * @param {Object} content The event.content
 * @return {Object} a JSON object representing this event.
 */
module.exports.mkEvent = function(type, room, userId, content) {
    var event = {
        type: type,
        room_id: room,
        user_id: userId,
        content: content,
        event_id: "$" + Math.random() + "-" + Math.random()
    };
    if (["m.room.name", "m.room.topic", "m.room.create", "m.room.join_rules",
         "m.room.power_levels", "m.room.topic",
         "com.example.state"].indexOf(type) !== -1) {
        event.state_key = "";
    }
    return event;
};

/**
 * Create an m.room.member POJO.
 * @param {string} room The room ID for the event.
 * @param {string} membership The content.membership for the event.
 * @param {string} userId The user ID for the event.
 * @param {string} otherUserId The other user ID for the event if applicable
 * e.g. for invites/bans.
 * @param {string} displayName The content.displayname for the event.
 * @param {string} avatarUrl The content.avatar_url for the event.
 * @return {Object} The event
 */
module.exports.mkMembership = function(room, membership, userId, otherUserId,
                                       displayName, avatarUrl) {
    var event = module.exports.mkEvent("m.room.member", room, userId, {
        membership: membership,
        displayname: displayName,
        avatar_url: avatarUrl
    });
    event.state_key = userId;
    if (["invite", "ban"].indexOf(membership) !== -1) {
        event.state_key = otherUserId;
    }
    return event;
};

/**
 * Create an m.room.message POJO.
 * @param {Object} opts Values for the message
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.user The user ID for the event.
 * @param {string} opts.msg Optional. The content.body for the event.
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @return {Object} The event
 */
module.exports.mkMessage = function(opts) {
    if (!opts.msg) {
        opts.msg = "Random->" + Math.random();
    }
    if (!opts.room || !opts.user) {
        throw new Error("Missing .room or .user from %s", opts);
    }
    opts.type = "m.room.message";
    opts.content = {
        msgtype: "m.text",
        body: opts.msg
    };
    //var pojo = module.exports.mkEvent(opts);
    var pojo = module.exports.mkEvent(
        opts.type, opts.room, opts.user, opts.content
    );
    return opts.event ? new MatrixEvent(pojo) : pojo;
};
