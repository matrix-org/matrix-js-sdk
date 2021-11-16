"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Group = Group;

var utils = _interopRequireWildcard(require("../utils"));

var _events = require("events");

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2017 New Vector Ltd
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
 * @module models/group
 * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
 */

/**
 * Construct a new Group.
 *
 * @param {string} groupId The ID of this group.
 *
 * @prop {string} groupId The ID of this group.
 * @prop {string} name The human-readable display name for this group.
 * @prop {string} avatarUrl The mxc URL for this group's avatar.
 * @prop {string} myMembership The logged in user's membership of this group
 * @prop {Object} inviter Infomation about the user who invited the logged in user
 *       to the group, if myMembership is 'invite'.
 * @prop {string} inviter.userId The user ID of the inviter
 * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
 */
function Group(groupId) {
  this.groupId = groupId;
  this.name = null;
  this.avatarUrl = null;
  this.myMembership = null;
  this.inviter = null;
}

utils.inherits(Group, _events.EventEmitter);

Group.prototype.setProfile = function (name, avatarUrl) {
  if (this.name === name && this.avatarUrl === avatarUrl) return;
  this.name = name || this.groupId;
  this.avatarUrl = avatarUrl;
  this.emit("Group.profile", this);
};

Group.prototype.setMyMembership = function (membership) {
  if (this.myMembership === membership) return;
  this.myMembership = membership;
  this.emit("Group.myMembership", this);
};
/**
 * Sets the 'inviter' property. This does not emit an event (the inviter
 * will only change when the user is revited / reinvited to a room),
 * so set this before setting myMembership.
 * @param {Object} inviter Infomation about who invited us to the room
 */


Group.prototype.setInviter = function (inviter) {
  this.inviter = inviter;
};
/**
 * Fires whenever a group's profile information is updated.
 * This means the 'name' and 'avatarUrl' properties.
 * @event module:client~MatrixClient#"Group.profile"
 * @param {Group} group The group whose profile was updated.
 * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
 * @example
 * matrixClient.on("Group.profile", function(group){
 *   var name = group.name;
 * });
 */

/**
 * Fires whenever the logged in user's membership status of
 * the group is updated.
 * @event module:client~MatrixClient#"Group.myMembership"
 * @param {Group} group The group in which the user's membership changed
 * @deprecated groups/communities never made it to the spec and support for them is being discontinued.
 * @example
 * matrixClient.on("Group.myMembership", function(group){
 *   var myMembership = group.myMembership;
 * });
 */