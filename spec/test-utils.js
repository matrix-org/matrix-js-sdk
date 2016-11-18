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
 * Create an Event.
 * @param {Object} opts Values for the event.
 * @param {string} opts.type The event.type
 * @param {string} opts.room The event.room_id
 * @param {string} opts.sender The event.sender
 * @param {string} opts.skey Optional. The state key (auto inserts empty string)
 * @param {Object} opts.content The event.content
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @return {Object} a JSON object representing this event.
 */
module.exports.mkEvent = function(opts) {
    if (!opts.type || !opts.content) {
        throw new Error("Missing .type or .content =>" + JSON.stringify(opts));
    }
    var event = {
        type: opts.type,
        room_id: opts.room,
        sender: opts.sender || opts.user, // opts.user for backwards-compat
        content: opts.content,
        event_id: "$" + Math.random() + "-" + Math.random()
    };
    if (opts.skey !== undefined) {
        event.state_key = opts.skey;
    }
    else if (["m.room.name", "m.room.topic", "m.room.create", "m.room.join_rules",
         "m.room.power_levels", "m.room.topic",
         "com.example.state"].indexOf(opts.type) !== -1) {
        event.state_key = "";
    }
    return opts.event ? new MatrixEvent(event) : event;
};

/**
 * Create an m.presence event.
 * @param {Object} opts Values for the presence.
 * @return {Object|MatrixEvent} The event
 */
module.exports.mkPresence = function(opts) {
    if (!opts.user) {
        throw new Error("Missing user");
    }
    var event = {
        event_id: "$" + Math.random() + "-" + Math.random(),
        type: "m.presence",
        sender: opts.sender || opts.user, // opts.user for backwards-compat
        content: {
            avatar_url: opts.url,
            displayname: opts.name,
            last_active_ago: opts.ago,
            presence: opts.presence || "offline"
        }
    };
    return opts.event ? new MatrixEvent(event) : event;
};

/**
 * Create an m.room.member event.
 * @param {Object} opts Values for the membership.
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.mship The content.membership for the event.
 * @param {string} opts.sender The sender user ID for the event.
 * @param {string} opts.skey The target user ID for the event if applicable
 * e.g. for invites/bans.
 * @param {string} opts.name The content.displayname for the event.
 * @param {string} opts.url The content.avatar_url for the event.
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @return {Object|MatrixEvent} The event
 */
module.exports.mkMembership = function(opts) {
    opts.type = "m.room.member";
    if (!opts.skey) {
        opts.skey = opts.sender || opts.user;
    }
    if (!opts.mship) {
        throw new Error("Missing .mship => " + JSON.stringify(opts));
    }
    opts.content = {
        membership: opts.mship
    };
    if (opts.name) { opts.content.displayname = opts.name; }
    if (opts.url) { opts.content.avatar_url = opts.url; }
    return module.exports.mkEvent(opts);
};

/**
 * Create an m.room.message event.
 * @param {Object} opts Values for the message
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.user The user ID for the event.
 * @param {string} opts.msg Optional. The content.body for the event.
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @return {Object|MatrixEvent} The event
 */
module.exports.mkMessage = function(opts) {
    opts.type = "m.room.message";
    if (!opts.msg) {
        opts.msg = "Random->" + Math.random();
    }
    if (!opts.room || !opts.user) {
        throw new Error("Missing .room or .user from %s", opts);
    }
    opts.content = {
        msgtype: "m.text",
        body: opts.msg
    };
    return module.exports.mkEvent(opts);
};


/**
 * make the test fail, with the given exception
 *
 * <p>This is useful for use with integration tests which use asyncronous
 * methods: it can be added as a 'catch' handler in a promise chain.
 *
 * @param {Error} err   exception to be reported
 *
 * @deprecated
 * It turns out there are easier ways of doing this. Just use nodeify():
 *
 * it("should not throw", function(done) {
 *    asynchronousMethod().then(function() {
 *       // some tests
 *    }).nodeify(done);
 * });
 *
 * @example
 * it("should not throw", function(done) {
 *    asynchronousMethod().then(function() {
 *       // some tests
 *    }).catch(utils.failTest).done(done);
 * });
 */
module.exports.failTest = function(err) {
    expect(true).toBe(false, "Testfunc threw: " + err.stack);
};


/**
 * A mock implementation of webstorage
 *
 * @constructor
 */
module.exports.MockStorageApi = function() {
    this.data = {};
};
module.exports.MockStorageApi.prototype = {
    setItem: function(k, v) {
        this.data[k] = v;
    },
    getItem: function(k) {
        return this.data[k] || null;
    },
    removeItem: function(k) {
        delete this.data[k];
    }
};
