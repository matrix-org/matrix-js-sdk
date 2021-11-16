import { UnstableValue } from "../NamespacedValue";
export declare enum EventType {
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
    /**
     * @deprecated Should not be used.
     */
    RoomAliases = "m.room.aliases",
    SpaceChild = "m.space.child",
    SpaceParent = "m.space.parent",
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
    KeyVerificationRequest = "m.key.verification.request",
    KeyVerificationStart = "m.key.verification.start",
    KeyVerificationCancel = "m.key.verification.cancel",
    KeyVerificationMac = "m.key.verification.mac",
    KeyVerificationDone = "m.key.verification.done",
    RoomMessageFeedback = "m.room.message.feedback",
    Reaction = "m.reaction",
    Typing = "m.typing",
    Receipt = "m.receipt",
    Presence = "m.presence",
    FullyRead = "m.fully_read",
    Tag = "m.tag",
    SpaceOrder = "org.matrix.msc3230.space_order",
    PushRules = "m.push_rules",
    Direct = "m.direct",
    IgnoredUserList = "m.ignored_user_list",
    RoomKey = "m.room_key",
    RoomKeyRequest = "m.room_key_request",
    ForwardedRoomKey = "m.forwarded_room_key",
    Dummy = "m.dummy"
}
export declare enum RelationType {
    Annotation = "m.annotation",
    Replace = "m.replace",
    /**
     * Note, "io.element.thread" is hardcoded
     * Should be replaced with "m.thread" once MSC3440 lands
     * Can not use `UnstableValue` as TypeScript does not
     * allow computed values in enums
     * https://github.com/microsoft/TypeScript/issues/27976
     */
    Thread = "io.element.thread"
}
export declare enum MsgType {
    Text = "m.text",
    Emote = "m.emote",
    Notice = "m.notice",
    Image = "m.image",
    File = "m.file",
    Audio = "m.audio",
    Location = "m.location",
    Video = "m.video"
}
export declare const RoomCreateTypeField = "type";
export declare enum RoomType {
    Space = "m.space"
}
/**
 * Identifier for an [MSC3088](https://github.com/matrix-org/matrix-doc/pull/3088)
 * room purpose. Note that this reference is UNSTABLE and subject to breaking changes,
 * including its eventual removal.
 */
export declare const UNSTABLE_MSC3088_PURPOSE: UnstableValue<"m.room.purpose", "org.matrix.msc3088.purpose">;
/**
 * Enabled flag for an [MSC3088](https://github.com/matrix-org/matrix-doc/pull/3088)
 * room purpose. Note that this reference is UNSTABLE and subject to breaking changes,
 * including its eventual removal.
 */
export declare const UNSTABLE_MSC3088_ENABLED: UnstableValue<"m.enabled", "org.matrix.msc3088.enabled">;
/**
 * Subtype for an [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room.
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 */
export declare const UNSTABLE_MSC3089_TREE_SUBTYPE: UnstableValue<"m.data_tree", "org.matrix.msc3089.data_tree">;
/**
 * Leaf type for an event in a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room.
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 */
export declare const UNSTABLE_MSC3089_LEAF: UnstableValue<"m.leaf", "org.matrix.msc3089.leaf">;
/**
 * Branch (Leaf Reference) type for the index approach in a
 * [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) space-room. Note that this reference is
 * UNSTABLE and subject to breaking changes, including its eventual removal.
 */
export declare const UNSTABLE_MSC3089_BRANCH: UnstableValue<"m.branch", "org.matrix.msc3089.branch">;
/**
 * Functional members type for declaring a purpose of room members (e.g. helpful bots).
 * Note that this reference is UNSTABLE and subject to breaking changes, including its
 * eventual removal.
 *
 * Schema (TypeScript):
 * {
 *   service_members?: string[]
 * }
 *
 * Example:
 * {
 *   "service_members": [
 *     "@helperbot:localhost",
 *     "@reminderbot:alice.tdl"
 *   ]
 * }
 */
export declare const UNSTABLE_ELEMENT_FUNCTIONAL_USERS: UnstableValue<"io.element.functional_members", "io.element.functional_members">;
export interface IEncryptedFile {
    url: string;
    mimetype?: string;
    key: {
        alg: string;
        key_ops: string[];
        kty: string;
        k: string;
        ext: boolean;
    };
    iv: string;
    hashes: {
        [alg: string]: string;
    };
    v: string;
}
//# sourceMappingURL=event.d.ts.map