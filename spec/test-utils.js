"use strict";

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
 * Create a JSON object representing an Event.
 * @param {string} type The event.type
 * @param {string} room The event.room_id
 * @param {string} userId The event.user_id
 * @param {Object} content The event.content
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
         "m.room.power_levels", "m.room.topic", "com.example.state"].indexOf(type)
            !== -1) {
        event.state_key = "";
    }
    return event;
};

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

module.exports.mkMessage = function(room, userId, msg) {
    if (!msg) {
        msg = "Random->"+Math.random();
    }
    return module.exports.mkEvent("m.room.message", room, userId, {
        msgtype: "m.text",
        body: msg
    });
};