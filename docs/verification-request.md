# Verification requests

## VerificationRequest

VerificationRequest is that class responsible for transitioning between the various phases that a verification request can be in. This is both for self-verification over to-device messages, as for verification of other users over in-room messages. It also creates the verifier object (depending on the chosen method) once the .start event is received.

## Channels

As mentioned, VerificationRequest handles requests for both in-room as to-device events. The differences between both have been factored out into `InRoomChannel` and `ToDeviceChannel` although there are some flag properties on those with the logic checking them being in VerificationRequest or the verifier.

The main differences between both kinds of requests are:

 - in-room requests support being "historical", request that have concluded and/or were conducted more than 10 minutes ago. They should be persisted over reloads, but they should only observe the request for displaying. No events should be sent in it.
 - in-room requests are assumed to be between two users, to-device can be between the same user on different devices.
 - .request and .ready events are optional for `ToDeviceChannel` (proposal to remove this difference and make these events mandatory for to-device as well).
 - in-room requests send a .done event when they finish. to-device requests don't. This is needed to show a "You have verified X" tile in the timeline when finishing.
 - to-device requests don't have remote echo, so this is "faked" when sending a message through `ToDeviceChannel`
 - in-room requests are visible to all devices of the targeted user, so we have to check explicitly if we're still a party in the request or should rather just observe. In a to-device request, the initiating party sends a .cancel to all but the responding device.
 - some minor differences:
    - transaction id comes from a different place
    - the timestamp comes from a different place
    - .request gets sent as a `m.room.message` for in room (to have something to show on non-crosssigning clients)

## Validation

Each event is being validated before adding it to the request. Channels each do their specific validating and then delegate for the common part to the same static method in the VerificationRequest. This check is mainly checking whether the event is of the correct type and has all the needed fields of the right data type.

If validation passes, the event is passed to handle it to the channel, which will do some limited state changes specific to the channel, and then delegate the handling to the VerificationRequest.

## Remote echo

The verification state machine is updated only with events that have been sent already (e.g. from the server or local cache) because we don't need to undo it when sending fails, and it makes it easier to receive events out of order (needed for historical events)

we do have some local state for:
 - ...

## Phase transitions

```
                      +--------+
                      | UNSENT |
                      +--------+
                          | receive .request
                          v
                    +-----------+
      /-------------| REQUESTED |
      | cancels     +-----------+
      | if .ready is      | receive .ready (from `to` in .request event)
      | not recv in 10min v
      |               +-------+
      +---------------| READY | (establish commonly supported methods, and show corresponding verification methods in UI)
      |               +-------+
      |                   | receive .start (from either party)
      |                   | (not the case for QR codes AFAIK)
      |                   v
      |              +---------+
      +--------------| STARTED | (transitioning to this phases will create the verifier)
      |              +---------+
      |                   | being notified by verifier that verification was succesful
      |                   | OR
      |                   | receive own .done event
      v                   v
+-----------+         +------+
| CANCELLED |         | DONE |
+-----------+         +------+
 when receiving a
 .cancel event from
 either party
```

### State machine

In any order because of historical events

## Verifier



## QR codes

QR codes are a bit different. We just show a QR code from riot-web and don't scan it.
I know ReciprocateQRCode is involved, but not sure how it is initiated.
Is a .start event with that method sent after scanning perhaps?
