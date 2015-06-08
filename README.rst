Matrix Javascript SDK
=====================
.. image:: http://matrix.org/jenkins/buildStatus/icon?job=JavascriptSDK
   :target: http://matrix.org/jenkins/job/JavascriptSDK/

This is the Matrix_ Client-Server v1 SDK for JavaScript. This SDK can be run
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

::

  var sdk = require("matrix-js-sdk");
  var client = sdk.createClient("https://matrix.org");
  client.publicRooms(function(err, data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
  });

Please check `examples/node`_ to see a working version.

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
