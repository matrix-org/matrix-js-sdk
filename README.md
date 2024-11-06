[![npm](https://img.shields.io/npm/v/matrix-js-sdk)](https://www.npmjs.com/package/matrix-js-sdk)
![Tests](https://github.com/matrix-org/matrix-js-sdk/actions/workflows/tests.yml/badge.svg)
![Static Analysis](https://github.com/matrix-org/matrix-js-sdk/actions/workflows/static_analysis.yml/badge.svg)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=matrix-js-sdk&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=matrix-js-sdk)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=matrix-js-sdk&metric=coverage)](https://sonarcloud.io/summary/new_code?id=matrix-js-sdk)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=matrix-js-sdk&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=matrix-js-sdk)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=matrix-js-sdk&metric=bugs)](https://sonarcloud.io/summary/new_code?id=matrix-js-sdk)

# Matrix JavaScript SDK

This is the [Matrix](https://matrix.org) Client-Server SDK for JavaScript and TypeScript. This SDK can be run in a
browser or in Node.js.

#### Minimum Matrix server version: v1.1

The Matrix specification is constantly evolving - while this SDK aims for maximum backwards compatibility, it only
guarantees that a feature will be supported for at least 4 spec releases. For example, if a feature the js-sdk supports
is removed in v1.4 then the feature is _eligible_ for removal from the SDK when v1.8 is released. This SDK has no
guarantee on implementing all features of any particular spec release, currently. This can mean that the SDK will call
endpoints from before Matrix 1.1, for example.

# Quickstart

> [!IMPORTANT]
> Servers may require or use authenticated endpoints for media (images, files, avatars, etc). See the
> [Authenticated Media](#authenticated-media) section for information on how to enable support for this.

Using `yarn` instead of `npm` is recommended. Please see the Yarn [install guide](https://classic.yarnpkg.com/en/docs/install)
if you do not have it already.

`yarn add matrix-js-sdk`

```javascript
import * as sdk from "matrix-js-sdk";
const client = sdk.createClient({ baseUrl: "https://matrix.org" });
client.publicRooms(function (err, data) {
    console.log("Public Rooms: %s", JSON.stringify(data));
});
```

See below for how to include libolm to enable end-to-end-encryption. Please check
[the Node.js terminal app](examples/node/README.md) for a more complex example.

To start the client:

```javascript
await client.startClient({ initialSyncLimit: 10 });
```

You can perform a call to `/sync` to get the current state of the client:

```javascript
client.once(ClientEvent.sync, function (state, prevState, res) {
    if (state === "PREPARED") {
        console.log("prepared");
    } else {
        console.log(state);
        process.exit(1);
    }
});
```

To send a message:

```javascript
const content = {
    body: "message text",
    msgtype: "m.text",
};
client.sendEvent("roomId", "m.room.message", content, "", (err, res) => {
    console.log(err);
});
```

To listen for message events:

```javascript
client.on(RoomEvent.Timeline, function (event, room, toStartOfTimeline) {
    if (event.getType() !== "m.room.message") {
        return; // only use messages
    }
    console.log(event.event.content.body);
});
```

By default, the `matrix-js-sdk` client uses the `MemoryStore` to store events as they are received. For example to iterate through the currently stored timeline for a room:

```javascript
Object.keys(client.store.rooms).forEach((roomId) => {
    client.getRoom(roomId).timeline.forEach((t) => {
        console.log(t.event);
    });
});
```

## Authenticated media

Servers supporting [MSC3916](https://github.com/matrix-org/matrix-spec-proposals/pull/3916) (Matrix 1.11) will require clients, like
yours, to include an `Authorization` header when `/download`ing or `/thumbnail`ing media. For NodeJS environments this
may be as easy as the following code snippet, though web browsers may need to use [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
to append the header when using the endpoints in `<img />` elements and similar.

```javascript
const downloadUrl = client.mxcUrlToHttp(
    /*mxcUrl=*/ "mxc://example.org/abc123", // the MXC URI to download/thumbnail, typically from an event or profile
    /*width=*/ undefined, // part of the thumbnail API. Use as required.
    /*height=*/ undefined, // part of the thumbnail API. Use as required.
    /*resizeMethod=*/ undefined, // part of the thumbnail API. Use as required.
    /*allowDirectLinks=*/ false, // should generally be left `false`.
    /*allowRedirects=*/ true, // implied supported with authentication
    /*useAuthentication=*/ true, // the flag we're after in this example
);
const img = await fetch(downloadUrl, {
    headers: {
        Authorization: `Bearer ${client.getAccessToken()}`,
    },
});
// Do something with `img`.
```

> [!WARNING]
> In future the js-sdk will _only_ return authentication-required URLs, mandating population of the `Authorization` header.

## What does this SDK do?

This SDK provides a full object model around the Matrix Client-Server API and emits
events for incoming data and state changes. Aside from wrapping the HTTP API, it:

-   Handles syncing (via `/sync`)
-   Handles the generation of "friendly" room and member names.
-   Handles historical `RoomMember` information (e.g. display names).
-   Manages room member state across multiple events (e.g. it handles typing, power
    levels and membership changes).
-   Exposes high-level objects like `Rooms`, `RoomState`, `RoomMembers` and `Users`
    which can be listened to for things like name changes, new messages, membership
    changes, presence changes, and more.
-   Handle "local echo" of messages sent using the SDK. This means that messages
    that have just been sent will appear in the timeline as 'sending', until it
    completes. This is beneficial because it prevents there being a gap between
    hitting the send button and having the "remote echo" arrive.
-   Mark messages which failed to send as not sent.
-   Automatically retry requests to send messages due to network errors.
-   Automatically retry requests to send messages due to rate limiting errors.
-   Handle queueing of messages.
-   Handles pagination.
-   Handle assigning push actions for events.
-   Handles room initial sync on accepting invites.
-   Handles WebRTC calling.

# Usage

## Supported platforms

`matrix-js-sdk` can be used in either Node.js applications (ensure you have the latest LTS version of Node.js installed),
or in browser applications, via a bundler such as Webpack or Vite.

You can also use the sdk with [Deno](https://deno.land/) (`import npm:matrix-js-sdk`) but its not officialy supported.

## Emitted events

The SDK raises notifications to the application using
[`EventEmitter`s](https://nodejs.org/api/events.html#class-eventemitter). The `MatrixClient` itself
implements `EventEmitter`, as do many of the high-level abstractions such as `Room` and `RoomMember`.

```javascript
// Listen for low-level MatrixEvents
client.on(ClientEvent.Event, function (event) {
    console.log(event.getType());
});

// Listen for typing changes
client.on(RoomMemberEvent.Typing, function (event, member) {
    if (member.typing) {
        console.log(member.name + " is typing...");
    } else {
        console.log(member.name + " stopped typing.");
    }
});

// start the client to setup the connection to the server
client.startClient();
```

## Entry points

As well as the primary entry point (`matrix-js-sdk`), there are several other entry points which may be useful:

| Entry point                    | Description                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `matrix-js-sdk`                | Primary entry point. High-level functionality, and lots of historical clutter in need of a cleanup. |
| `matrix-js-sdk/lib/crypto-api` | Cryptography functionality.                                                                         |
| `matrix-js-sdk/lib/types`      | Low-level types, reflecting data structures defined in the Matrix spec.                             |
| `matrix-js-sdk/lib/testing`    | Test utilities, which may be useful in test code but should not be used in production code.         |
| `matrix-js-sdk/lib/utils/*.js` | A set of modules exporting standalone functions (and their types).                                  |

## Examples

This section provides some useful code snippets which demonstrate the
core functionality of the SDK. These examples assume the SDK is set up like this:

```javascript
import * as sdk from "matrix-js-sdk";
const myUserId = "@example:localhost";
const myAccessToken = "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
const matrixClient = sdk.createClient({
    baseUrl: "http://localhost:8008",
    accessToken: myAccessToken,
    userId: myUserId,
});
```

### Automatically join rooms when invited

```javascript
matrixClient.on(RoomEvent.MyMembership, function (room, membership, prevMembership) {
    if (membership === KnownMembership.Invite) {
        matrixClient.joinRoom(room.roomId).then(function () {
            console.log("Auto-joined %s", room.roomId);
        });
    }
});

matrixClient.startClient();
```

### Print out messages for all rooms

```javascript
matrixClient.on(RoomEvent.Timeline, function (event, room, toStartOfTimeline) {
    if (toStartOfTimeline) {
        return; // don't print paginated results
    }
    if (event.getType() !== "m.room.message") {
        return; // only print messages
    }
    console.log(
        // the room name will update with m.room.name events automatically
        "(%s) %s :: %s",
        room.name,
        event.getSender(),
        event.getContent().body,
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
matrixClient.on(RoomStateEvent.Members, function (event, state, member) {
    const room = matrixClient.getRoom(state.roomId);
    if (!room) {
        return;
    }
    const memberList = state.getMembers();
    console.log(room.name);
    console.log(Array(room.name.length + 1).join("=")); // underline
    for (var i = 0; i < memberList.length; i++) {
        console.log("(%s) %s", memberList[i].membership, memberList[i].name);
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

# API Reference

A hosted reference can be found at
http://matrix-org.github.io/matrix-js-sdk/index.html

This SDK uses [Typedoc](https://typedoc.org/guides/doccomments) doc comments. You can manually build and
host the API reference from the source files like this:

```
  $ yarn gendoc
  $ cd docs
  $ python -m http.server 8005
```

Then visit `http://localhost:8005` to see the API docs.

# End-to-end encryption support

The matrix-js-sdk uses underneath the [matrix-sdk-crypto-wasm bindings](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm) of the [matrix-rust-sdk](https://github.com/matrix-org/matrix-rust-sdk/) to provide end-to-end encryption support.

## Initialization

**Do not use `matrixClient.initCrypto()`. This method is deprecated and no longer maintained.**

To initialize the end-to-end encryption support in the matrix client:

```javascript
// Create a new matrix client
const matrixClient = sdk.createClient({
    baseUrl: "http://localhost:8008",
    accessToken: myAccessToken,
    userId: myUserId,
});

// Initialize to enable end-to-end encryption support.
// This will use an in-memory store.
await matrixClient.initRustCrypto();
```

To persist the local data, you can use the indexedDB store:

```javascript
// If you not provide a storage key or a password (using a storage key is preferred), the indexedDB store will be uncrypted.
// The storage key must be a 32 bytes long Uint8Array.
await matrixClient.initRustCrypto({
    useIndexedDB: true,
    storageKey: my32BytesKey,
});
```

### Secret storage

If your [secret storage](https://spec.matrix.org/v1.12/client-server-api/#secret-storage) is not set up, you need to bootstrap it before using the `CryptoApi`:

```javascript
const matrixClient = sdk.createClient({
    ...,
    cryptoCallbacks: {
        getSecretStorageKey: (keys) => {
            // This function should return the secret storage keys returned in `bootstrapSecretStorage#createSecretStorageKey`
            return mySecretStorageKeys;
        },
    },
});

matrixClient.getCrypto().bootstrapSecretStorage({
    // This will reset the secret storage if it is already set up.
    // If you want to keep the current secret storage, you can set `setupNewSecretStorage` to `false`.
    // If `setupNewSecretStorage` is `true`, you need to fill `createSecretStorageKey`
    setupNewSecretStorage: true,
    // This function will be called if `setupNewSecretStorage` is `true`.
    // You should remember the key you return here, because you will need it to unlock the secret storage.
    // This key should implement the https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.GeneratedSecretStorageKey.html interface.
    createSecretStorageKey: () => {
        return mySecretStorageKey;
    },
});
```

In the example above, we are setting up a new secret storage. The secret storage data will be encrypted using the secret storage key returned in `createSecretStorageKey`.
You should remember this key because when access to the secret storage is needed, the crypto moduel is expecting the `getSecretStorageKey` to return this key.

-   [CryptoCallbacks#getSecretStorageKey](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoCallbacks.html#getSecretStorageKey)
-   [CryptoApi#bootstrapSecretStorage](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#bootstrapSecretStorage)

Also, if you don't have a [key backup](https://spec.matrix.org/v1.12/client-server-api/#server-side-key-backups) you should create one:

```javascript
matrixClient.getCrypto().bootstrapSecretStorage({
    ...,
    setupNewKeyBackup: true,
});
```

Once the key backup and the secret storage are set up, you don't need to set them up again for all your devices.

### Verify a device and cross-signing

### Set up cross-signing

In order to use cross-signing to verify devices, you need to set up cross-signing:

```javascript
matrixClient.getCrypto().bootstrapCrossSigning({
    authUploadDeviceSigningKeys: (makeRequest) => {
        return makeRequest(authDict);
    },
});
```

The `authUploadDeviceSigningKeys` callback is optional but strongly recommended in order to upload the device signing keys to the server.

-   [AuthDict](https://matrix-org.github.io/matrix-js-sdk/types/matrix.AuthDict.html)
-   [CryptoApi#bootstrapCrossSigning](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#bootstrapCrossSigning)

### Verify a device

Once the cross-signing is set up on one of your devices, you can verify another device with two methods:

1. Use `CryptoApi#bootstrapCrossSigning`

`bootstrapCrossSigning`will call the [CryptoCallbacks#getSecretStorageKey](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoCallbacks.html#getSecretStorageKey) provided in [Secret storage chapter](#secret-storage). The device is verified with the private cross-signing keys fetched from the secret storage.

2. Request a verification with [CryptoApi#requestOwnUserVerification](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#requestOwnUserVerification) or [CryptoApi#requestDeviceVerification](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#requestDeviceVerification).

## Migrate from the legacy crypto to the new crypto

To migrate from the legacy crypto to the new crypto:

```javascript
// You should provide the legacy crypto store and the pickle key to the matrix client in order to migrate the data.
const matrixClient = sdk.createClient({
    cryptoStore: myCryptoStore,
    pickleKey: myPickleKey,
    baseUrl: "http://localhost:8008",
    accessToken: myAccessToken,
    userId: myUserId,
});

// The migration will be done automatically when you call `initRustCrypto`.
await matrixClient.initRustCrypto();
```

To follow the migration progress, you can listen to the `CryptoEvent.LegacyCryptoStoreMigrationProgress` event:

```javascript
// When progress === total === -1, the migration is finished.
matrixClient.on(CryptoEvent.LegacyCryptoStoreMigrationProgress, (progress, total) => {
    ...
});
```

After the migration is finished, you can remove the legacy crypto store and the pickle key from the matrix client creation.

## Use the `CryptoApi`

The `CryptoApi` is the main entry point for end-to-end encryption.

```javascript
// If the `CryptoApi` object is `undefined`, the end-to-end encryption is not enabled.
// You must call `initRustCrypto` before.
matrixClient.getCrypto();
```

The CryptoApi documentation is available [here](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html).

# Contributing

_This section is for people who want to modify the SDK. If you just
want to use this SDK, skip this section._

First, you need to pull in the right build tools:

```
 $ yarn install
```

## Building

To build a browser version from scratch when developing:

```
 $ yarn build
```

To run tests (Jest):

```
 $ yarn test
```

To run linting:

```
 $ yarn lint
```
