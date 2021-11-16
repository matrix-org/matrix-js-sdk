"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.TweakName = exports.RuleId = exports.PushRuleKind = exports.PushRuleActionName = exports.DMMemberCountCondition = exports.ConditionOperator = exports.ConditionKind = void 0;
exports.isDmMemberCountCondition = isDmMemberCountCondition;

/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
// allow camelcase as these are things that go onto the wire

/* eslint-disable camelcase */
let PushRuleActionName;
exports.PushRuleActionName = PushRuleActionName;

(function (PushRuleActionName) {
  PushRuleActionName["DontNotify"] = "dont_notify";
  PushRuleActionName["Notify"] = "notify";
  PushRuleActionName["Coalesce"] = "coalesce";
})(PushRuleActionName || (exports.PushRuleActionName = PushRuleActionName = {}));

let TweakName;
exports.TweakName = TweakName;

(function (TweakName) {
  TweakName["Highlight"] = "highlight";
  TweakName["Sound"] = "sound";
})(TweakName || (exports.TweakName = TweakName = {}));

let ConditionOperator;
exports.ConditionOperator = ConditionOperator;

(function (ConditionOperator) {
  ConditionOperator["ExactEquals"] = "==";
  ConditionOperator["LessThan"] = "<";
  ConditionOperator["GreaterThan"] = ">";
  ConditionOperator["GreaterThanOrEqual"] = ">=";
  ConditionOperator["LessThanOrEqual"] = "<=";
})(ConditionOperator || (exports.ConditionOperator = ConditionOperator = {}));

const DMMemberCountCondition = "2";
exports.DMMemberCountCondition = DMMemberCountCondition;

function isDmMemberCountCondition(condition) {
  return condition === "==2" || condition === "2";
}

let ConditionKind;
exports.ConditionKind = ConditionKind;

(function (ConditionKind) {
  ConditionKind["EventMatch"] = "event_match";
  ConditionKind["ContainsDisplayName"] = "contains_display_name";
  ConditionKind["RoomMemberCount"] = "room_member_count";
  ConditionKind["SenderNotificationPermission"] = "sender_notification_permission";
})(ConditionKind || (exports.ConditionKind = ConditionKind = {}));

let PushRuleKind;
exports.PushRuleKind = PushRuleKind;

(function (PushRuleKind) {
  PushRuleKind["Override"] = "override";
  PushRuleKind["ContentSpecific"] = "content";
  PushRuleKind["RoomSpecific"] = "room";
  PushRuleKind["SenderSpecific"] = "sender";
  PushRuleKind["Underride"] = "underride";
})(PushRuleKind || (exports.PushRuleKind = PushRuleKind = {}));

let RuleId;
exports.RuleId = RuleId;

(function (RuleId) {
  RuleId["Master"] = ".m.rule.master";
  RuleId["ContainsDisplayName"] = ".m.rule.contains_display_name";
  RuleId["ContainsUserName"] = ".m.rule.contains_user_name";
  RuleId["AtRoomNotification"] = ".m.rule.roomnotif";
  RuleId["DM"] = ".m.rule.room_one_to_one";
  RuleId["EncryptedDM"] = ".m.rule.encrypted_room_one_to_one";
  RuleId["Message"] = ".m.rule.message";
  RuleId["EncryptedMessage"] = ".m.rule.encrypted";
  RuleId["InviteToSelf"] = ".m.rule.invite_for_me";
  RuleId["MemberEvent"] = ".m.rule.member_event";
  RuleId["IncomingCall"] = ".m.rule.call";
  RuleId["SuppressNotices"] = ".m.rule.suppress_notices";
  RuleId["Tombstone"] = ".m.rule.tombstone";
})(RuleId || (exports.RuleId = RuleId = {}));
/* eslint-enable camelcase */