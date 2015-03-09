Matrix Javascript SDK
=====================

This is the Matrix_ Client-Server v1 SDK for Javascript. This SDK can be run
in a browser (using ``browserify`` or stand-alone with a suitable 
``request.js``) or in Node.js.

Quickstart
==========

In a browser
------------
Host `examples/browser`_ (e.g. using ``python -m SimpleHTTPServer``) and check
the console to see a working version.

In Node
-------

``npm install matrix-js-sdk``

::

  var sdk = require("matrix-js-sdk");
  var client = sdk.createClient("https://matrix.org");
  client.publicRooms(function(err, data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
  });

Run `examples/node`_ via ``node app.js`` to see a working version.

API
===

Please see the `client server API`_ for more information on the HTTP calls.

Matrix Client
-------------
``MatrixClient`` is constructed via ``sdk.createClient(args)`` where ``args`` can be:

- ``baseUrl`` (String) : The home server base URL to make requests to.
- ``credentials`` (Object) : Consists of a ``baseUrl`` (String), a ``userId`` (String)
  and an ``accessToken`` (String).
- ``credentials, config`` (Object, Object) : As before, but with a ``config`` which has
  the following options:
  
  *  ``noUserAgent`` (Boolean: default ``false``) : Set to ``true`` to stop setting a 
     ``User-Agent`` on requests. This is typically done when using the SDK in a browser 
     which logs errors when trying to clobber the User-Agent.

At any point these values can be modified by accessing ``matrixClient.credentials`` and
``matrixClient.config``.

Promises
--------
Promises are supported using ``Q``, but are not enabled by default. To enable them, simply
call ``sdk.usePromises()`` like so::

  var sdk = require("matrix-js-sdk");
  sdk.usePromises();
  var client = sdk.createClient("https://matrix.org");
  client.publicRooms().then(function(data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
  });
  
You will need to ``npm install q`` as it is not a hard dependency on this project.

Request
-------

``MatrixClient`` **requires** a ``request`` module in order to function. This is
usually done for you when using ``npm``. You can manually inject this by calling
``sdk.request(<request>)``. Wrappers around ``request`` allow you to easily
support different HTTP libraries (such as AngularJS's ``$http``).

.. _Matrix: http://matrix.org
.. _examples/browser: examples/browser
.. _examples/node: examples/node
.. _client server API: http://matrix.org/docs/api/client-server/
