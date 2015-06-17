Changes in 0.1.1
================

Breaking changes:
 * `Room.calculateRoomName` is now private. Use `Room.recalculate` instead, and
   access the calculated name via `Room.name`.

New properties:
 * `User.events`
 * `RoomMember.events`

New features:
 * Local echo. When you send an event using the SDK it will immediately be
  added to the timeline with the event.status of `'sending'`. When the event is
  finally sent, this status will be removed.
