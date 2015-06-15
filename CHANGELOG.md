Changes in 0.1.1
================

Breaking changes:
 * `Room.calculateRoomName` is now private. Use `Room.recalculate` instead, and
   access the calculated name via `Room.name`.

New properties:
 * `User.events`
 * `RoomMember.events`
