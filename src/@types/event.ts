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
    RoomServerAcl = "m.room_server_acl",
    RoomTombstone = "m.room.tombstone",
    /**
     * @deprecated Should not be used.
     */
    RoomAliases = "m.room.aliases", // deprecated https://matrix.org/docs/spec/client_server/r0.6.1#historical-events

    // Room timeline events
    RoomRedaction = "m.room.redaction",
    RoomMessage = "m.room.message",
    RoomMessageEncrypted = "m.room.encrypted",
    Sticker = "m.sticker",
    CallInvite = "m.call.invite",
    CallCandidates = "m.call.candidates",
    CallAnswer = "m.call.answer",
    CallHangup = "m.call.hangup",
    KeyVerificationRequest = "m.key.verification.request",
    KeyVerificationStart = "m.key.verification.start",
    KeyVerificationCancel = "m.key.verification.cancel",
    KeyVerificationMac = "m.key.verification.mac",
    // use of this is discouraged https://matrix.org/docs/spec/client_server/r0.6.1#m-room-message-feedback
    RoomMessageFeedback = "m.room.message.feedback",

    // Room ephemeral events
    Typing = "m.typing",
    Receipt = "m.receipt",
    Presence = "m.presence",

    // Room account_data events
    FullyRead = "m.fully_read",
    Tag = "m.tag",

    // User account_data events
    PushRules = "m.push_rules",
    Direct = "m.direct",
    IgnoredUserList = "m.ignored_user_list",

    // to_device events
    RoomKey = "m.room_key",
    RoomKeyRequest = "m.room_key_request",
    ForwardedRoomKey = "m.forwarded_room_key",
    Dummy = "m.dummy",
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
}
