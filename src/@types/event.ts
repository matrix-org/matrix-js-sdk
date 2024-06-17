/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import { NamespacedValue, UnstableValue } from "../NamespacedValue";
import {
    PolicyRuleEventContent,
    RoomAvatarEventContent,
    RoomCanonicalAliasEventContent,
    RoomCreateEventContent,
    RoomEncryptionEventContent,
    RoomGuestAccessEventContent,
    RoomHistoryVisibilityEventContent,
    RoomJoinRulesEventContent,
    RoomMemberEventContent,
    RoomNameEventContent,
    RoomPinnedEventsEventContent,
    RoomPowerLevelsEventContent,
    RoomServerAclEventContent,
    RoomThirdPartyInviteEventContent,
    RoomTombstoneEventContent,
    RoomTopicEventContent,
    SpaceChildEventContent,
    SpaceParentEventContent,
} from "./state_events";
import {
    ExperimentalGroupCallRoomMemberState,
    IGroupCallRoomMemberState,
    IGroupCallRoomState,
} from "../webrtc/groupCall";
import { MSC3089EventContent } from "../models/MSC3089Branch";
import { M_BEACON, M_BEACON_INFO, MBeaconEventContent, MBeaconInfoEventContent } from "./beacon";
import { XOR } from "./common";
import { ReactionEventContent, RoomMessageEventContent, StickerEventContent } from "./events";
import {
    MCallAnswer,
    MCallBase,
    MCallCandidates,
    MCallHangupReject,
    MCallInviteNegotiate,
    MCallReplacesEvent,
    MCallSelectAnswer,
    SDPStreamMetadata,
    SDPStreamMetadataKey,
} from "../webrtc/callEventTypes";
import { EncryptionKeysEventContent, ICallNotifyContent } from "../matrixrtc/types";
import { M_POLL_END, M_POLL_START, PollEndEventContent, PollStartEventContent } from "./polls";
import { SessionMembershipData } from "../matrixrtc/CallMembership";

export enum EventType {
    // Room state events
    RoomCanonicalAlias = "m.room.canonical_alias",
    RoomCreate = "m.room.create",
    RoomJoinRules = "m.room.join_rules",
    RoomMember = "m.room.member",
    RoomThirdPartyInvite = "m.room.third_party_invite",
    RoomPowerLevels = "m.room.power_levels",
    RoomName = "m.room.name",
    RoomTopic = "m.room.topic",
    RoomAvatar = "m.room.avatar",
    RoomPinnedEvents = "m.room.pinned_events",
    RoomEncryption = "m.room.encryption",
    RoomHistoryVisibility = "m.room.history_visibility",
    RoomGuestAccess = "m.room.guest_access",
    RoomServerAcl = "m.room.server_acl",
    RoomTombstone = "m.room.tombstone",
    RoomPredecessor = "org.matrix.msc3946.room_predecessor",

    // Moderation policy lists
    PolicyRuleUser = "m.policy.rule.user",
    PolicyRuleRoom = "m.policy.rule.room",
    PolicyRuleServer = "m.policy.rule.server",

    SpaceChild = "m.space.child",
    SpaceParent = "m.space.parent",

    // Room timeline events
    RoomRedaction = "m.room.redaction",
    RoomMessage = "m.room.message",
    RoomMessageEncrypted = "m.room.encrypted",
    Sticker = "m.sticker",
    CallInvite = "m.call.invite",
    CallCandidates = "m.call.candidates",
    CallAnswer = "m.call.answer",
    CallHangup = "m.call.hangup",
    CallReject = "m.call.reject",
    CallSelectAnswer = "m.call.select_answer",
    CallNegotiate = "m.call.negotiate",
    CallSDPStreamMetadataChanged = "m.call.sdp_stream_metadata_changed",
    CallSDPStreamMetadataChangedPrefix = "org.matrix.call.sdp_stream_metadata_changed",
    CallReplaces = "m.call.replaces",
    CallAssertedIdentity = "m.call.asserted_identity",
    CallAssertedIdentityPrefix = "org.matrix.call.asserted_identity",
    CallEncryptionKeysPrefix = "io.element.call.encryption_keys",
    KeyVerificationRequest = "m.key.verification.request",
    KeyVerificationStart = "m.key.verification.start",
    KeyVerificationCancel = "m.key.verification.cancel",
    KeyVerificationMac = "m.key.verification.mac",
    KeyVerificationDone = "m.key.verification.done",
    KeyVerificationKey = "m.key.verification.key",
    KeyVerificationAccept = "m.key.verification.accept",
    // Not used directly - see READY_TYPE in VerificationRequest.
    KeyVerificationReady = "m.key.verification.ready",
    // use of this is discouraged https://matrix.org/docs/spec/client_server/r0.6.1#m-room-message-feedback
    RoomMessageFeedback = "m.room.message.feedback",
    Reaction = "m.reaction",
    PollStart = "org.matrix.msc3381.poll.start",

    // Room ephemeral events
    Typing = "m.typing",
    Receipt = "m.receipt",
    Presence = "m.presence",

    // Room account_data events
    FullyRead = "m.fully_read",
    Tag = "m.tag",
    SpaceOrder = "org.matrix.msc3230.space_order", // MSC3230

    // User account_data events
    PushRules = "m.push_rules",
    Direct = "m.direct",
    IgnoredUserList = "m.ignored_user_list",

    // to_device events
    RoomKey = "m.room_key",
    RoomKeyRequest = "m.room_key_request",
    ForwardedRoomKey = "m.forwarded_room_key",
    Dummy = "m.dummy",

    // Group call events
    GroupCallPrefix = "org.matrix.msc3401.call",
    GroupCallMemberPrefix = "org.matrix.msc3401.call.member",

    // MatrixRTC events
    CallNotify = "org.matrix.msc4075.call.notify",
}

export enum RelationType {
    Annotation = "m.annotation",
    Replace = "m.replace",
    Reference = "m.reference",

    // Don't use this yet: it's only the stable version. The code still assumes we support the unstable prefix and,
    // moreover, our tests currently use the unstable prefix. Use THREAD_RELATION_TYPE.name.
    // Once we support *only* the stable prefix, THREAD_RELATION_TYPE can die and we can switch to this.
    Thread = "m.thread",
}

export enum MsgType {
    Text = "m.text",
    Emote = "m.emote",
    Notice = "m.notice",
    Image = "m.image",
    File = "m.file",
    Audio = "m.audio",
    Location = "m.location",
    Video = "m.video",
    KeyVerificationRequest = "m.key.verification.request",
}

export const RoomCreateTypeField = "type";

export enum RoomType {
    Space = "m.space",
    UnstableCall = "org.matrix.msc3417.call",
    ElementVideo = "io.element.video",
}

export const ToDeviceMessageId = "org.matrix.msgid";

/**
 * Identifier for an [MSC3088](https://github.com/matrix-org/matrix-doc/pull/3088)
 * room purpose. Note that this reference is UNSTABLE and subject to breaking changes,
 * including its eventual removal.
 */
export const UNSTABLE_MSC3088_PURPOSE = new UnstableValue("m.room.purpose", "org.matrix.msc3088.purpose");

/**
 * Enabled flag for an [MSC3088](https://github.com/matrix-org/matrix-doc/pull/3088)
 * room purpose. Note that this reference is UNSTABLE and subject to breaking changes,
 * including its eventual removal.
 */
export const UNSTABLE_MSC3088_ENABLED = new UnstableValue("m.enabled", "org.matrix.msc3088.enabled");

/**
 * Subtype for an [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room.
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 */
export const UNSTABLE_MSC3089_TREE_SUBTYPE = new UnstableValue("m.data_tree", "org.matrix.msc3089.data_tree");

/**
 * Leaf type for an event in a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room.
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 */
export const UNSTABLE_MSC3089_LEAF = new UnstableValue("m.leaf", "org.matrix.msc3089.leaf");

/**
 * Branch (Leaf Reference) type for the index approach in a
 * [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room. Note that this reference is
 * UNSTABLE and subject to breaking changes, including its eventual removal.
 */
export const UNSTABLE_MSC3089_BRANCH = new UnstableValue("m.branch", "org.matrix.msc3089.branch");

/**
 * Marker event type to point back at imported historical content in a room. See
 * [MSC2716](https://github.com/matrix-org/matrix-spec-proposals/pull/2716).
 * Note that this reference is UNSTABLE and subject to breaking changes,
 * including its eventual removal.
 */
export const UNSTABLE_MSC2716_MARKER = new UnstableValue("m.room.marker", "org.matrix.msc2716.marker");

/**
 * Name of the request property for relation based redactions.
 * {@link https://github.com/matrix-org/matrix-spec-proposals/pull/3912}
 */
export const MSC3912_RELATION_BASED_REDACTIONS_PROP = new UnstableValue(
    "with_rel_types",
    "org.matrix.msc3912.with_relations",
);

/**
 * Functional members type for declaring a purpose of room members (e.g. helpful bots).
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 *
 * Schema (TypeScript):
 * ```
 * {
 *   service_members?: string[]
 * }
 * ```
 *
 * @example
 * ```
 * {
 *   "service_members": [
 *     "@helperbot:localhost",
 *     "@reminderbot:alice.tdl"
 *   ]
 * }
 * ```
 */
export const UNSTABLE_ELEMENT_FUNCTIONAL_USERS = new UnstableValue(
    "io.element.functional_members",
    "io.element.functional_members",
);

/**
 * A type of message that affects visibility of a message,
 * as per https://github.com/matrix-org/matrix-doc/pull/3531
 *
 * @experimental
 */
export const EVENT_VISIBILITY_CHANGE_TYPE = new UnstableValue("m.visibility", "org.matrix.msc3531.visibility");

/**
 * https://github.com/matrix-org/matrix-doc/pull/3881
 *
 * @experimental
 */
export const PUSHER_ENABLED = new UnstableValue("enabled", "org.matrix.msc3881.enabled");

/**
 * https://github.com/matrix-org/matrix-doc/pull/3881
 *
 * @experimental
 */
export const PUSHER_DEVICE_ID = new UnstableValue("device_id", "org.matrix.msc3881.device_id");

/**
 * https://github.com/matrix-org/matrix-doc/pull/3890
 *
 * @experimental
 */
export const LOCAL_NOTIFICATION_SETTINGS_PREFIX = new UnstableValue(
    "m.local_notification_settings",
    "org.matrix.msc3890.local_notification_settings",
);

/**
 * https://github.com/matrix-org/matrix-doc/pull/4023
 *
 * @experimental
 */
export const UNSIGNED_THREAD_ID_FIELD = new UnstableValue("thread_id", "org.matrix.msc4023.thread_id");

/**
 * https://github.com/matrix-org/matrix-spec-proposals/pull/4115
 *
 * @experimental
 */
export const UNSIGNED_MEMBERSHIP_FIELD = new NamespacedValue("membership", "io.element.msc4115.membership");

/**
 * Mapped type from event type to content type for all specified non-state room events.
 */
export interface TimelineEvents {
    [EventType.RoomMessage]: RoomMessageEventContent;
    [EventType.Sticker]: StickerEventContent;
    [EventType.Reaction]: ReactionEventContent;
    [EventType.CallReplaces]: MCallReplacesEvent;
    [EventType.CallAnswer]: MCallAnswer;
    [EventType.CallSelectAnswer]: MCallSelectAnswer;
    [EventType.CallNegotiate]: Omit<MCallInviteNegotiate, "offer">;
    [EventType.CallInvite]: MCallInviteNegotiate;
    [EventType.CallCandidates]: MCallCandidates;
    [EventType.CallHangup]: MCallHangupReject;
    [EventType.CallReject]: MCallHangupReject;
    [EventType.CallSDPStreamMetadataChangedPrefix]: MCallBase & { [SDPStreamMetadataKey]: SDPStreamMetadata };
    [EventType.CallEncryptionKeysPrefix]: EncryptionKeysEventContent;
    [EventType.CallNotify]: ICallNotifyContent;
    [M_BEACON.name]: MBeaconEventContent;
    [M_POLL_START.name]: PollStartEventContent;
    [M_POLL_END.name]: PollEndEventContent;
}

/**
 * Mapped type from event type to content type for all specified room state events.
 */
export interface StateEvents {
    [EventType.RoomCanonicalAlias]: RoomCanonicalAliasEventContent;
    [EventType.RoomCreate]: RoomCreateEventContent;
    [EventType.RoomJoinRules]: RoomJoinRulesEventContent;
    [EventType.RoomMember]: RoomMemberEventContent;
    // XXX: Spec says this event has 3 required fields but kicking such an invitation requires sending `{}`
    [EventType.RoomThirdPartyInvite]: XOR<RoomThirdPartyInviteEventContent, {}>;
    [EventType.RoomPowerLevels]: RoomPowerLevelsEventContent;
    [EventType.RoomName]: RoomNameEventContent;
    [EventType.RoomTopic]: RoomTopicEventContent;
    [EventType.RoomAvatar]: RoomAvatarEventContent;
    [EventType.RoomPinnedEvents]: RoomPinnedEventsEventContent;
    [EventType.RoomEncryption]: RoomEncryptionEventContent;
    [EventType.RoomHistoryVisibility]: RoomHistoryVisibilityEventContent;
    [EventType.RoomGuestAccess]: RoomGuestAccessEventContent;
    [EventType.RoomServerAcl]: RoomServerAclEventContent;
    [EventType.RoomTombstone]: RoomTombstoneEventContent;
    [EventType.SpaceChild]: SpaceChildEventContent;
    [EventType.SpaceParent]: SpaceParentEventContent;

    [EventType.PolicyRuleUser]: XOR<PolicyRuleEventContent, {}>;
    [EventType.PolicyRuleRoom]: XOR<PolicyRuleEventContent, {}>;
    [EventType.PolicyRuleServer]: XOR<PolicyRuleEventContent, {}>;

    // MSC3401
    [EventType.GroupCallPrefix]: IGroupCallRoomState;
    [EventType.GroupCallMemberPrefix]: XOR<
        XOR<IGroupCallRoomMemberState, ExperimentalGroupCallRoomMemberState>,
        XOR<SessionMembershipData, {}>
    >;

    // MSC3089
    [UNSTABLE_MSC3089_BRANCH.name]: MSC3089EventContent;

    // MSC3672
    [M_BEACON_INFO.name]: MBeaconInfoEventContent;
}
