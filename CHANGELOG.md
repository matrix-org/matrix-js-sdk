Changes in 0.3.0
================

**BREAKING CHANGES**:
 * `RoomMember.getAvatarUrl()` and `MatrixClient.mxcUrlToHttp()` now return the
    empty string when given anything other than an mxc:// URL. This ensures that
    clients never inadvertantly reference content directly, leaking information
    to third party servers. Tne allowDirectLinks option is provided if the client
    wants to allow such links.
 * `MatrixClient.getAvatarUrlForMember` has been removed and replaced with
   `RoomMember.getAvatarUrl`. Arguments remain the same except the homeserver
   URL must now be supplied from `MatrixClient.getHomeserverUrl()`.

   ```javascript
   // before
   var url = client.getAvatarUrlForMember(member, width, height, resize, allowDefault)
   // after
   var url = member.getAvatarUrl(client.getHomeserverUrl(), width, height, resize, allowDefault)
   ```
 * `MatrixClient.getAvatarUrlForRoom` has been removed and replaced with
   `Room.getAvatarUrl`. Arguments remain the same except the homeserver
   URL must now be supplied from `MatrixClient.getHomeserverUrl()`.

   ```javascript
   // before
   var url = client.getAvatarUrlForRoom(room, width, height, resize, allowDefault)
   // after
   var url = room.getAvatarUrl(client.getHomeserverUrl(), width, height, resize, allowDefault)
   ```

 * `s/Room.getMembersWithMemership/Room.getMembersWithMem`b`ership/g`

New methods:
 * Added support for sending receipts via
   `MatrixClient.sendReceipt(event, receiptType, callback)` and
   `MatrixClient.sendReadReceipt(event, callback)`.
 * Added support for receiving receipts via
   `Room.getReceiptsForEvent(event)` and `Room.getUsersReadUpTo(event)`. Receipts
   can be directly added to a `Room` using `Room.addReceipt(event)` though the
   `MatrixClient` does this for you.
 * Added support for muting local video and audio via the new methods
   `MatrixCall.setMicrophoneMuted()`, `MatrixCall.isMicrophoneMuted(muted)`,
   `MatrixCall.isLocalVideoMuted()` and `Matrix.setLocalVideoMuted(muted)`.
 * Added **experimental** support for screen-sharing in Chrome via
   `MatrixCall.placeScreenSharingCall(remoteVideoElement, localVideoElement)`.
 * Added ability to perform server-side searches using
   `MatrixClient.searchMessageText(opts)` and `MatrixClient.search(opts)`.

Improvements:
 * Improve the performance of initial sync processing from `O(n^2)` to `O(n)`.
 * `Room.name` will now take into account `m.room.canonical_alias` events.
 * `MatrixClient.startClient` now takes an Object `opts` rather than a Number in
   a backwards-compatible way. This `opts` allows syncing configuration options
   to be specified including `includeArchivedRooms` and `resolveInvitesToProfiles`.
 * `Room` objects which represent room invitations will now have state populated
   from `invite_room_state` if it is included in the `m.room.member` event.
 * `Room.getAvatarUrl` will now take into account `m.room.avatar` events.

Changes in 0.2.2
================

Bug fixes:
 * Null pointer fixes for VoIP calling and push notification processing.
 * Set the `Content-Type` to `application/octet-stream` in the event that the
   file object has no `type`.

New methods:
 * Added `MatrixClient.getCasServer()` which calls through to the HTTP endpoint
   `/login/cas`.
 * Added `MatrixClient.loginWithCas(ticket, service)` which logs in with the
   type `m.login.cas`.
 * Added `MatrixClient.getHomeserverUrl()` which returns the URL passed in the
   constructor.
 * Added `MatrixClient.getIdentityServerUrl()` which returns the URL passed in
   the constructor.
 * Added `getLastModifiedTime()` to `RoomMember`, `RoomState` and `User` objects.
   This makes it easier to see if the object in question has changed, which can
   be used to improve performance by only rendering when these objects change.

Changes in 0.2.1
================

**BREAKING CHANGES**
 * `MatrixClient.joinRoom` has changed from `(roomIdOrAlias, callback)` to
   `(roomIdOrAlias, opts, callback)`.

Bug fixes:
 * The `Content-Type` of file uploads is now explicitly set, without relying
   on the browser to do it for us.

Improvements:
 * The `MatrixScheduler.RETRY_BACKOFF_RATELIMIT` function will not retry when
   the response is a 400,401,403.
 * The text returned from a room invite now includes who the invite was from.
 * There is now a try/catch block around the `request` function which will
   reject/errback appropriately if an exception is thrown synchronously in it.

New methods:
 * `MatrixClient.createAlias(alias, roomId)`
 * `MatrixClient.getRoomIdForAlias(alias)`
 * `MatrixClient.sendNotice(roomId, body, txnId, callback)`
 * `MatrixClient.sendHtmlNotice(roomId, body, htmlBody, callback)`

Modified methods:
 * `MatrixClient.joinRoom(roomIdOrAlias, opts)` where `opts` can include a
   `syncRoom: true|false` flag to control whether a room initial sync is
   performed after joining the room.
 * `MatrixClient.getAvatarUrlForMember` has a new last arg `allowDefault` which
   returns the default identicon URL if `true`.
 * `MatrixClient.getAvatarUrlForRoom` has a new last arg `allowDefault` which
   is passed through to the default identicon generation for
   `getAvatarUrlForMember`.


Changes in 0.2.0
================

**BREAKING CHANGES**:
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
 * `Room.getMembersWithMembership(membership)`
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

**BREAKING CHANGES**:
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
