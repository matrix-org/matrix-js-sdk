Matrix Javascript SDK
=====================
.. image:: http://matrix.org/jenkins/buildStatus/icon?job=JavascriptSDK
   :target: http://matrix.org/jenkins/job/JavascriptSDK/

This is the Matrix_ Client-Server v1/v2 alpha SDK for JavaScript. This SDK can be run
in a browser or in Node.js.

Quickstart
==========

In a browser
------------
Copy ``dist/browser-matrix-$VERSION.js`` and add that as a ``<script>`` to
your page. There will be a global variable ``matrixcs`` attached to
``window`` through which you can access the SDK.

Please check `examples/browser`_ for a working example. 

In Node.js
----------

``npm install matrix-js-sdk``

.. code:: javascript

  var sdk = require("matrix-js-sdk");
  var client = sdk.createClient("https://matrix.org");
  client.publicRooms(function(err, data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
  });

Please check `examples/node`_ to see a working version.

Usage
=====

Conventions
-----------

Emitted events
~~~~~~~~~~~~~~

The SDK will emit events using an ``EventEmitter``. It also
emits object models (e.g. ``Rooms``, ``RoomMembers``) when they
are updated.

.. code:: javascript
  
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

Promises or Callbacks
~~~~~~~~~~~~~~~~~~~~~
The SDK supports *both* callbacks and Promises (Q). The convention
you'll see used is:

.. code:: javascript

  var promise = matrixClient.someMethod(arg1, arg2, callback);
  
The ``callback`` parameter is optional, so you could do:

.. code:: javascript

  matrixClient.someMethod(arg1, arg2).then(function(result) {
    ...
  });
  
Alternatively, you could do:

.. code:: javascript

  matrixClient.someMethod(arg1, arg2, function(result) {
    ...
  });
  
Methods which support this will be clearly marked as returning
``Promises``.

Examples
--------
This section provides some useful code snippets which demonstrate the
core functionality of the SDK. These examples assume the SDK is setup like this:

.. code:: javascript

   var sdk = require("matrix-js-sdk");
   var myUserId = "@example:localhost";
   var myAccessToken = "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
   var matrixClient = sdk.createClient({
       baseUrl: "http://localhost:8008",
       accessToken: myAccessToken,
       userId: myUserId
   });

Automatically join rooms when invited
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
.. code:: javascript
   
   matrixClient.on("RoomMember.membership", function(event, member) {
       if (member.membership === "invite" && member.userId === myUserId) {
           matrixClient.joinRoom(member.roomId).done(function() {
               console.log("Auto-joined %s", member.roomId);
           });
       }
   });
   
   matrixClient.startClient();
   
Print out messages for all rooms
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
.. code:: javascript

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

  
API Reference
=============

A hosted reference can be found at
http://matrix-org.github.io/matrix-js-sdk/global.html

This SDK uses JSDoc3 style comments. You can manually build and
host the API reference from the source files like this::

  $ npm install -g jsdoc
  $ jsdoc -r lib/
  $ cd out
  $ python -m SimpleHTTPServer 8005
  
Then visit ``http://localhost:8005`` to see the API docs. By
default, ``jsdoc`` produces HTML in the ``out`` folder.

Contributing
============
*This section is for people who want to modify the SDK. If you just
want to use this SDK, skip this section.*

First, you need to pull in the right build tools::

 $ npm install


Building
--------

To build a browser version from scratch when developing::

 $ npm run build


To constantly do builds when files are modified (using ``watchify``)::

 $ npm run watch
 
To run tests (Jasmine)::

 $ npm test
 
To run linters (Google Closure Linter and JSHint)::

 $ npm run lint

.. _Matrix: http://matrix.org
.. _examples/browser: examples/browser
.. _examples/node: examples/node
.. _client server API: http://matrix.org/docs/api/client-server/
