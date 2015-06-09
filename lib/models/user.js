"use strict";
/**
 * @module models/user
 */

/**
 * Construct a new User. A User must have an ID and can optionally have extra
 * information associated with it.
 * @constructor
 * @param {string} userId Required. The ID of this user.
 * @param {Object} info Optional. The user info. Additional keys are supported.
 * @param {MatrixEvent} info.presence The <code>m.presence</code> event for this user.
 * @prop {string} userId The ID of the user.
 * @prop {Object} info The info object supplied in the constructor.
 * @prop {string} displayName The 'displayname' of the user if known.
 * @prop {string} avatarUrl The 'avatar_url' of the user if known.
 * @prop {string} presence The presence enum if known.
 * @prop {Number} lastActiveAgo The last time the user performed some action in ms.
 */
function User(userId, info) {
    this.userId = userId;
    this.info = info;
    if (info.presence) {
        this.presence = info.presence.getContent().presence;
        this.displayName = info.presence.getContent().displayname;
        this.avatarUrl = info.presence.getContent().avatar_url;
        this.lastActiveAgo = info.presence.getContent().last_active_ago;
    }
}

/**
 * The User class.
 */
module.exports = User;
