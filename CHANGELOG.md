Changes in 0.1.2
================

New features:
 * Added `EventStatus.QUEUED` which is set on an event when it is waiting to be
   sent by the scheduler and there are other events in front.

New methods:
 * `MatrixScheduler.getQueueForEvent(event)`
 * `MatrixScheduler.removeEventFromQueue(event)`
 * `RoomMember.getAvatarUrl()`
 * `$DATA_STORE.setSyncToken(token)`
 * `$DATA_STORE.getSyncToken()`

Bug fixes:
 * Fixed an issue which prevented RoomMember.name being disambiguated if there
   was exactly 1 other person with the same display name.

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
