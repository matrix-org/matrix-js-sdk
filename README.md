Matrix Javascript SDK
=====================
[![Build Status](http://matrix.org/jenkins/buildStatus/icon?job=JavascriptSDK)](http://matrix.org/jenkins/job/JavascriptSDK/)

This is the [Matrix](https://matrix.org) Client-Server v1/v2 alpha SDK for
JavaScript. This SDK can be run in a browser or in Node.js.

Quickstart
==========

In a browser
------------
Download either the full or minified version from
https://github.com/matrix-org/matrix-js-sdk/releases/latest and add that as a
``<script>`` to your page. There will be a global variable ``matrixcs``
attached to ``window`` through which you can access the SDK.

Please check [the working browser example](examples/browser) for more information.

In Node.js
----------

``npm install matrix-js-sdk``

```javascript
  var sdk = require("matrix-js-sdk");
  var client = sdk.createClient("https://matrix.org");
  client.publicRooms(function(err, data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
  });
```

Please check [the Node.js terminal app](examples/node) for a more complex example.

What does this SDK do?
----------------------

This SDK provides a full object model around the Matrix Client-Server API and emits
events for incoming data and state changes. Aside from wrapping the HTTP API, it:
 - Handles syncing (via `/initialSync` and `/events`)
 - Handles the generation of "friendly" room and member names.
 - Handles historical `RoomMember` information (e.g. display names).
 - Manages room member state across multiple events (e.g. it handles typing, power
   levels and membership changes).
 - Exposes high-level objects like `Rooms`, `RoomState`, `RoomMembers` and `Users`
   which can be listened to for things like name changes, new messages, membership
   changes, presence changes, and more.
 - Handle "local echo" of messages sent using the SDK. This means that messages
   that have just been sent will appear in the timeline as 'sending', until it
   completes. This is beneficial because it prevents there being a gap between
   hitting the send button and having the "remote echo" arrive.
 - Mark messages which failed to send as not sent.
 - Automatically retry requests to send messages due to network errors.
 - Automatically retry requests to send messages due to rate limiting errors.
 - Handle queueing of messages.
 - Handles pagination.
 - Handle assigning push actions for events.
 - Handles room initial sync on accepting invites.
 - Handles WebRTC calling.

Later versions of the SDK will:
 - Expose a `RoomSummary` which would be suitable for a recents page.
 - Provide different pluggable storage layers (e.g. local storage, database-backed)

Usage
=====

Conventions
-----------

### Emitted events

The SDK will emit events using an ``EventEmitter``. It also
emits object models (e.g. ``Rooms``, ``RoomMembers``) when they
are updated.

```javascript
  // Listen for low-level MatrixEvents
  client.on("event", function(event) {
    console.log(event.getType());
  });

  // Listen for typing changes
  client.on("RoomMember.typing", function(event, member) {
    if (member.typing) {
      console.log(member.name + " is typing...");
    }
    else {
      console.log(member.name + " stopped typing.");
    }
  });

  // start the client to setup the connection to the server
  client.startClient();
```

### Promises and Callbacks

Most of the methods in the SDK are asynchronous: they do not directly return a
result, but instead return a [Promise](http://documentup.com/kriskowal/q/)
which will be fulfilled in the future.

The typical usage is something like:

```javascript
  matrixClient.someMethod(arg1, arg2).done(function(result) {
    ...
  });
```

Alternatively, if you have a Node.js-style ``callback(err, result)`` function,
you can pass the result of the promise into it with something like:

```javascript
  matrixClient.someMethod(arg1, arg2).nodeify(callback);
```

The main thing to note is that it is an error to discard the result of a
promise-returning function, as that will cause exceptions to go unobserved. If
you have nothing better to do with the result, just call ``.done()`` on it. See
http://documentup.com/kriskowal/q/#the-end for more information.

Methods which return a promise show this in their documentation.

Many methods in the SDK support *both* Node.js-style callbacks *and* Promises,
via an optional ``callback`` argument. The callback support is now deprecated:
new methods do not include a ``callback`` argument, and in the future it may be
removed from existing methods.

Examples
--------
This section provides some useful code snippets which demonstrate the
core functionality of the SDK. These examples assume the SDK is setup like this:

```javascript
   var sdk = require("matrix-js-sdk");
   var myUserId = "@example:localhost";
   var myAccessToken = "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
   var matrixClient = sdk.createClient({
       baseUrl: "http://localhost:8008",
       accessToken: myAccessToken,
       userId: myUserId
   });
```

### Automatically join rooms when invited

```javascript
   matrixClient.on("RoomMember.membership", function(event, member) {
       if (member.membership === "invite" && member.userId === myUserId) {
           matrixClient.joinRoom(member.roomId).done(function() {
               console.log("Auto-joined %s", member.roomId);
           });
       }
   });

   matrixClient.startClient();
```

### Print out messages for all rooms

```javascript
   matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline) {
       if (toStartOfTimeline) {
           return; // don't print paginated results
       }
       if (event.getType() !== "m.room.message") {
           return; // only print messages
       }
       console.log(
           // the room name will update with m.room.name events automatically
           "(%s) %s :: %s", room.name, event.getSender(), event.getContent().body
       );
   });

   matrixClient.startClient();
```

Output:
```
  (My Room) @megan:localhost :: Hello world
  (My Room) @megan:localhost :: how are you?
  (My Room) @example:localhost :: I am good
  (My Room) @example:localhost :: change the room name
  (My New Room) @megan:localhost :: done
```

### Print out membership lists whenever they are changed

```javascript
   matrixClient.on("RoomState.members", function(event, state, member) {
       var room = matrixClient.getRoom(state.roomId);
       if (!room) {
           return;
       }
       var memberList = state.getMembers();
       console.log(room.name);
       console.log(Array(room.name.length + 1).join("="));  // underline
       for (var i = 0; i < memberList.length; i++) {
           console.log(
               "(%s) %s",
               memberList[i].membership,
               memberList[i].name
           );
       }
   });

   matrixClient.startClient();
```

Output:
```
  My Room
  =======
  (join) @example:localhost
  (leave) @alice:localhost
  (join) Bob
  (invite) @charlie:localhost
```

API Reference
=============

A hosted reference can be found at
http://matrix-org.github.io/matrix-js-sdk/index.html

This SDK uses JSDoc3 style comments. You can manually build and
host the API reference from the source files like this:

```
  $ npm run gendoc
  $ cd .jsdoc
  $ python -m SimpleHTTPServer 8005
```

Then visit ``http://localhost:8005`` to see the API docs.

Contributing
============
*This section is for people who want to modify the SDK. If you just
want to use this SDK, skip this section.*

First, you need to pull in the right build tools:
```
 $ npm install
```

Building
--------

To build a browser version from scratch when developing::
```
 $ npm run build
```

To constantly do builds when files are modified (using ``watchify``)::
```
 $ npm run watch
```

To run tests (Jasmine)::
```
 $ npm test
```

To run linting:
```
 $ npm run lint
```
