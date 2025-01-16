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

See [below](#end-to-end-encryption-support) for how to enable end-to-end-encryption, or check
[the Node.js terminal app](https://github.com/matrix-org/matrix-js-sdk/tree/develop/examples/node) for a more complex example.

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

- Handles syncing (via `/sync`)
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

`matrix-js-sdk`'s end-to-end encryption support is based on the [WebAssembly bindings](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm) of the Rust [matrix-sdk-crypto](https://github.com/matrix-org/matrix-rust-sdk/tree/main/crates/matrix-sdk-crypto) library.

## Initialization

**Do not use `matrixClient.initLegacyCrypto()`. This method is deprecated and no longer maintained.**

To initialize the end-to-end encryption support in the matrix client:

```javascript
// Create a new matrix client
const matrixClient = sdk.createClient({
    baseUrl: "http://localhost:8008",
    accessToken: myAccessToken,
    userId: myUserId,
});

// Initialize to enable end-to-end encryption support.
await matrixClient.initRustCrypto();
```

After calling `initRustCrypto`, you can obtain a reference to the [`CryptoApi`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html) interface, which is the main entry point for end-to-end encryption, by calling [`MatrixClient.getCrypto`](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.MatrixClient.html#getCrypto).

**WARNING**: the cryptography stack is not thread-safe. Having multiple `MatrixClient` instances connected to the same Indexed DB will cause data corruption and decryption failures. The application layer is responsible for ensuring that only one `MatrixClient` issue is instantiated at a time.

## Secret storage

You should normally set up [secret storage](https://spec.matrix.org/v1.12/client-server-api/#secret-storage) before using the end-to-end encryption. To do this, call [`CryptoApi.bootstrapSecretStorage`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#bootstrapSecretStorage).
`bootstrapSecretStorage` can be called unconditionally: it will only set up the secret storage if it is not already set up (unless you use the `setupNewSecretStorage` parameter).

```javascript
const matrixClient = sdk.createClient({
    ...,
    cryptoCallbacks: {
        getSecretStorageKey: async (keys) => {
            // This function should prompt the user to enter their secret storage key.
            return mySecretStorageKeys;
        },
    },
});

matrixClient.getCrypto().bootstrapSecretStorage({
    // This function will be called if a new secret storage key (aka recovery key) is needed.
    // You should prompt the user to save the key somewhere, because they will need it to unlock secret storage in future.
    createSecretStorageKey: async () => {
        return mySecretStorageKey;
    },
});
```

The example above will create a new secret storage key if secret storage was not previously set up.
The secret storage data will be encrypted using the secret storage key returned in [`createSecretStorageKey`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CreateSecretStorageOpts.html#createSecretStorageKey).

We recommend that you prompt the user to re-enter this key when [`CryptoCallbacks.getSecretStorageKey`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoCallbacks.html#getSecretStorageKey) is called (when the secret storage access is needed).

## Set up cross-signing

To set up cross-signing to verify devices and other users, call
[`CryptoApi.bootstrapCrossSigning`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#bootstrapCrossSigning):

```javascript
matrixClient.getCrypto().bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => {
        return makeRequest(authDict);
    },
});
```

The [`authUploadDeviceSigningKeys`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.BootstrapCrossSigningOpts.html#authUploadDeviceSigningKeys)
callback is required in order to upload newly-generated public cross-signing keys to the server.

## Key backup

If the user doesn't already have a [key backup](https://spec.matrix.org/v1.12/client-server-api/#server-side-key-backups) you should create one:

```javascript
// Check if we have a key backup.
// If checkKeyBackupAndEnable returns null, there is no key backup.
const hasKeyBackup = (await matrixClient.getCrypto().checkKeyBackupAndEnable()) !== null;

// Create the key backup
await matrixClient.getCrypto().resetKeyBackup();
```

## Verify a new device

Once the cross-signing is set up on one of your devices, you can verify another device with two methods:

1. Use `CryptoApi.bootstrapCrossSigning`.

    `bootstrapCrossSigning` will call the [CryptoCallbacks.getSecretStorageKey](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoCallbacks.html#getSecretStorageKey) callback. The device is verified with the private cross-signing keys fetched from the secret storage.

2. Request an interactive verification against existing devices, by calling [CryptoApi.requestOwnUserVerification](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html#requestOwnUserVerification).

## Migrating from the legacy crypto stack to Rust crypto

If your application previously used the legacy crypto stack, (i.e, it called `MatrixClient.initLegacyCrypto()`), you will
need to migrate existing devices to the Rust crypto stack.

This migration happens automatically when you call `initRustCrypto()` instead of `initLegacyCrypto()`,
but you need to provide the legacy [`cryptoStore`](https://matrix-org.github.io/matrix-js-sdk/interfaces/matrix.ICreateClientOpts.html#cryptoStore) and [`pickleKey`](https://matrix-org.github.io/matrix-js-sdk/interfaces/matrix.ICreateClientOpts.html#pickleKey) to [`createClient`](https://matrix-org.github.io/matrix-js-sdk/functions/matrix.createClient.html):

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

To follow the migration progress, you can listen to the [`CryptoEvent.LegacyCryptoStoreMigrationProgress`](https://matrix-org.github.io/matrix-js-sdk/enums/crypto_api.CryptoEvent.html#LegacyCryptoStoreMigrationProgress) event:

```javascript
// When progress === total === -1, the migration is finished.
matrixClient.on(CryptoEvent.LegacyCryptoStoreMigrationProgress, (progress, total) => {
    ...
});
```

The Rust crypto stack is not supported in a lot of deprecated methods of [`MatrixClient`](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.MatrixClient.html). If you use them, you should migrate to the [`CryptoApi`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto_api.CryptoApi.html). Also, the legacy `MatrixClient.crypto` object is not available any more: you should use `MatrixClient.getCrypto()` instead.

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
