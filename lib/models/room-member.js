"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RoomMember = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _events = require("events");

var _contentRepo = require("../content-repo");

var utils = _interopRequireWildcard(require("../utils"));

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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
 * @module models/room-member
 */
class RoomMember extends _events.EventEmitter {
  // used by sync.ts
  // XXX these should be read-only

  /**
   * Construct a new room member.
   *
   * @constructor
   * @alias module:models/room-member
   *
   * @param {string} roomId The room ID of the member.
   * @param {string} userId The user ID of the member.
   * @prop {string} roomId The room ID for this member.
   * @prop {string} userId The user ID of this member.
   * @prop {boolean} typing True if the room member is currently typing.
   * @prop {string} name The human-readable name for this room member. This will be
   * disambiguated with a suffix of " (@user_id:matrix.org)" if another member shares the
   * same displayname.
   * @prop {string} rawDisplayName The ambiguous displayname of this room member.
   * @prop {Number} powerLevel The power level for this room member.
   * @prop {Number} powerLevelNorm The normalised power level (0-100) for this
   * room member.
   * @prop {User} user The User object for this room member, if one exists.
   * @prop {string} membership The membership state for this room member e.g. 'join'.
   * @prop {Object} events The events describing this RoomMember.
   * @prop {MatrixEvent} events.member The m.room.member event for this RoomMember.
   * @prop {boolean} disambiguate True if the member's name is disambiguated.
   */
  constructor(roomId, userId) {
    super();
    this.roomId = roomId;
    this.userId = userId;
    (0, _defineProperty2.default)(this, "_isOutOfBand", false);
    (0, _defineProperty2.default)(this, "_modified", void 0);
    (0, _defineProperty2.default)(this, "_requestedProfileInfo", void 0);
    (0, _defineProperty2.default)(this, "typing", false);
    (0, _defineProperty2.default)(this, "name", void 0);
    (0, _defineProperty2.default)(this, "rawDisplayName", void 0);
    (0, _defineProperty2.default)(this, "powerLevel", 0);
    (0, _defineProperty2.default)(this, "powerLevelNorm", 0);
    (0, _defineProperty2.default)(this, "user", null);
    (0, _defineProperty2.default)(this, "membership", null);
    (0, _defineProperty2.default)(this, "disambiguate", false);
    (0, _defineProperty2.default)(this, "events", {
      member: null
    });
    this.name = userId;
    this.rawDisplayName = userId;
    this.updateModifiedTime();
  }
  /**
   * Mark the member as coming from a channel that is not sync
   */


  markOutOfBand() {
    this._isOutOfBand = true;
  }
  /**
   * @return {boolean} does the member come from a channel that is not sync?
   * This is used to store the member seperately
   * from the sync state so it available across browser sessions.
   */


  isOutOfBand() {
    return this._isOutOfBand;
  }
  /**
   * Update this room member's membership event. May fire "RoomMember.name" if
   * this event updates this member's name.
   * @param {MatrixEvent} event The <code>m.room.member</code> event
   * @param {RoomState} roomState Optional. The room state to take into account
   * when calculating (e.g. for disambiguating users with the same name).
   * @fires module:client~MatrixClient#event:"RoomMember.name"
   * @fires module:client~MatrixClient#event:"RoomMember.membership"
   */


  setMembershipEvent(event, roomState) {
    const displayName = event.getDirectionalContent().displayname;

    if (event.getType() !== "m.room.member") {
      return;
    }

    this._isOutOfBand = false;
    this.events.member = event;
    const oldMembership = this.membership;
    this.membership = event.getDirectionalContent().membership;
    this.disambiguate = shouldDisambiguate(this.userId, displayName, roomState);
    const oldName = this.name;
    this.name = calculateDisplayName(this.userId, displayName, roomState, this.disambiguate); // not quite raw: we strip direction override chars so it can safely be inserted into
    // blocks of text without breaking the text direction

    this.rawDisplayName = utils.removeDirectionOverrideChars(event.getDirectionalContent().displayname);

    if (!this.rawDisplayName || !utils.removeHiddenChars(this.rawDisplayName)) {
      this.rawDisplayName = this.userId;
    }

    if (oldMembership !== this.membership) {
      this.updateModifiedTime();
      this.emit("RoomMember.membership", event, this, oldMembership);
    }

    if (oldName !== this.name) {
      this.updateModifiedTime();
      this.emit("RoomMember.name", event, this, oldName);
    }
  }
  /**
   * Update this room member's power level event. May fire
   * "RoomMember.powerLevel" if this event updates this member's power levels.
   * @param {MatrixEvent} powerLevelEvent The <code>m.room.power_levels</code>
   * event
   * @fires module:client~MatrixClient#event:"RoomMember.powerLevel"
   */


  setPowerLevelEvent(powerLevelEvent) {
    if (powerLevelEvent.getType() !== "m.room.power_levels") {
      return;
    }

    const evContent = powerLevelEvent.getDirectionalContent();
    let maxLevel = evContent.users_default || 0;
    const users = evContent.users || {};
    Object.values(users).forEach(function (lvl) {
      maxLevel = Math.max(maxLevel, lvl);
    });
    const oldPowerLevel = this.powerLevel;
    const oldPowerLevelNorm = this.powerLevelNorm;

    if (users[this.userId] !== undefined && Number.isInteger(users[this.userId])) {
      this.powerLevel = users[this.userId];
    } else if (evContent.users_default !== undefined) {
      this.powerLevel = evContent.users_default;
    } else {
      this.powerLevel = 0;
    }

    this.powerLevelNorm = 0;

    if (maxLevel > 0) {
      this.powerLevelNorm = this.powerLevel * 100 / maxLevel;
    } // emit for changes in powerLevelNorm as well (since the app will need to
    // redraw everyone's level if the max has changed)


    if (oldPowerLevel !== this.powerLevel || oldPowerLevelNorm !== this.powerLevelNorm) {
      this.updateModifiedTime();
      this.emit("RoomMember.powerLevel", powerLevelEvent, this);
    }
  }
  /**
   * Update this room member's typing event. May fire "RoomMember.typing" if
   * this event changes this member's typing state.
   * @param {MatrixEvent} event The typing event
   * @fires module:client~MatrixClient#event:"RoomMember.typing"
   */


  setTypingEvent(event) {
    if (event.getType() !== "m.typing") {
      return;
    }

    const oldTyping = this.typing;
    this.typing = false;
    const typingList = event.getContent().user_ids;

    if (!Array.isArray(typingList)) {
      // malformed event :/ bail early. TODO: whine?
      return;
    }

    if (typingList.indexOf(this.userId) !== -1) {
      this.typing = true;
    }

    if (oldTyping !== this.typing) {
      this.updateModifiedTime();
      this.emit("RoomMember.typing", event, this);
    }
  }
  /**
   * Update the last modified time to the current time.
   */


  updateModifiedTime() {
    this._modified = Date.now();
  }
  /**
   * Get the timestamp when this RoomMember was last updated. This timestamp is
   * updated when properties on this RoomMember are updated.
   * It is updated <i>before</i> firing events.
   * @return {number} The timestamp
   */


  getLastModifiedTime() {
    return this._modified;
  }

  isKicked() {
    return this.membership === "leave" && this.events.member.getSender() !== this.events.member.getStateKey();
  }
  /**
   * If this member was invited with the is_direct flag set, return
   * the user that invited this member
   * @return {string} user id of the inviter
   */


  getDMInviter() {
    // when not available because that room state hasn't been loaded in,
    // we don't really know, but more likely to not be a direct chat
    if (this.events.member) {
      // TODO: persist the is_direct flag on the member as more member events
      //       come in caused by displayName changes.
      // the is_direct flag is set on the invite member event.
      // This is copied on the prev_content section of the join member event
      // when the invite is accepted.
      const memberEvent = this.events.member;
      let memberContent = memberEvent.getContent();
      let inviteSender = memberEvent.getSender();

      if (memberContent.membership === "join") {
        memberContent = memberEvent.getPrevContent();
        inviteSender = memberEvent.getUnsigned().prev_sender;
      }

      if (memberContent.membership === "invite" && memberContent.is_direct) {
        return inviteSender;
      }
    }
  }
  /**
   * Get the avatar URL for a room member.
   * @param {string} baseUrl The base homeserver URL See
   * {@link module:client~MatrixClient#getHomeserverUrl}.
   * @param {Number} width The desired width of the thumbnail.
   * @param {Number} height The desired height of the thumbnail.
   * @param {string} resizeMethod The thumbnail resize method to use, either
   * "crop" or "scale".
   * @param {Boolean} allowDefault (optional) Passing false causes this method to
   * return null if the user has no avatar image. Otherwise, a default image URL
   * will be returned. Default: true. (Deprecated)
   * @param {Boolean} allowDirectLinks (optional) If true, the avatar URL will be
   * returned even if it is a direct hyperlink rather than a matrix content URL.
   * If false, any non-matrix content URLs will be ignored. Setting this option to
   * true will expose URLs that, if fetched, will leak information about the user
   * to anyone who they share a room with.
   * @return {?string} the avatar URL or null.
   */


  getAvatarUrl(baseUrl, width, height, resizeMethod, allowDefault = true, allowDirectLinks) {
    const rawUrl = this.getMxcAvatarUrl();

    if (!rawUrl && !allowDefault) {
      return null;
    }

    const httpUrl = (0, _contentRepo.getHttpUriForMxc)(baseUrl, rawUrl, width, height, resizeMethod, allowDirectLinks);

    if (httpUrl) {
      return httpUrl;
    }

    return null;
  }
  /**
   * get the mxc avatar url, either from a state event, or from a lazily loaded member
   * @return {string} the mxc avatar url
   */


  getMxcAvatarUrl() {
    if (this.events.member) {
      return this.events.member.getDirectionalContent().avatar_url;
    } else if (this.user) {
      return this.user.avatarUrl;
    }

    return null;
  }

}

exports.RoomMember = RoomMember;
const MXID_PATTERN = /@.+:.+/;
const LTR_RTL_PATTERN = /[\u200E\u200F\u202A-\u202F]/;

function shouldDisambiguate(selfUserId, displayName, roomState) {
  if (!displayName || displayName === selfUserId) return false; // First check if the displayname is something we consider truthy
  // after stripping it of zero width characters and padding spaces

  if (!utils.removeHiddenChars(displayName)) return false;
  if (!roomState) return false; // Next check if the name contains something that look like a mxid
  // If it does, it may be someone trying to impersonate someone else
  // Show full mxid in this case

  if (MXID_PATTERN.test(displayName)) return true; // Also show mxid if the display name contains any LTR/RTL characters as these
  // make it very difficult for us to find similar *looking* display names
  // E.g "Mark" could be cloned by writing "kraM" but in RTL.

  if (LTR_RTL_PATTERN.test(displayName)) return true; // Also show mxid if there are other people with the same or similar
  // displayname, after hidden character removal.

  const userIds = roomState.getUserIdsWithDisplayName(displayName);
  if (userIds.some(u => u !== selfUserId)) return true;
  return false;
}

function calculateDisplayName(selfUserId, displayName, roomState, disambiguate) {
  if (disambiguate) return utils.removeDirectionOverrideChars(displayName) + " (" + selfUserId + ")";
  if (!displayName || displayName === selfUserId) return selfUserId; // First check if the displayname is something we consider truthy
  // after stripping it of zero width characters and padding spaces

  if (!utils.removeHiddenChars(displayName)) return selfUserId; // We always strip the direction override characters (LRO and RLO).
  // These override the text direction for all subsequent characters
  // in the paragraph so if display names contained these, they'd
  // need to be wrapped in something to prevent this from leaking out
  // (which we can do in HTML but not text) or we'd need to add
  // control characters to the string to reset any overrides (eg.
  // adding PDF characters at the end). As far as we can see,
  // there should be no reason these would be necessary - rtl display
  // names should flip into the correct direction automatically based on
  // the characters, and you can still embed rtl in ltr or vice versa
  // with the embed chars or marker chars.

  return utils.removeDirectionOverrideChars(displayName);
}
/**
 * Fires whenever any room member's name changes.
 * @event module:client~MatrixClient#"RoomMember.name"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.name changed.
 * @param {string?} oldName The previous name. Null if the member didn't have a
 *    name previously.
 * @example
 * matrixClient.on("RoomMember.name", function(event, member){
 *   var newName = member.name;
 * });
 */

/**
 * Fires whenever any room member's membership state changes.
 * @event module:client~MatrixClient#"RoomMember.membership"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.membership changed.
 * @param {string?} oldMembership The previous membership state. Null if it's a
 *    new member.
 * @example
 * matrixClient.on("RoomMember.membership", function(event, member, oldMembership){
 *   var newState = member.membership;
 * });
 */

/**
 * Fires whenever any room member's typing state changes.
 * @event module:client~MatrixClient#"RoomMember.typing"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.typing changed.
 * @example
 * matrixClient.on("RoomMember.typing", function(event, member){
 *   var isTyping = member.typing;
 * });
 */

/**
 * Fires whenever any room member's power level changes.
 * @event module:client~MatrixClient#"RoomMember.powerLevel"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {RoomMember} member The member whose RoomMember.powerLevel changed.
 * @example
 * matrixClient.on("RoomMember.powerLevel", function(event, member){
 *   var newPowerLevel = member.powerLevel;
 *   var newNormPowerLevel = member.powerLevelNorm;
 * });
 */