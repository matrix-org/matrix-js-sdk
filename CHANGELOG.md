Changes in [0.5.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.1) (2016-03-30)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.0...v0.5.1)

 * Only count joined members for the member count in notifications.
   [\#119](https://github.com/matrix-org/matrix-js-sdk/pull/119)
 * Add maySendEvent to match maySendStateEvent
   [\#118](https://github.com/matrix-org/matrix-js-sdk/pull/118)

Changes in [0.5.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.0) (2016-03-22)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.4.2...v0.5.0)

**BREAKING CHANGES**:
 * `opts.pendingEventOrdering`==`end` is no longer supported in the arguments to
   `MatrixClient.startClient()`. Instead we provide a `detached` option, which
   puts pending events into a completely separate list in the Room, accessible
   via `Room.getPendingEvents()`.
   [\#111](https://github.com/matrix-org/matrix-js-sdk/pull/111)

Other improvements:
 * Log the stack when we get a sync error
   [\#109](https://github.com/matrix-org/matrix-js-sdk/pull/109)
 * Refactor transmitted-messages code
   [\#110](https://github.com/matrix-org/matrix-js-sdk/pull/110)
 * Add a method to the js sdk to look up 3pids on the ID server.
   [\#113](https://github.com/matrix-org/matrix-js-sdk/pull/113)
 * Support for cancelling pending events
   [\#112](https://github.com/matrix-org/matrix-js-sdk/pull/112)
 * API to stop peeking
   [\#114](https://github.com/matrix-org/matrix-js-sdk/pull/114)
 * update store user metadata based on membership events rather than presence
   [\#116](https://github.com/matrix-org/matrix-js-sdk/pull/116)
 * Include a counter in generated transaction IDs
   [\#115](https://github.com/matrix-org/matrix-js-sdk/pull/115)
 * get/setRoomVisibility API
   [\#117](https://github.com/matrix-org/matrix-js-sdk/pull/117)

Changes in [0.4.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.4.2) (2016-03-17)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.4.1...v0.4.2)

 * Try again if a pagination request gives us no new messages
   [\#98](https://github.com/matrix-org/matrix-js-sdk/pull/98)
 * Add a delay before we start polling the connectivity check endpoint
   [\#99](https://github.com/matrix-org/matrix-js-sdk/pull/99)
 * Clean up a codepath that was only used for crypto messages
   [\#101](https://github.com/matrix-org/matrix-js-sdk/pull/101)
 * Add maySendStateEvent method, ported from react-sdk (but fixed).
   [\#94](https://github.com/matrix-org/matrix-js-sdk/pull/94)
 * Add Session.logged_out event
   [\#100](https://github.com/matrix-org/matrix-js-sdk/pull/100)
 * make presence work when peeking.
   [\#103](https://github.com/matrix-org/matrix-js-sdk/pull/103)
 * Add RoomState.mayClientSendStateEvent()
   [\#104](https://github.com/matrix-org/matrix-js-sdk/pull/104)
 * Fix displaynames for member join events
   [\#108](https://github.com/matrix-org/matrix-js-sdk/pull/108)

Changes in 0.4.1
================

Improvements:
 * Check that `/sync` filters are correct before reusing them, and recreate
   them if not (https://github.com/matrix-org/matrix-js-sdk/pull/85).
 * Fire a `Room.timelineReset` event when a room's timeline is reset by a gappy
   `/sync` (https://github.com/matrix-org/matrix-js-sdk/pull/87,
   https://github.com/matrix-org/matrix-js-sdk/pull/93).
 * Make `TimelineWindow.load()` faster in the simple case of loading the live
   timeline (https://github.com/matrix-org/matrix-js-sdk/pull/88).
 * Update room-name calculation code to use the name of the sender of the
   invite when invited to a room
   (https://github.com/matrix-org/matrix-js-sdk/pull/89).
 * Don't reset the timeline when we join a room after peeking into it
   (https://github.com/matrix-org/matrix-js-sdk/pull/91).
 * Fire `Room.localEchoUpdated` events as local echoes progress through their
   transmission process (https://github.com/matrix-org/matrix-js-sdk/pull/95,
   https://github.com/matrix-org/matrix-js-sdk/pull/97).
 * Avoid getting stuck in a pagination loop when the server sends us only
   messages we've already seen
   (https://github.com/matrix-org/matrix-js-sdk/pull/96).
   
New methods:
 * Add `MatrixClient.setPushRuleActions` to set the actions for a push
   notification rule (https://github.com/matrix-org/matrix-js-sdk/pull/90)
 * Add `RoomState.maySendStateEvent` which determines if a given user has
   permission to send a state event
   (https://github.com/matrix-org/matrix-js-sdk/pull/94)

Changes in 0.4.0
================

**BREAKING CHANGES**:
 * `RoomMember.getAvatarUrl()` and `MatrixClient.mxcUrlToHttp()` now return the
    empty string when given anything other than an mxc:// URL. This ensures that
    clients never inadvertantly reference content directly, leaking information
    to third party servers. The `allowDirectLinks` option is provided if the client
    wants to allow such links.
 * Add a 'bindEmail' option to register()

Improvements:
 * Support third party invites
 * More appropriate naming for third party invite rooms
 * Poll the 'versions' endpoint to re-establish connectivity
 * Catch exceptions when syncing
 * Room tag support
 * Generate implicit read receipts
 * Support CAS login
 * Guest access support
 * Never return non-mxc URLs by default
 * Ability to cancel file uploads
 * Use the Matrix C/S API v2 with r0 prefix
 * Account data support
 * Support non-contiguous event timelines
 * Support new unread counts
 * Local echo for read-receipts


New methods:
 * Add method to fetch URLs not on the home or identity server
 * Method to get the last receipt for a user
 * Method to get all known users
 * Method to delete an alias


Changes in 0.3.0
================

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
