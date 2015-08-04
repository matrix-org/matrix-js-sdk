Changes in 0.2.1
================

Breaking changes:
 * `MatrixClient.joinRoom` has changed from `(roomIdOrAlias, callback)` to
   `(roomIdOrAlias, opts, callback)`.

New methods:
 * `MatrixClient.createAlias(alias, roomId)`
 * `MatrixClient.getRoomIdForAlias(alias)`
 * `MatrixClient.sendNotice(roomId, body, txnId, callback)`
 * `MatrixClient.sendHtmlNotice(roomId, body, htmlBody, callback)`

Changes in 0.2.0
================

Breaking changes:
 * `MatrixClient.setPowerLevel` now expects a `MatrixEvent` and not an `Object`
   for the `event` parameter.

New features:
 * Added `EventStatus.QUEUED` which is set on an event when it is waiting to be
   sent by the scheduler and there are other events in front.
 * Added support for processing push rules on an event. This can be obtained by
   calling `MatrixClient.getPushActionsForEvent(event)`.
 * Added WebRTC support. Outbound calls can be made via
   `call = global.createNewMatrixCall(MatrixClient, roomId)` followed by
   `call.placeVoiceCall()` or `call.placeVideoCall(remoteEle, localEle)`.
   Inbound calls will be received via the event `"Call.incoming"` which provides
   a call object which can be followed with `call.answer()` or `call.hangup()`.
 * Added the ability to upload files to the media repository.
 * Added the ability to change the client's password.
 * Added the ability to register with an email via an identity server.
 * Handle presence events by updating the associated `User` object.
 * Handle redaction events.
 * Added infrastructure for supporting End-to-End encryption. E2E is *NOT*
   available in this version.

New methods:
 * `MatrixClient.getUser(userId)`
 * `MatrixClient.getPushActionsForEvent(event)`
 * `MatrixClient.setPassword(auth, newPassword)`
 * `MatrixClient.loginWithSAML2(relayState, callback)`
 * `MatrixClient.getAvatarUrlForMember(member, w, h, method)`
 * `MatrixClient.mxcUrlToHttp(url, w, h, method)`
 * `MatrixClient.getAvatarUrlForRoom(room, w, h, method)`
 * `MatrixClient.uploadContent(file, callback)`
 * `Room.getMembersWithMemership(membership)`
 * `MatrixScheduler.getQueueForEvent(event)`
 * `MatrixScheduler.removeEventFromQueue(event)`
 * `$DATA_STORE.setSyncToken(token)`
 * `$DATA_STORE.getSyncToken()`

Crypto infrastructure (crypto is *NOT* available in this version):
 * `global.CRYPTO_ENABLED`
 * `MatrixClient.isCryptoEnabled()`
 * `MatrixClient.uploadKeys(maxKeys)`
 * `MatrixClient.downloadKeys(userIds, forceDownload)`
 * `MatrixClient.listDeviceKeys(userId)`
 * `MatrixClient.setRoomEncryption(roomId, config)`
 * `MatrixClient.isRoomEncrypted(roomId)`

New classes:
 * `MatrixCall`
 * `WebStorageStore` - *WIP; unstable*
 * `WebStorageSessionStore` - *WIP; unstable*

Bug fixes:
 * Member name bugfix: Fixed an issue which prevented `RoomMember.name` being
   disambiguated if there was exactly 1 other person with the same display name.
 * Member name bugfix: Disambiguate both clashing display names with user IDs in
   the event of a clash.
 * Room state bugfix: Fixed a bug which incorrectly overwrote power levels
   locally for a room.
 * Room name bugfix: Ignore users who have left the room when determining a room
   name.
 * Events bugfix: Fixed a bug which prevented the `sender` and `target`
   properties from being set.

Changes in 0.1.1
================

Breaking changes:
 * `Room.calculateRoomName` is now private. Use `Room.recalculate` instead, and
   access the calculated name via `Room.name`.
 * `new MatrixClient(...)` no longer creates a `MatrixInMemoryStore` if
   `opts.store` is not specified. Instead, the `createClient` global function
   creates it and passes it to the constructor. This change will not affect
   users who have always used `createClient` to create a `MatrixClient`.
 * `"Room"` events will now be emitted when the Room has *finished* being
   populated with state rather than at the moment of creation. This will fire
   when the SDK encounters a room it doesn't know about (just arrived from the
   event stream; e.g. a room invite) and will also fire after syncing room
   state (e.g. after calling joinRoom).
 * `MatrixClient.joinRoom` now returns a `Room` object when resolved, not an
   object with a `room_id` property.
 * `MatrixClient.scrollback` now expects a `Room` arg instead of a `room_id`
   and `from` token. Construct a `new Room(roomId)` if you want to continue
   using this directly, then set the pagination token using
   `room.oldState.paginationToken = from`. It now resolves to a `Room` object
   instead of the raw HTTP response.

New properties:
 * `User.events`
 * `RoomMember.events`

New methods:
 * `Room.hasMembershipState(userId, membership)`
 * `MatrixClient.resendEvent(event, room)`

New features:
 * Local echo. When you send an event using the SDK it will immediately be
   added to `Room.timeline` with the `event.status` of `EventStatus.SENDING`.
   When the event is finally sent, this status will be removed.
 * Not sent status. When an event fails to send using the SDK, it will have the
   `event.status` of `EventStatus.NOT_SENT`.
 * Retries. If events fail to send, they will be automatically retried.
 * Manual resending. Events which failed to send can be passed to
   `MatrixClient.resendEvent(event, room)` to resend them.
 * Queueing. Messages sent in quick succession will be queued to preserve the
   order in which they were submitted.
 * Room state is automatcally synchronised when joining a room (including if
   another device joins a room).
 * Scrollback. You can request earlier events in a room using
   `MatrixClient.scrollback(room, limit, callback)`.

Bug fixes:
 * Fixed a bug which prevented the event stream from polling. Some devices will
   black hole requests when they hibernate, meaning that the callbacks will
   never fire. We now maintain a local timer to forcibly restart the request.
