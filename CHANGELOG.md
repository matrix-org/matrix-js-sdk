Changes in [0.14.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.14.2) (2018-12-10)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.14.2-rc.1...v0.14.2)

 * No changes since rc.1

Changes in [0.14.2-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.14.2-rc.1) (2018-12-06)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.14.1...v0.14.2-rc.1)

 * fix some assertions in e2e backup unit test
   [\#794](https://github.com/matrix-org/matrix-js-sdk/pull/794)
 * Config should be called with auth
   [\#798](https://github.com/matrix-org/matrix-js-sdk/pull/798)
 * Don't re-establish sessions with unknown devices
   [\#792](https://github.com/matrix-org/matrix-js-sdk/pull/792)
 * e2e key backups
   [\#684](https://github.com/matrix-org/matrix-js-sdk/pull/684)
 * WIP: online incremental megolm backups
   [\#595](https://github.com/matrix-org/matrix-js-sdk/pull/595)
 * Support for e2e key backups
   [\#736](https://github.com/matrix-org/matrix-js-sdk/pull/736)
 * Passphrase Support for e2e backups
   [\#786](https://github.com/matrix-org/matrix-js-sdk/pull/786)
 * Add 'getSsoLoginUrl' function
   [\#783](https://github.com/matrix-org/matrix-js-sdk/pull/783)
 * Fix: don't set the room name to null when heroes are missing.
   [\#784](https://github.com/matrix-org/matrix-js-sdk/pull/784)
 * Handle crypto db version upgrades
   [\#785](https://github.com/matrix-org/matrix-js-sdk/pull/785)
 * Restart broken Olm sessions
   [\#780](https://github.com/matrix-org/matrix-js-sdk/pull/780)
 * Use the last olm session that got a message
   [\#776](https://github.com/matrix-org/matrix-js-sdk/pull/776)

Changes in [0.14.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.14.1) (2018-11-22)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.14.0...v0.14.1)

 * Warning when crypto DB is too new to use.

Changes in [0.14.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.14.0) (2018-11-19)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.14.0-rc.1...v0.14.0)

 * No changes since rc.1

Changes in [0.14.0-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.14.0-rc.1) (2018-11-15)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.13.1...v0.14.0-rc.1)

BREAKING CHANGE
----------------
 
 * js-sdk now uses Olm 3.0. Apps using Olm must update to 3.0 to
   continue using Olm with the js-sdk. The js-sdk will call Olm's
   init() method when the client is started.

All Changes
-----------

 * Prevent messages from being sent if other messages have failed to send
   [\#781](https://github.com/matrix-org/matrix-js-sdk/pull/781)
 * A unit test for olm
   [\#777](https://github.com/matrix-org/matrix-js-sdk/pull/777)
 * Set access_token and user_id after login in with username and password.
   [\#778](https://github.com/matrix-org/matrix-js-sdk/pull/778)
 * Add function to get currently joined rooms.
   [\#779](https://github.com/matrix-org/matrix-js-sdk/pull/779)
 * Remove the request-only stuff we don't need anymore
   [\#775](https://github.com/matrix-org/matrix-js-sdk/pull/775)
 * Manually construct query strings for browser-request instances
   [\#770](https://github.com/matrix-org/matrix-js-sdk/pull/770)
 * Fix: correctly check for crypto being present
   [\#769](https://github.com/matrix-org/matrix-js-sdk/pull/769)
 * Update babel-eslint to 8.1.1
   [\#768](https://github.com/matrix-org/matrix-js-sdk/pull/768)
 * Support `request` in the browser and support supplying servers to try in
   joinRoom()
   [\#764](https://github.com/matrix-org/matrix-js-sdk/pull/764)
 * loglevel should be a normal dependency
   [\#767](https://github.com/matrix-org/matrix-js-sdk/pull/767)
 * Stop devicelist when client is stopped
   [\#766](https://github.com/matrix-org/matrix-js-sdk/pull/766)
 * Update to WebAssembly-powered Olm
   [\#743](https://github.com/matrix-org/matrix-js-sdk/pull/743)
 * Logging lib. Fixes #332
   [\#763](https://github.com/matrix-org/matrix-js-sdk/pull/763)
 * Use new stop() method on matrix-mock-request
   [\#765](https://github.com/matrix-org/matrix-js-sdk/pull/765)

Changes in [0.13.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.13.1) (2018-11-14)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.13.0...v0.13.1)

 * Add function to get currently joined rooms.
   [\#779](https://github.com/matrix-org/matrix-js-sdk/pull/779)

Changes in [0.13.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.13.0) (2018-11-15)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.12.1...v0.13.0)

BREAKING CHANGE
----------------
 * `MatrixClient::login` now sets client `access_token` and `user_id` following successful login with username and password.

Changes in [0.12.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.12.1) (2018-10-29)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.12.1-rc.1...v0.12.1)

 * No changes since rc.1

Changes in [0.12.1-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.12.1-rc.1) (2018-10-24)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.12.0...v0.12.1-rc.1)

 * Add repository type to package.json to make it valid
   [\#762](https://github.com/matrix-org/matrix-js-sdk/pull/762)
 * Add getMediaConfig()
   [\#761](https://github.com/matrix-org/matrix-js-sdk/pull/761)
 * add new examples, to be expanded into a post
   [\#739](https://github.com/matrix-org/matrix-js-sdk/pull/739)

Changes in [0.12.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.12.0) (2018-10-16)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.12.0-rc.1...v0.12.0)

 * No changes since rc.1

Changes in [0.12.0-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.12.0-rc.1) (2018-10-11)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.11.1...v0.12.0-rc.1)

BREAKING CHANGES
----------------
 * If js-sdk finds data in the store that is incompatible with the options currently being used,
   it will emit sync state ERROR with an error of type InvalidStoreError. It will also stop trying
   to sync in this situation: the app must stop the client and then either clear the store or
   change the options (in this case, enable or disable lazy loading of members) and then start
   the client again.

All Changes
-----------

 * never replace /sync'ed memberships with OOB ones
   [\#760](https://github.com/matrix-org/matrix-js-sdk/pull/760)
 * Don't fail to start up if lazy load check fails
   [\#759](https://github.com/matrix-org/matrix-js-sdk/pull/759)
 * Make e2e work on Edge
   [\#754](https://github.com/matrix-org/matrix-js-sdk/pull/754)
 * throw error with same name and message over idb worker boundary
   [\#758](https://github.com/matrix-org/matrix-js-sdk/pull/758)
 * Default to a room version of 1 when there is no room create event
   [\#755](https://github.com/matrix-org/matrix-js-sdk/pull/755)
 * Silence bluebird warnings
   [\#757](https://github.com/matrix-org/matrix-js-sdk/pull/757)
 * allow non-ff merge from release branch into master
   [\#750](https://github.com/matrix-org/matrix-js-sdk/pull/750)
 * Reject with the actual error on indexeddb error
   [\#751](https://github.com/matrix-org/matrix-js-sdk/pull/751)
 * Update mocha to v5
   [\#744](https://github.com/matrix-org/matrix-js-sdk/pull/744)
 * disable lazy loading for guests as they cant create filters
   [\#748](https://github.com/matrix-org/matrix-js-sdk/pull/748)
 * Revert "Add getMediaLimits to client"
   [\#745](https://github.com/matrix-org/matrix-js-sdk/pull/745)

Changes in [0.11.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.11.1) (2018-10-01)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.11.1-rc.1...v0.11.1)

 * No changes since rc.1

Changes in [0.11.1-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.11.1-rc.1) (2018-09-27)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.11.0...v0.11.1-rc.1)

 * make usage of hub compatible with latest version (2.5)
   [\#747](https://github.com/matrix-org/matrix-js-sdk/pull/747)
 * Detect when lazy loading has been toggled in client.startClient
   [\#746](https://github.com/matrix-org/matrix-js-sdk/pull/746)
 * Add getMediaLimits to client
   [\#644](https://github.com/matrix-org/matrix-js-sdk/pull/644)
 * Split npm start into an init and watch script
   [\#742](https://github.com/matrix-org/matrix-js-sdk/pull/742)
 * Revert "room name should only take canonical alias into account"
   [\#738](https://github.com/matrix-org/matrix-js-sdk/pull/738)
 * fix display name disambiguation with LL
   [\#737](https://github.com/matrix-org/matrix-js-sdk/pull/737)
 * Introduce Room.myMembership event
   [\#735](https://github.com/matrix-org/matrix-js-sdk/pull/735)
 * room name should only take canonical alias into account
   [\#733](https://github.com/matrix-org/matrix-js-sdk/pull/733)
 * state events from context response were not wrapped in a MatrixEvent
   [\#732](https://github.com/matrix-org/matrix-js-sdk/pull/732)
 * Reduce amount of promises created when inserting members
   [\#724](https://github.com/matrix-org/matrix-js-sdk/pull/724)
 * dont wait for LL members to be stored to resolve the members
   [\#726](https://github.com/matrix-org/matrix-js-sdk/pull/726)
 * RoomState.members emitted with wrong argument order for OOB members
   [\#728](https://github.com/matrix-org/matrix-js-sdk/pull/728)

Changes in [0.11.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.11.0) (2018-09-10)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.11.0-rc.1...v0.11.0)

BREAKING CHANGES
----------------
 * v0.11.0-rc.1 introduced some breaking changes - see the respective release notes.

No changes since rc.1

Changes in [0.11.0-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.11.0-rc.1) (2018-09-07)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.9...v0.11.0-rc.1)

 * Support for lazy loading members. This should improve performance for
   users who joined big rooms a lot. Pass to `lazyLoadMembers = true` option when calling `startClient`.

BREAKING CHANGES
----------------

 * `MatrixClient::startClient` now returns a Promise. No method should be called on the client before that promise resolves. Before this method didn't return anything.
 * A new `CATCHUP` sync state, emitted by `MatrixClient#"sync"` and returned by `MatrixClient::getSyncState()`, when doing initial sync after the `ERROR` state. See `MatrixClient` documentation for details.
 * `RoomState::maySendEvent('m.room.message', userId)` & `RoomState::maySendMessage(userId)` do not check the membership of the user anymore, only the power level. To check if the syncing user is allowed to write in a room, use `Room::maySendMessage()` as `RoomState` is not always aware of the syncing user's membership anymore, in case lazy loading of members is enabled.

All Changes
-----------

 * Only emit CATCHUP if recovering from conn error
   [\#727](https://github.com/matrix-org/matrix-js-sdk/pull/727)
 * Fix docstring for sync data.error
   [\#725](https://github.com/matrix-org/matrix-js-sdk/pull/725)
 * Re-apply "Don't rely on members to query if syncing user can post to room"
   [\#723](https://github.com/matrix-org/matrix-js-sdk/pull/723)
 * Revert "Don't rely on members to query if syncing user can post to room"
   [\#721](https://github.com/matrix-org/matrix-js-sdk/pull/721)
 * Don't rely on members to query if syncing user can post to room
   [\#717](https://github.com/matrix-org/matrix-js-sdk/pull/717)
 * Fixes for room.guessDMUserId
   [\#719](https://github.com/matrix-org/matrix-js-sdk/pull/719)
 * Fix filepanel also filtering main timeline with LL turned on.
   [\#716](https://github.com/matrix-org/matrix-js-sdk/pull/716)
 * Remove lazy loaded members when leaving room
   [\#711](https://github.com/matrix-org/matrix-js-sdk/pull/711)
 * Fix: show spinner again while recovering from connection error
   [\#702](https://github.com/matrix-org/matrix-js-sdk/pull/702)
 * Add method to query LL state in client
   [\#714](https://github.com/matrix-org/matrix-js-sdk/pull/714)
 * Fix: also load invited members when lazy loading members
   [\#707](https://github.com/matrix-org/matrix-js-sdk/pull/707)
 * Pass through function to discard megolm session
   [\#704](https://github.com/matrix-org/matrix-js-sdk/pull/704)

Changes in [0.10.9](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.9) (2018-09-03)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.9-rc.2...v0.10.9)

 * No changes since rc.2

Changes in [0.10.9-rc.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.9-rc.2) (2018-08-31)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.9-rc.1...v0.10.9-rc.2)

 * Fix for "otherMember.getAvatarUrl is not a function"
   [\#708](https://github.com/matrix-org/matrix-js-sdk/pull/708)

Changes in [0.10.9-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.9-rc.1) (2018-08-30)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.8...v0.10.9-rc.1)

 * Fix DM avatar
   [\#706](https://github.com/matrix-org/matrix-js-sdk/pull/706)
 * Lazy loading: avoid loading members at initial sync for e2e rooms
   [\#699](https://github.com/matrix-org/matrix-js-sdk/pull/699)
 * Improve setRoomEncryption guard against multiple m.room.encryption st…
   [\#700](https://github.com/matrix-org/matrix-js-sdk/pull/700)
 * Revert "Lazy loading: don't block on setting up room crypto"
   [\#698](https://github.com/matrix-org/matrix-js-sdk/pull/698)
 * Lazy loading: don't block on setting up room crypto
   [\#696](https://github.com/matrix-org/matrix-js-sdk/pull/696)
 * Add getVisibleRooms()
   [\#695](https://github.com/matrix-org/matrix-js-sdk/pull/695)
 * Add wrapper around getJoinedMemberCount()
   [\#697](https://github.com/matrix-org/matrix-js-sdk/pull/697)
 * Api to fetch events via /room/.../event/..
   [\#694](https://github.com/matrix-org/matrix-js-sdk/pull/694)
 * Support for room upgrades
   [\#693](https://github.com/matrix-org/matrix-js-sdk/pull/693)
 * Lazy loading of room members
   [\#691](https://github.com/matrix-org/matrix-js-sdk/pull/691)

Changes in [0.10.8](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.8) (2018-08-20)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.8-rc.1...v0.10.8)

 * No changes since rc.1

Changes in [0.10.8-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.8-rc.1) (2018-08-16)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.7...v0.10.8-rc.1)

 * Add getVersion to Room
   [\#689](https://github.com/matrix-org/matrix-js-sdk/pull/689)
 * Add getSyncStateData()
   [\#680](https://github.com/matrix-org/matrix-js-sdk/pull/680)
 * Send sync error to listener
   [\#679](https://github.com/matrix-org/matrix-js-sdk/pull/679)
 * make sure room.tags is always a valid object to avoid crashes
   [\#675](https://github.com/matrix-org/matrix-js-sdk/pull/675)
 * Fix infinite spinner upon joining a room
   [\#673](https://github.com/matrix-org/matrix-js-sdk/pull/673)

Changes in [0.10.7](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.7) (2018-07-30)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.7-rc.1...v0.10.7)

 * No changes since rc.1

Changes in [0.10.7-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.7-rc.1) (2018-07-24)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.6...v0.10.7-rc.1)

 * encrypt for invited users if history visibility allows.
   [\#666](https://github.com/matrix-org/matrix-js-sdk/pull/666)

Changes in [0.10.6](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.6) (2018-07-09)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.6-rc.1...v0.10.6)

 * No changes since rc.1

Changes in [0.10.6-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.6-rc.1) (2018-07-06)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.5...v0.10.6-rc.1)

 * Expose event decryption error via Event.decrypted event
   [\#665](https://github.com/matrix-org/matrix-js-sdk/pull/665)
 * Add decryption error codes to base.DecryptionError
   [\#663](https://github.com/matrix-org/matrix-js-sdk/pull/663)

Changes in [0.10.5](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.5) (2018-06-29)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.5-rc.1...v0.10.5)

 * No changes since rc.1

Changes in [0.10.5-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.5-rc.1) (2018-06-21)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.4...v0.10.5-rc.1)

 * fix auth header and filename=undefined
   [\#659](https://github.com/matrix-org/matrix-js-sdk/pull/659)
 * allow setting the output device for webrtc calls
   [\#650](https://github.com/matrix-org/matrix-js-sdk/pull/650)
 * arguments true and false are actually invalid
   [\#596](https://github.com/matrix-org/matrix-js-sdk/pull/596)
 * fix typo where `headers` was not being used and thus sent wrong content-type
   [\#643](https://github.com/matrix-org/matrix-js-sdk/pull/643)
 * fix some documentation typos
   [\#642](https://github.com/matrix-org/matrix-js-sdk/pull/642)

Changes in [0.10.4](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.4) (2018-06-12)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.4-rc.1...v0.10.4)

 * No changes since rc.1

Changes in [0.10.4-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.4-rc.1) (2018-06-06)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.3...v0.10.4-rc.1)

 * check whether notif level is undefined, because `0` is falsey
   [\#651](https://github.com/matrix-org/matrix-js-sdk/pull/651)

Changes in [0.10.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.3) (2018-05-25)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.3-rc.1...v0.10.3)

 * No changes since v0.10.3-rc.1

Changes in [0.10.3-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.3-rc.1) (2018-05-24)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.2...v0.10.3-rc.1)

BREAKING CHANGE
---------------

The deprecated 'callback' parameter has been removed from MatrixBaseApis.deactivateAccount

 * Add `erase` option to deactivateAccount
   [\#649](https://github.com/matrix-org/matrix-js-sdk/pull/649)
 * Emit Session.no_consent when M_CONSENT_NOT_GIVEN received
   [\#647](https://github.com/matrix-org/matrix-js-sdk/pull/647)

Changes in [0.10.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.2) (2018-04-30)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.2-rc.1...v0.10.2)

 * No changes from rc.1

Changes in [0.10.2-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.2-rc.1) (2018-04-25)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.1...v0.10.2-rc.1)

 * Ignore inserts of dup inbound group sessions, pt 2
   [\#641](https://github.com/matrix-org/matrix-js-sdk/pull/641)
 * Ignore inserts of duplicate inbound group sessions
   [\#639](https://github.com/matrix-org/matrix-js-sdk/pull/639)
 * Log IDB errors
   [\#638](https://github.com/matrix-org/matrix-js-sdk/pull/638)
 * Remove not very useful but veryv spammy log line
   [\#632](https://github.com/matrix-org/matrix-js-sdk/pull/632)
 * Switch event type to m.sticker.
   [\#628](https://github.com/matrix-org/matrix-js-sdk/pull/628)

Changes in [0.10.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.1) (2018-04-12)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.0...v0.10.1)

 * Log IDB errors
   [\#638](https://github.com/matrix-org/matrix-js-sdk/pull/638)
 * Ignore inserts of duplicate inbound group sessions
   [\#639](https://github.com/matrix-org/matrix-js-sdk/pull/639)
 * Ignore inserts of dup inbound group sessions, pt 2
   [\#641](https://github.com/matrix-org/matrix-js-sdk/pull/641)

Changes in [0.10.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.0) (2018-04-11)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.0-rc.2...v0.10.0)

 * No changes

Changes in [0.10.0-rc.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.0-rc.2) (2018-04-09)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.10.0-rc.1...v0.10.0-rc.2)

 * Add wrapper for group join API
 * Add wrapped API to set group join\_policy

Changes in [0.10.0-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.10.0-rc.1) (2018-03-19)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.9.2...v0.10.0-rc.1)

 * Fix duplicated state events in timeline from peek
   [\#630](https://github.com/matrix-org/matrix-js-sdk/pull/630)
 * Create indexeddb worker when starting the store
   [\#627](https://github.com/matrix-org/matrix-js-sdk/pull/627)
 * Fix indexeddb logging
   [\#626](https://github.com/matrix-org/matrix-js-sdk/pull/626)
 * Don't do /keys/changes on incremental sync
   [\#625](https://github.com/matrix-org/matrix-js-sdk/pull/625)
 * Don't mark devicelist dirty unnecessarily
   [\#623](https://github.com/matrix-org/matrix-js-sdk/pull/623)
 * Cache the joined member count for a room state
   [\#619](https://github.com/matrix-org/matrix-js-sdk/pull/619)
 * Fix JS doc
   [\#618](https://github.com/matrix-org/matrix-js-sdk/pull/618)
 * Precompute push actions for state events
   [\#617](https://github.com/matrix-org/matrix-js-sdk/pull/617)
 * Fix bug where global "Never send to unverified..." is ignored
   [\#616](https://github.com/matrix-org/matrix-js-sdk/pull/616)
 * Intern legacy top-level 'membership' field
   [\#615](https://github.com/matrix-org/matrix-js-sdk/pull/615)
 * Don't synthesize RR for m.room.redaction as causes the RR to go missing.
   [\#598](https://github.com/matrix-org/matrix-js-sdk/pull/598)
 * Make Events create Dates on demand
   [\#613](https://github.com/matrix-org/matrix-js-sdk/pull/613)
 * Stop cloning events when adding to state
   [\#612](https://github.com/matrix-org/matrix-js-sdk/pull/612)
 * De-dup code: use the initialiseState function
   [\#611](https://github.com/matrix-org/matrix-js-sdk/pull/611)
 * Create sentinel members on-demand
   [\#610](https://github.com/matrix-org/matrix-js-sdk/pull/610)
 * Some more doc on how sentinels work
   [\#609](https://github.com/matrix-org/matrix-js-sdk/pull/609)
 * Migrate room encryption store to crypto store
   [\#597](https://github.com/matrix-org/matrix-js-sdk/pull/597)
 * add parameter to getIdentityServerUrl to strip the protocol for invites
   [\#600](https://github.com/matrix-org/matrix-js-sdk/pull/600)
 * Move Device Tracking Data to Crypto Store
   [\#594](https://github.com/matrix-org/matrix-js-sdk/pull/594)
 * Optimise pushprocessor
   [\#591](https://github.com/matrix-org/matrix-js-sdk/pull/591)
 * Set event error before emitting
   [\#592](https://github.com/matrix-org/matrix-js-sdk/pull/592)
 * Add event type for stickers [WIP]
   [\#590](https://github.com/matrix-org/matrix-js-sdk/pull/590)
 * Migrate inbound sessions to cryptostore
   [\#587](https://github.com/matrix-org/matrix-js-sdk/pull/587)
 * Disambiguate names if they contain an mxid
   [\#588](https://github.com/matrix-org/matrix-js-sdk/pull/588)
 * Check for sessions in indexeddb before migrating
   [\#585](https://github.com/matrix-org/matrix-js-sdk/pull/585)
 * Emit an event for crypto store migration
   [\#586](https://github.com/matrix-org/matrix-js-sdk/pull/586)
 * Supporting fixes For making UnknownDeviceDialog not pop up automatically
   [\#575](https://github.com/matrix-org/matrix-js-sdk/pull/575)
 * Move sessions to the crypto store
   [\#584](https://github.com/matrix-org/matrix-js-sdk/pull/584)
 * Change crypto store transaction API
   [\#582](https://github.com/matrix-org/matrix-js-sdk/pull/582)
 * Add some missed copyright notices
   [\#581](https://github.com/matrix-org/matrix-js-sdk/pull/581)
 * Move Olm account to IndexedDB
   [\#579](https://github.com/matrix-org/matrix-js-sdk/pull/579)
 * Fix logging of DecryptionErrors to be more useful
   [\#580](https://github.com/matrix-org/matrix-js-sdk/pull/580)
 * [BREAKING] Change the behaviour of the unverfied devices blacklist flag
   [\#568](https://github.com/matrix-org/matrix-js-sdk/pull/568)
 * Support set_presence=offline for syncing
   [\#557](https://github.com/matrix-org/matrix-js-sdk/pull/557)
 * Consider cases where the sender may not redact their own event
   [\#556](https://github.com/matrix-org/matrix-js-sdk/pull/556)

Changes in [0.9.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.9.2) (2017-12-04)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.9.1...v0.9.2)


Changes in [0.9.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.9.1) (2017-11-17)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.9.0...v0.9.1)

 * Fix the force TURN option
   [\#577](https://github.com/matrix-org/matrix-js-sdk/pull/577)

Changes in [0.9.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.9.0) (2017-11-15)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.9.0-rc.1...v0.9.0)


Changes in [0.9.0-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.9.0-rc.1) (2017-11-10)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.5...v0.9.0-rc.1)

 * Modify addRoomToGroup to allow setting isPublic, create alias
   updateGroupRoomAssociation
   [\#567](https://github.com/matrix-org/matrix-js-sdk/pull/567)
 * Expose more functionality of pushprocessor
   [\#565](https://github.com/matrix-org/matrix-js-sdk/pull/565)
 * Function for working out notif trigger permission
   [\#566](https://github.com/matrix-org/matrix-js-sdk/pull/566)
 * keep track of event ID and timestamp of decrypted messages
   [\#555](https://github.com/matrix-org/matrix-js-sdk/pull/555)
 * Fix notifEvent computation
   [\#564](https://github.com/matrix-org/matrix-js-sdk/pull/564)
 * Fix power level of sentinel members
   [\#563](https://github.com/matrix-org/matrix-js-sdk/pull/563)
 * don't try to decrypt a redacted message (fixes vector-im/riot-web#3744)
   [\#554](https://github.com/matrix-org/matrix-js-sdk/pull/554)
 * Support room notifs
   [\#562](https://github.com/matrix-org/matrix-js-sdk/pull/562)
 * Fix the glob-to-regex code
   [\#558](https://github.com/matrix-org/matrix-js-sdk/pull/558)

Changes in [0.8.5](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.5) (2017-10-16)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.5-rc.1...v0.8.5)

 * Make unknown pushrule conditions not match
   [\#559](https://github.com/matrix-org/matrix-js-sdk/pull/559)

Changes in [0.8.5-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.5-rc.1) (2017-10-13)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.4...v0.8.5-rc.1)

 * Implement wrapper API for removing a room from a group
   [\#553](https://github.com/matrix-org/matrix-js-sdk/pull/553)
 * Fix typo which resulted in stuck key download requests
   [\#552](https://github.com/matrix-org/matrix-js-sdk/pull/552)
 * Store group when it's created
   [\#549](https://github.com/matrix-org/matrix-js-sdk/pull/549)
 * Luke/groups remove rooms users from summary
   [\#548](https://github.com/matrix-org/matrix-js-sdk/pull/548)
 * Clean on prepublish
   [\#546](https://github.com/matrix-org/matrix-js-sdk/pull/546)
 * Implement wrapper APIs for adding rooms to group summary
   [\#545](https://github.com/matrix-org/matrix-js-sdk/pull/545)

Changes in [0.8.4](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.4) (2017-09-21)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.3...v0.8.4)

 * Fix build issue

Changes in [0.8.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.3) (2017-09-20)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.3-rc.1...v0.8.3)

 * No changes

Changes in [0.8.3-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.3-rc.1) (2017-09-19)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.2...v0.8.3-rc.1)

 * consume trailing slash when creating Matrix Client in HS and IS urls
   [\#526](https://github.com/matrix-org/matrix-js-sdk/pull/526)
 * Add ignore users API
   [\#539](https://github.com/matrix-org/matrix-js-sdk/pull/539)
 * Upgrade to jsdoc 3.5.5
   [\#540](https://github.com/matrix-org/matrix-js-sdk/pull/540)
 * Make re-emitting events much more memory efficient
   [\#538](https://github.com/matrix-org/matrix-js-sdk/pull/538)
 * Only re-emit events from Event objects if needed
   [\#536](https://github.com/matrix-org/matrix-js-sdk/pull/536)
 * Handle 'left' users in the deviceList mananagement
   [\#535](https://github.com/matrix-org/matrix-js-sdk/pull/535)
 * Factor out devicelist integration tests to a separate file
   [\#534](https://github.com/matrix-org/matrix-js-sdk/pull/534)
 * Refactor sync._sync as an async function
   [\#533](https://github.com/matrix-org/matrix-js-sdk/pull/533)
 * Add es6 to eslint environments
   [\#532](https://github.com/matrix-org/matrix-js-sdk/pull/532)

Changes in [0.8.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.2) (2017-08-24)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.1...v0.8.2)

 * Handle m.call.* events which are decrypted asynchronously
   [\#530](https://github.com/matrix-org/matrix-js-sdk/pull/530)
 * Re-emit events from, er, Event objects
   [\#529](https://github.com/matrix-org/matrix-js-sdk/pull/529)

Changes in [0.8.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.1) (2017-08-23)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.1-rc.1...v0.8.1)

 * [No changes]

Changes in [0.8.1-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.1-rc.1) (2017-08-22)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.8.0...v0.8.1-rc.1)

 * Fix error handling in interactive-auth
   [\#527](https://github.com/matrix-org/matrix-js-sdk/pull/527)
 * Make lots of OlmDevice asynchronous
   [\#524](https://github.com/matrix-org/matrix-js-sdk/pull/524)
 * Make crypto.decryptMessage return decryption results
   [\#523](https://github.com/matrix-org/matrix-js-sdk/pull/523)

Changes in [0.8.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.8.0) (2017-08-15)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.13...v0.8.0)

BREAKING CHANGE
---------------

In order to support a move to a more scalable storage backend, we need to make
a number of the APIs related end-to-end encryption asynchronous.

This release of the JS-SDK includes the following changes which will affect
applications which support end-to-end encryption:

1. `MatrixClient` now provides a new (asynchronous) method,
   `initCrypto`. Applications which support end-to-end encryption must call
   this method (and wait for it to complete) before calling `startClient`, to
   give the crypto layer a chance to initialise.

2. The following APIs have been changed to return promises:

   * `MatrixClient.getStoredDevicesForUser`
   * `MatrixClient.getStoredDevice`
   * `MatrixClient.setDeviceVerified`
   * `MatrixClient.setDeviceBlocked`
   * `MatrixClient.setDeviceKnown`
   * `MatrixClient.getEventSenderDeviceInfo`
   * `MatrixClient.isEventSenderVerified`
   * `MatrixClient.importRoomKeys`

   Applications using the results of any of the above methods will need to be
   updated to wait for the result of the promise.


3. `MatrixClient.listDeviceKeys` has been removed altogether. It's been
   deprecated for some time. Applications using it should instead be changed to
   use `MatrixClient.getStoredDevices`, which is similar but returns its results
   in a slightly different format.


 * Make bits of `olmlib` asynchronous
   [\#521](https://github.com/matrix-org/matrix-js-sdk/pull/521)
 * Make some of DeviceList asynchronous
   [\#520](https://github.com/matrix-org/matrix-js-sdk/pull/520)
 * Make methods in crypto/algorithms async
   [\#519](https://github.com/matrix-org/matrix-js-sdk/pull/519)
 * Avoid sending unencrypted messages in e2e room
   [\#518](https://github.com/matrix-org/matrix-js-sdk/pull/518)
 * Make tests wait for syncs to happen
   [\#517](https://github.com/matrix-org/matrix-js-sdk/pull/517)
 * Make a load of methods in the 'Crypto' module asynchronous
   [\#510](https://github.com/matrix-org/matrix-js-sdk/pull/510)
 * Set `rawDisplayName` to `userId` if membership has `displayname=null`
   [\#515](https://github.com/matrix-org/matrix-js-sdk/pull/515)
 * Refactor handling of crypto events for async
   [\#508](https://github.com/matrix-org/matrix-js-sdk/pull/508)
 * Let event decryption be asynchronous
   [\#509](https://github.com/matrix-org/matrix-js-sdk/pull/509)
 * Transform `async` functions to bluebird promises
   [\#511](https://github.com/matrix-org/matrix-js-sdk/pull/511)
 * Add more group APIs
   [\#512](https://github.com/matrix-org/matrix-js-sdk/pull/512)
 * Retrying test: wait for localEchoUpdated event
   [\#507](https://github.com/matrix-org/matrix-js-sdk/pull/507)
 * Fix member events breaking on timeline reset, 2
   [\#504](https://github.com/matrix-org/matrix-js-sdk/pull/504)
 * Make bits of the js-sdk api asynchronous
   [\#503](https://github.com/matrix-org/matrix-js-sdk/pull/503)
 * Yet more js-sdk test deflakification
   [\#499](https://github.com/matrix-org/matrix-js-sdk/pull/499)
 * Fix racy 'matrixclient retrying' test
   [\#497](https://github.com/matrix-org/matrix-js-sdk/pull/497)
 * Fix spamming of key-share-requests
   [\#495](https://github.com/matrix-org/matrix-js-sdk/pull/495)
 * Add progress handler to `uploadContent`
   [\#500](https://github.com/matrix-org/matrix-js-sdk/pull/500)
 * Switch matrix-js-sdk to bluebird
   [\#490](https://github.com/matrix-org/matrix-js-sdk/pull/490)
 * Fix some more flakey tests
   [\#492](https://github.com/matrix-org/matrix-js-sdk/pull/492)
 * make the npm test script windows-friendly
   [\#489](https://github.com/matrix-org/matrix-js-sdk/pull/489)
 * Fix a bunch of races in the tests
   [\#488](https://github.com/matrix-org/matrix-js-sdk/pull/488)
 * Fix early return in MatrixClient.setGuestAccess
   [\#487](https://github.com/matrix-org/matrix-js-sdk/pull/487)
 * Remove testUtils.failTest
   [\#486](https://github.com/matrix-org/matrix-js-sdk/pull/486)
 * Add test:watch script
   [\#485](https://github.com/matrix-org/matrix-js-sdk/pull/485)
 * Make it possible to use async/await
   [\#484](https://github.com/matrix-org/matrix-js-sdk/pull/484)
 * Remove m.new_device support
   [\#483](https://github.com/matrix-org/matrix-js-sdk/pull/483)
 * Use access-token in header
   [\#478](https://github.com/matrix-org/matrix-js-sdk/pull/478)
 * Sanity-check response from /thirdparty/protocols
   [\#482](https://github.com/matrix-org/matrix-js-sdk/pull/482)
 * Avoid parsing plain-text errors as JSON
   [\#479](https://github.com/matrix-org/matrix-js-sdk/pull/479)
 * Use external mock-request
   [\#481](https://github.com/matrix-org/matrix-js-sdk/pull/481)
 * Fix some races in the tests
   [\#480](https://github.com/matrix-org/matrix-js-sdk/pull/480)
 * Fall back to MemoryCryptoStore if indexeddb fails
   [\#475](https://github.com/matrix-org/matrix-js-sdk/pull/475)
 * Fix load failure in firefox when indexedDB is disabled
   [\#474](https://github.com/matrix-org/matrix-js-sdk/pull/474)
 * Fix a race in a test
   [\#471](https://github.com/matrix-org/matrix-js-sdk/pull/471)
 * Avoid throwing an unhandled error when the indexeddb is deleted
   [\#470](https://github.com/matrix-org/matrix-js-sdk/pull/470)
 * fix jsdoc
   [\#469](https://github.com/matrix-org/matrix-js-sdk/pull/469)
 * Handle m.forwarded_room_key events
   [\#468](https://github.com/matrix-org/matrix-js-sdk/pull/468)
 * Improve error reporting from indexeddbstore.clearDatabase
   [\#466](https://github.com/matrix-org/matrix-js-sdk/pull/466)
 * Implement sharing of megolm keys
   [\#454](https://github.com/matrix-org/matrix-js-sdk/pull/454)
 * Process received room key requests
   [\#449](https://github.com/matrix-org/matrix-js-sdk/pull/449)
 * Send m.room_key_request events when we fail to decrypt an event
   [\#448](https://github.com/matrix-org/matrix-js-sdk/pull/448)

Changes in [0.7.13](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.13) (2017-06-22)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.12...v0.7.13)

 * Fix failure on Tor browser
   [\#473](https://github.com/matrix-org/matrix-js-sdk/pull/473)
 * Fix issues with firefox private browsing
   [\#472](https://github.com/matrix-org/matrix-js-sdk/pull/472)

Changes in [0.7.12](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.12) (2017-06-19)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.12-rc.1...v0.7.12)

 * No changes


Changes in [0.7.12-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.12-rc.1) (2017-06-15)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.11...v0.7.12-rc.1)

 * allow setting iceTransportPolicy to relay through forceTURN option
   [\#462](https://github.com/matrix-org/matrix-js-sdk/pull/462)

Changes in [0.7.11](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.11) (2017-06-12)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.11-rc.1...v0.7.11)

 * Add a bunch of logging around sending messages
   [\#460](https://github.com/matrix-org/matrix-js-sdk/pull/460)

Changes in [0.7.11-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.11-rc.1) (2017-06-09)
============================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.10...v0.7.11-rc.1)

 * Make TimelineWindow.load resolve quicker if we have the events
   [\#458](https://github.com/matrix-org/matrix-js-sdk/pull/458)
 * Stop peeking when a matrix client is stopped
   [\#451](https://github.com/matrix-org/matrix-js-sdk/pull/451)
 * Update README: Clarify how to install libolm
   [\#450](https://github.com/matrix-org/matrix-js-sdk/pull/450)

Changes in [0.7.10](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.10) (2017-06-02)
==================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.9...v0.7.10)

 * BREAKING CHANGE: The SDK no longer ``require``s ``olm`` - instead it expects
   libolm to be provided as an ``Olm`` global. This will only affect
   applications which use end-to-end encryption. See the
   [README](README.md#end-to-end-encryption-support) for details.

 * indexeddb-crypto-store: fix db deletion
   [\#447](https://github.com/matrix-org/matrix-js-sdk/pull/447)
 * Load Olm from the global rather than requiring it.
   [\#446](https://github.com/matrix-org/matrix-js-sdk/pull/446)

Changes in [0.7.9](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.9) (2017-06-01)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.8...v0.7.9)

 * Initial framework for indexeddb-backed crypto store
   [\#445](https://github.com/matrix-org/matrix-js-sdk/pull/445)
 * Factor out reEmit to a common module
   [\#444](https://github.com/matrix-org/matrix-js-sdk/pull/444)
 * crypto/algorithms/base.js: Convert to es6
   [\#443](https://github.com/matrix-org/matrix-js-sdk/pull/443)
 * maySendRedactionForEvent for userId
   [\#435](https://github.com/matrix-org/matrix-js-sdk/pull/435)
 * MatrixClient: add getUserId()
   [\#441](https://github.com/matrix-org/matrix-js-sdk/pull/441)
 * Run jsdoc on a custom babeling of the source
   [\#442](https://github.com/matrix-org/matrix-js-sdk/pull/442)
 * Add in a public api getStoredDevice allowing clients to get a specific
   device
   [\#439](https://github.com/matrix-org/matrix-js-sdk/pull/439)

Changes in [0.7.8](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.8) (2017-05-22)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.8-rc.1...v0.7.8)

 * No changes


Changes in [0.7.8-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.8-rc.1) (2017-05-19)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.7...v0.7.8-rc.1)

 * Attempt to rework the release-tarball-signing stuff
   [\#438](https://github.com/matrix-org/matrix-js-sdk/pull/438)
 * ability to specify webrtc audio/video inputs for the lib to request
   [\#427](https://github.com/matrix-org/matrix-js-sdk/pull/427)
 * make screen sharing call FF friendly :D
   [\#434](https://github.com/matrix-org/matrix-js-sdk/pull/434)
 * Fix race in device list updates
   [\#431](https://github.com/matrix-org/matrix-js-sdk/pull/431)
 * WebRTC: Support recvonly for video for those without a webcam
   [\#424](https://github.com/matrix-org/matrix-js-sdk/pull/424)
 * Update istanbul to remove minimatch DoS Warning
   [\#422](https://github.com/matrix-org/matrix-js-sdk/pull/422)
 * webrtc/call: Make it much less likely that callIds collide locally
   [\#423](https://github.com/matrix-org/matrix-js-sdk/pull/423)
 * Automatically complete dummy auth
   [\#420](https://github.com/matrix-org/matrix-js-sdk/pull/420)
 * Don't leave the gh-pages branch checked out
   [\#418](https://github.com/matrix-org/matrix-js-sdk/pull/418)

Changes in [0.7.7](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.7) (2017-04-25)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.7-rc.1...v0.7.7)

 * No changes


Changes in [0.7.7-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.7-rc.1) (2017-04-21)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.6...v0.7.7-rc.1)

 * Automatically complete dummy auth
   [\#420](https://github.com/matrix-org/matrix-js-sdk/pull/420)


Changes in [0.7.6](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.6) (2017-04-12)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.6-rc.2...v0.7.6)

 * No changes

Changes in [0.7.6-rc.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.6-rc.2) (2017-04-10)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.6-rc.1...v0.7.6-rc.2)

 * Add feature detection for webworkers
   [\#416](https://github.com/matrix-org/matrix-js-sdk/pull/416)
 * Fix release script
   [\#415](https://github.com/matrix-org/matrix-js-sdk/pull/415)

Changes in [0.7.6-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.6-rc.1) (2017-04-07)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.5...v0.7.6-rc.1)

 * Make indexeddb save after the first sync
   [\#414](https://github.com/matrix-org/matrix-js-sdk/pull/414)
 * Make indexeddb startup faster
   [\#413](https://github.com/matrix-org/matrix-js-sdk/pull/413)
 * Add ability to do indexeddb sync work in webworker
   [\#412](https://github.com/matrix-org/matrix-js-sdk/pull/412)
 * Move more functionality to the indexeddb backend
   [\#409](https://github.com/matrix-org/matrix-js-sdk/pull/409)
 * Indicate syncState ERROR after many failed /syncs
   [\#410](https://github.com/matrix-org/matrix-js-sdk/pull/410)
 * Further reorganising of indexeddb sync code
   [\#407](https://github.com/matrix-org/matrix-js-sdk/pull/407)
 * Change interface of IndexedDBStore: hide internals
   [\#406](https://github.com/matrix-org/matrix-js-sdk/pull/406)
 * Don't be SYNCING until updating from the server
   [\#405](https://github.com/matrix-org/matrix-js-sdk/pull/405)
 * Don't log the entire /sync response
   [\#403](https://github.com/matrix-org/matrix-js-sdk/pull/403)
 * webrtc/call: Assign MediaStream to video element srcObject
   [\#402](https://github.com/matrix-org/matrix-js-sdk/pull/402)
 * Fix undefined reference in http-api
   [\#400](https://github.com/matrix-org/matrix-js-sdk/pull/400)
 * Add copyright header to event-timeline.js
   [\#382](https://github.com/matrix-org/matrix-js-sdk/pull/382)
 * client: fix docs for user-scoped account_data events
   [\#397](https://github.com/matrix-org/matrix-js-sdk/pull/397)
 * Add a CONTRIBUTING for js-sdk
   [\#399](https://github.com/matrix-org/matrix-js-sdk/pull/399)
 * Fix leaking room state objects on limited sync responses
   [\#395](https://github.com/matrix-org/matrix-js-sdk/pull/395)
 * Extend 'ignoreFailure' to be 'background'
   [\#396](https://github.com/matrix-org/matrix-js-sdk/pull/396)
 * Add x_show_msisdn parameter to register calls
   [\#388](https://github.com/matrix-org/matrix-js-sdk/pull/388)
 * Update event redaction to keep sender and origin_server_ts
   [\#394](https://github.com/matrix-org/matrix-js-sdk/pull/394)
 * Handle 'limited' timeline responses in the SyncAccumulator
   [\#393](https://github.com/matrix-org/matrix-js-sdk/pull/393)
 * Give a better error message if the HS doesn't support msisdn registeration
   [\#391](https://github.com/matrix-org/matrix-js-sdk/pull/391)
 * Add getEmailSid
   [\#383](https://github.com/matrix-org/matrix-js-sdk/pull/383)
 * Add m.login.email.identity support to UI auth
   [\#380](https://github.com/matrix-org/matrix-js-sdk/pull/380)
 * src/client.js: Fix incorrect roomId reference in VoIP glare code
   [\#381](https://github.com/matrix-org/matrix-js-sdk/pull/381)
 * add .editorconfig
   [\#379](https://github.com/matrix-org/matrix-js-sdk/pull/379)
 * Store account data in the same way as room data
   [\#377](https://github.com/matrix-org/matrix-js-sdk/pull/377)
 * Upload one-time keys on /sync rather than a timer
   [\#376](https://github.com/matrix-org/matrix-js-sdk/pull/376)
 * Increase the WRITE_DELAY on database syncing
   [\#374](https://github.com/matrix-org/matrix-js-sdk/pull/374)
 * Make deleteAllData() return a Promise
   [\#373](https://github.com/matrix-org/matrix-js-sdk/pull/373)
 * Don't include banned users in the room name
   [\#372](https://github.com/matrix-org/matrix-js-sdk/pull/372)
 * Support IndexedDB as a backing store
   [\#363](https://github.com/matrix-org/matrix-js-sdk/pull/363)
 * Poll /sync with a short timeout while catching up
   [\#370](https://github.com/matrix-org/matrix-js-sdk/pull/370)
 * Make test coverage work again
   [\#368](https://github.com/matrix-org/matrix-js-sdk/pull/368)
 * Add docs to event
   [\#367](https://github.com/matrix-org/matrix-js-sdk/pull/367)
 * Keep the device-sync token more up-to-date
   [\#366](https://github.com/matrix-org/matrix-js-sdk/pull/366)
 * Fix race conditions in device list download
   [\#365](https://github.com/matrix-org/matrix-js-sdk/pull/365)
 * Fix the unban method
   [\#364](https://github.com/matrix-org/matrix-js-sdk/pull/364)
 * Spread out device verification work
   [\#362](https://github.com/matrix-org/matrix-js-sdk/pull/362)
 * Clean up/improve e2e logging
   [\#361](https://github.com/matrix-org/matrix-js-sdk/pull/361)
 * Fix decryption of events whose key arrives later
   [\#360](https://github.com/matrix-org/matrix-js-sdk/pull/360)
 * Invalidate device lists when encryption is enabled in a room
   [\#359](https://github.com/matrix-org/matrix-js-sdk/pull/359)
 * Switch from jasmine to mocha + expect + lolex
   [\#358](https://github.com/matrix-org/matrix-js-sdk/pull/358)
 * Install source-map-support in each test
   [\#356](https://github.com/matrix-org/matrix-js-sdk/pull/356)
 * searchMessageText: avoid setting keys=undefined
   [\#357](https://github.com/matrix-org/matrix-js-sdk/pull/357)
 * realtime-callbacks: pass `global` as `this`
   [\#355](https://github.com/matrix-org/matrix-js-sdk/pull/355)
 * Make the tests work without olm
   [\#354](https://github.com/matrix-org/matrix-js-sdk/pull/354)
 * Tests: Factor out TestClient and use it in crypto tests
   [\#353](https://github.com/matrix-org/matrix-js-sdk/pull/353)
 * Fix some lint
   [\#352](https://github.com/matrix-org/matrix-js-sdk/pull/352)
 * Make a sig for source tarballs when releasing
   [\#351](https://github.com/matrix-org/matrix-js-sdk/pull/351)
 * When doing a pre-release, don't bother merging to master and develop.
   [\#350](https://github.com/matrix-org/matrix-js-sdk/pull/350)

Changes in [0.7.5](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.5) (2017-02-04)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.5-rc.3...v0.7.5)

No changes from 0.7.5-rc.3

Changes in [0.7.5-rc.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.5-rc.3) (2017-02-03)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.5-rc.2...v0.7.5-rc.3)

 * Include DeviceInfo in deviceVerificationChanged events
   [a3cc8eb](https://github.com/matrix-org/matrix-js-sdk/commit/a3cc8eb1f6d165576a342596f638316721cb26b6)
 * Fix device list update
   [5fd7410](https://github.com/matrix-org/matrix-js-sdk/commit/5fd74109ffc56b73deb40c2604d84c38b8032c40)


Changes in [0.7.5-rc.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.5-rc.2) (2017-02-03)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.5-rc.1...v0.7.5-rc.2)

 * Use the device change notifications interface
   [\#348](https://github.com/matrix-org/matrix-js-sdk/pull/348)
 * Rewrite the device key query logic
   [\#347](https://github.com/matrix-org/matrix-js-sdk/pull/347)

Changes in [0.7.5-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.5-rc.1) (2017-02-03)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.4...v0.7.5-rc.1)

 * Support for blacklisting unverified devices, both per-room and globally
   [\#336](https://github.com/matrix-org/matrix-js-sdk/pull/336)
 * track errors when events can't be sent
   [\#349](https://github.com/matrix-org/matrix-js-sdk/pull/349)
 * Factor out device list management
   [\#346](https://github.com/matrix-org/matrix-js-sdk/pull/346)
 * Support for warning users when unknown devices show up
   [\#335](https://github.com/matrix-org/matrix-js-sdk/pull/335)
 * Enable sourcemaps in browserified distro
   [\#345](https://github.com/matrix-org/matrix-js-sdk/pull/345)
 * Record all e2e room settings in localstorage
   [\#344](https://github.com/matrix-org/matrix-js-sdk/pull/344)
 * Make Olm work with browserified js-sdk
   [\#340](https://github.com/matrix-org/matrix-js-sdk/pull/340)
 * Make browserify a dev dependency
   [\#339](https://github.com/matrix-org/matrix-js-sdk/pull/339)
 * Allow single line brace-style
   [\#338](https://github.com/matrix-org/matrix-js-sdk/pull/338)
 * Turn on comma-dangle for function calls
   [\#333](https://github.com/matrix-org/matrix-js-sdk/pull/333)
 * Add prefer-const
   [\#331](https://github.com/matrix-org/matrix-js-sdk/pull/331)
 * Support for importing and exporting megolm sessions
   [\#326](https://github.com/matrix-org/matrix-js-sdk/pull/326)
 * Fix linting on all tests
   [\#329](https://github.com/matrix-org/matrix-js-sdk/pull/329)
 * Fix ESLint warnings and errors
   [\#325](https://github.com/matrix-org/matrix-js-sdk/pull/325)
 * BREAKING CHANGE: Remove WebStorageStore
   [\#324](https://github.com/matrix-org/matrix-js-sdk/pull/324)

Changes in [0.7.4](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.4) (2017-01-16)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.4-rc.1...v0.7.4)

 * Fix non-conference calling

Changes in [0.7.4-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.4-rc.1) (2017-01-13)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.3...v0.7.4-rc.1)

 * Remove babel-polyfill
   [\#321](https://github.com/matrix-org/matrix-js-sdk/pull/321)
 * Update build process for ES6
   [\#320](https://github.com/matrix-org/matrix-js-sdk/pull/320)
 * 'babel' is not a babel package anymore
   [\#319](https://github.com/matrix-org/matrix-js-sdk/pull/319)
 * Add Babel for ES6 support
   [\#318](https://github.com/matrix-org/matrix-js-sdk/pull/318)
 * Move screen sharing check/error
   [\#317](https://github.com/matrix-org/matrix-js-sdk/pull/317)
 * release.sh: Bail early if there are uncommitted changes
   [\#316](https://github.com/matrix-org/matrix-js-sdk/pull/316)

Changes in [0.7.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.3) (2017-01-04)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.2...v0.7.3)

 * User presence list feature
   [\#310](https://github.com/matrix-org/matrix-js-sdk/pull/310)
 * Allow clients the ability to set a default local timeout
   [\#313](https://github.com/matrix-org/matrix-js-sdk/pull/313)
 * Add API to delete threepid
   [\#312](https://github.com/matrix-org/matrix-js-sdk/pull/312)

Changes in [0.7.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.2) (2016-12-15)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.1...v0.7.2)

 * Bump to Olm 2.0
   [\#309](https://github.com/matrix-org/matrix-js-sdk/pull/309)
 * Sanity check payload length before encrypting
   [\#307](https://github.com/matrix-org/matrix-js-sdk/pull/307)
 * Remove dead _sendPingToDevice function
   [\#308](https://github.com/matrix-org/matrix-js-sdk/pull/308)
 * Add setRoomDirectoryVisibilityAppService
   [\#306](https://github.com/matrix-org/matrix-js-sdk/pull/306)
 * Update release script to do signed releases
   [\#305](https://github.com/matrix-org/matrix-js-sdk/pull/305)
 * e2e: Wait for pending device lists
   [\#304](https://github.com/matrix-org/matrix-js-sdk/pull/304)
 * Start a new megolm session when devices are blacklisted
   [\#303](https://github.com/matrix-org/matrix-js-sdk/pull/303)
 * E2E: Download our own devicelist on startup
   [\#302](https://github.com/matrix-org/matrix-js-sdk/pull/302)

Changes in [0.7.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.1) (2016-12-09)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.1-rc.1...v0.7.1)

No changes


Changes in [0.7.1-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.1-rc.1) (2016-12-05)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.7.0...v0.7.1-rc.1)

 * Avoid NPE when no sessionStore is given
   [\#300](https://github.com/matrix-org/matrix-js-sdk/pull/300)
 * Improve decryption error messages
   [\#299](https://github.com/matrix-org/matrix-js-sdk/pull/299)
 * Revert "Use native Array.isArray when available."
   [\#283](https://github.com/matrix-org/matrix-js-sdk/pull/283)
 * Use native Array.isArray when available.
   [\#282](https://github.com/matrix-org/matrix-js-sdk/pull/282)

Changes in [0.7.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.7.0) (2016-11-18)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.4...v0.7.0)

 * Avoid a packetstorm of device queries on startup
   [\#297](https://github.com/matrix-org/matrix-js-sdk/pull/297)
 * E2E: Check devices to share keys with on each send
   [\#295](https://github.com/matrix-org/matrix-js-sdk/pull/295)
 * Apply unknown-keyshare mitigations
   [\#296](https://github.com/matrix-org/matrix-js-sdk/pull/296)
 * distinguish unknown users from deviceless users
   [\#294](https://github.com/matrix-org/matrix-js-sdk/pull/294)
 * Allow starting client with initialSyncLimit = 0
   [\#293](https://github.com/matrix-org/matrix-js-sdk/pull/293)
 * Make timeline-window _unpaginate public and rename to unpaginate
   [\#289](https://github.com/matrix-org/matrix-js-sdk/pull/289)
 * Send a STOPPED sync updated after call to stopClient
   [\#286](https://github.com/matrix-org/matrix-js-sdk/pull/286)
 * Fix bug in verifying megolm event senders
   [\#292](https://github.com/matrix-org/matrix-js-sdk/pull/292)
 * Handle decryption of events after they arrive
   [\#288](https://github.com/matrix-org/matrix-js-sdk/pull/288)
 * Fix examples.
   [\#287](https://github.com/matrix-org/matrix-js-sdk/pull/287)
 * Add a travis.yml
   [\#278](https://github.com/matrix-org/matrix-js-sdk/pull/278)
 * Encrypt all events, including 'm.call.*'
   [\#277](https://github.com/matrix-org/matrix-js-sdk/pull/277)
 * Ignore reshares of known megolm sessions
   [\#276](https://github.com/matrix-org/matrix-js-sdk/pull/276)
 * Log to the console on unknown session
   [\#274](https://github.com/matrix-org/matrix-js-sdk/pull/274)
 * Make it easier for SDK users to wrap prevailing the 'request' function
   [\#273](https://github.com/matrix-org/matrix-js-sdk/pull/273)

Changes in [0.6.4](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.4) (2016-11-04)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.4-rc.2...v0.6.4)

 * Change release script to pass version by environment variable


Changes in [0.6.4-rc.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.4-rc.2) (2016-11-02)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.4-rc.1...v0.6.4-rc.2)

 * Add getRoomTags method to client
   [\#236](https://github.com/matrix-org/matrix-js-sdk/pull/236)

Changes in [0.6.4-rc.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.4-rc.1) (2016-11-02)
==========================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.3...v0.6.4-rc.1)

Breaking Changes
----------------
 * Bundled version of the JS SDK are no longer versioned along with
   source files in the dist/ directory. As of this release, they
   will be included in the release tarball, but not the source
   repository.

Other Changes
-------------
 * More fixes to the release script
   [\#272](https://github.com/matrix-org/matrix-js-sdk/pull/272)
 * Update the release process to use github releases
   [\#271](https://github.com/matrix-org/matrix-js-sdk/pull/271)
 * Don't package the world when we release
   [\#270](https://github.com/matrix-org/matrix-js-sdk/pull/270)
 * Add ability to set a filter prior to the first /sync
   [\#269](https://github.com/matrix-org/matrix-js-sdk/pull/269)
 * Sign one-time keys, and verify their signatures
   [\#243](https://github.com/matrix-org/matrix-js-sdk/pull/243)
 * Check for duplicate message indexes for group messages
   [\#241](https://github.com/matrix-org/matrix-js-sdk/pull/241)
 * Rotate megolm sessions
   [\#240](https://github.com/matrix-org/matrix-js-sdk/pull/240)
 * Check recipient and sender in Olm messages
   [\#239](https://github.com/matrix-org/matrix-js-sdk/pull/239)
 * Consistency checks for E2E device downloads
   [\#237](https://github.com/matrix-org/matrix-js-sdk/pull/237)
 * Support User-Interactive auth for delete device
   [\#235](https://github.com/matrix-org/matrix-js-sdk/pull/235)
 * Utility to help with interactive auth
   [\#234](https://github.com/matrix-org/matrix-js-sdk/pull/234)
 * Fix sync breaking when an invalid filterId is in localStorage
   [\#228](https://github.com/matrix-org/matrix-js-sdk/pull/228)

Changes in [0.6.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.3) (2016-10-12)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.2...v0.6.3)

Breaking Changes
----------------
 * Add a 'RECONNECTING' state to the sync states. This is an additional state
   between 'SYNCING' and 'ERROR', so most clients should not notice.

Other Changes
----------------
 * Fix params getting replaced on register calls
   [\#233](https://github.com/matrix-org/matrix-js-sdk/pull/233)
 * Fix potential 30s delay on reconnect
   [\#232](https://github.com/matrix-org/matrix-js-sdk/pull/232)
 * uploadContent: Attempt some consistency between browser and node
   [\#230](https://github.com/matrix-org/matrix-js-sdk/pull/230)
 * Fix error handling on uploadContent
   [\#229](https://github.com/matrix-org/matrix-js-sdk/pull/229)
 * Fix uploadContent for node.js
   [\#226](https://github.com/matrix-org/matrix-js-sdk/pull/226)
 * Don't emit ERROR until a keepalive poke fails
   [\#223](https://github.com/matrix-org/matrix-js-sdk/pull/223)
 * Function to get the fallback url for interactive auth
   [\#224](https://github.com/matrix-org/matrix-js-sdk/pull/224)
 * Revert "Handle the first /sync failure differently."
   [\#222](https://github.com/matrix-org/matrix-js-sdk/pull/222)

Changes in [0.6.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.2) (2016-10-05)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.1...v0.6.2)

 * Check dependencies aren't on develop in release.sh
   [\#221](https://github.com/matrix-org/matrix-js-sdk/pull/221)
 * Fix checkTurnServers leak on logout
   [\#220](https://github.com/matrix-org/matrix-js-sdk/pull/220)
 * Fix leak of file upload objects
   [\#219](https://github.com/matrix-org/matrix-js-sdk/pull/219)
 * crypto: remove duplicate code
   [\#218](https://github.com/matrix-org/matrix-js-sdk/pull/218)
 * Add API for 3rd party location lookup
   [\#217](https://github.com/matrix-org/matrix-js-sdk/pull/217)
 * Handle the first /sync failure differently.
   [\#216](https://github.com/matrix-org/matrix-js-sdk/pull/216)

Changes in [0.6.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.1) (2016-09-21)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.6.0...v0.6.1)

 * Fix the ed25519 key checking
   [\#215](https://github.com/matrix-org/matrix-js-sdk/pull/215)
 * Add MatrixClient.getEventSenderDeviceInfo()
   [\#214](https://github.com/matrix-org/matrix-js-sdk/pull/214)

Changes in [0.6.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.6.0) (2016-09-21)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.6...v0.6.0)

 * Pull user device list on join
   [\#212](https://github.com/matrix-org/matrix-js-sdk/pull/212)
 * Fix sending of oh_hais on bad sessions
   [\#213](https://github.com/matrix-org/matrix-js-sdk/pull/213)
 * Support /publicRooms pagination
   [\#211](https://github.com/matrix-org/matrix-js-sdk/pull/211)
 * Update the olm library version to 1.3.0
   [\#205](https://github.com/matrix-org/matrix-js-sdk/pull/205)
 * Comment what the logic in uploadKeys does
   [\#209](https://github.com/matrix-org/matrix-js-sdk/pull/209)
 * Include keysProved and keysClaimed in the local echo for events we send.
   [\#210](https://github.com/matrix-org/matrix-js-sdk/pull/210)
 * Check if we need to upload new one-time keys every 10 minutes
   [\#208](https://github.com/matrix-org/matrix-js-sdk/pull/208)
 * Reset oneTimeKey to null on each loop iteration.
   [\#207](https://github.com/matrix-org/matrix-js-sdk/pull/207)
 * Add getKeysProved and getKeysClaimed methods to MatrixEvent.
   [\#206](https://github.com/matrix-org/matrix-js-sdk/pull/206)
 * Send a 'm.new_device' when we get a message for an unknown group session
   [\#204](https://github.com/matrix-org/matrix-js-sdk/pull/204)
 * Introduce EventTimelineSet, filtered timelines and global notif timeline.
   [\#196](https://github.com/matrix-org/matrix-js-sdk/pull/196)
 * Wrap the crypto event handlers in try/catch blocks
   [\#203](https://github.com/matrix-org/matrix-js-sdk/pull/203)
 * Show warnings on to-device decryption fail
   [\#202](https://github.com/matrix-org/matrix-js-sdk/pull/202)
 * s/Displayname/DisplayName/
   [\#201](https://github.com/matrix-org/matrix-js-sdk/pull/201)
 * OH HAI
   [\#200](https://github.com/matrix-org/matrix-js-sdk/pull/200)
 * Share the current ratchet with new members
   [\#199](https://github.com/matrix-org/matrix-js-sdk/pull/199)
 * Move crypto bits into a subdirectory
   [\#198](https://github.com/matrix-org/matrix-js-sdk/pull/198)
 * Refactor event handling in Crypto
   [\#197](https://github.com/matrix-org/matrix-js-sdk/pull/197)
 * Don't create Olm sessions proactively
   [\#195](https://github.com/matrix-org/matrix-js-sdk/pull/195)
 * Use to-device events for key sharing
   [\#194](https://github.com/matrix-org/matrix-js-sdk/pull/194)
 * README: callbacks deprecated
   [\#193](https://github.com/matrix-org/matrix-js-sdk/pull/193)
 * Fix sender verification for megolm messages
   [\#192](https://github.com/matrix-org/matrix-js-sdk/pull/192)
 * Use `ciphertext` instead of `body` in megolm events
   [\#191](https://github.com/matrix-org/matrix-js-sdk/pull/191)
 * Add debug methods to get the state of OlmSessions
   [\#189](https://github.com/matrix-org/matrix-js-sdk/pull/189)
 * MatrixClient.getStoredDevicesForUser
   [\#190](https://github.com/matrix-org/matrix-js-sdk/pull/190)
 * Olm-related cleanups
   [\#188](https://github.com/matrix-org/matrix-js-sdk/pull/188)
 * Update to fixed olmlib
   [\#187](https://github.com/matrix-org/matrix-js-sdk/pull/187)
 * always play audio out of the remoteAudioElement if it exists.
   [\#186](https://github.com/matrix-org/matrix-js-sdk/pull/186)
 * Fix exceptions where HTMLMediaElement loads and plays race
   [\#185](https://github.com/matrix-org/matrix-js-sdk/pull/185)
 * Reset megolm session when people join/leave the room
   [\#183](https://github.com/matrix-org/matrix-js-sdk/pull/183)
 * Fix exceptions when dealing with redactions
   [\#184](https://github.com/matrix-org/matrix-js-sdk/pull/184)

Changes in [0.5.6](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.6) (2016-08-28)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.5...v0.5.6)

 * Put all of the megolm keys in one room message
   [\#182](https://github.com/matrix-org/matrix-js-sdk/pull/182)
 * Reinstate device blocking for simple Olm
   [\#181](https://github.com/matrix-org/matrix-js-sdk/pull/181)
 * support for unpacking megolm keys
   [\#180](https://github.com/matrix-org/matrix-js-sdk/pull/180)
 * Send out megolm keys when we start a megolm session
   [\#179](https://github.com/matrix-org/matrix-js-sdk/pull/179)
 * Change the result structure for ensureOlmSessionsForUsers
   [\#178](https://github.com/matrix-org/matrix-js-sdk/pull/178)
 * Factor out a function for doing olm encryption
   [\#177](https://github.com/matrix-org/matrix-js-sdk/pull/177)
 * Move DeviceInfo and DeviceVerification to separate module
   [\#175](https://github.com/matrix-org/matrix-js-sdk/pull/175)
 * Make encryption asynchronous
   [\#176](https://github.com/matrix-org/matrix-js-sdk/pull/176)
 * Added ability to set and get status_msg for presence.
   [\#167](https://github.com/matrix-org/matrix-js-sdk/pull/167)
 * Megolm: don't dereference nullable object
   [\#174](https://github.com/matrix-org/matrix-js-sdk/pull/174)
 * Implement megolm encryption/decryption
   [\#173](https://github.com/matrix-org/matrix-js-sdk/pull/173)
 * Update our push rules when they come down stream
   [\#170](https://github.com/matrix-org/matrix-js-sdk/pull/170)
 * Factor Olm encryption/decryption out to new classes
   [\#172](https://github.com/matrix-org/matrix-js-sdk/pull/172)
 * Make DeviceInfo more useful, and refactor crypto methods to use it
   [\#171](https://github.com/matrix-org/matrix-js-sdk/pull/171)
 * Move login and register methods into base-apis
   [\#169](https://github.com/matrix-org/matrix-js-sdk/pull/169)
 * Remove defaultDeviceDisplayName from MatrixClient options
   [\#168](https://github.com/matrix-org/matrix-js-sdk/pull/168)

Changes in [0.5.5](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.5) (2016-08-11)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.4...v0.5.5)

 * Add room.getAliases() and room.getCanonicalAlias
 * Add API calls `/register/email/requestToken`, `/account/password/email/requestToken` and `/account/3pid/email/requestToken`
 * Add `User.currentlyActive` and `User.lastPresenceTs` events for changes in fields on the User object
 * Add `logout` and `deactivateAccount`

 * Make sure we actually stop the sync loop on logout
   [\#166](https://github.com/matrix-org/matrix-js-sdk/pull/166)
 * Zero is a valid power level
   [\#164](https://github.com/matrix-org/matrix-js-sdk/pull/164)
 * Verify e2e keys on download
   [\#163](https://github.com/matrix-org/matrix-js-sdk/pull/163)
 * Factor crypto stuff out of MatrixClient
   [\#162](https://github.com/matrix-org/matrix-js-sdk/pull/162)
 * Refactor device key upload
   [\#161](https://github.com/matrix-org/matrix-js-sdk/pull/161)
 * Wrappers for devices API
   [\#158](https://github.com/matrix-org/matrix-js-sdk/pull/158)
 * Add deactivate account function
   [\#160](https://github.com/matrix-org/matrix-js-sdk/pull/160)
 * client.listDeviceKeys: Expose device display name
   [\#159](https://github.com/matrix-org/matrix-js-sdk/pull/159)
 * Add `logout`
   [\#157](https://github.com/matrix-org/matrix-js-sdk/pull/157)
 * Fix email registration
   [\#156](https://github.com/matrix-org/matrix-js-sdk/pull/156)
 * Factor out MatrixClient methods to MatrixBaseApis
   [\#155](https://github.com/matrix-org/matrix-js-sdk/pull/155)
 * Fix some broken tests
   [\#154](https://github.com/matrix-org/matrix-js-sdk/pull/154)
 * make jenkins fail the build if the tests fail
   [\#153](https://github.com/matrix-org/matrix-js-sdk/pull/153)
 * deviceId-related fixes
   [\#152](https://github.com/matrix-org/matrix-js-sdk/pull/152)
 * /login, /register: Add device_id and initial_device_display_name
   [\#151](https://github.com/matrix-org/matrix-js-sdk/pull/151)
 * Support global account_data
   [\#150](https://github.com/matrix-org/matrix-js-sdk/pull/150)
 * Add more events to User
   [\#149](https://github.com/matrix-org/matrix-js-sdk/pull/149)
 * Add API calls for other requestToken endpoints
   [\#148](https://github.com/matrix-org/matrix-js-sdk/pull/148)
 * Add register-specific request token endpoint
   [\#147](https://github.com/matrix-org/matrix-js-sdk/pull/147)
 * Set a valid SPDX license identifier in package.json
   [\#139](https://github.com/matrix-org/matrix-js-sdk/pull/139)
 * Configure encryption on m.room.encryption events
   [\#145](https://github.com/matrix-org/matrix-js-sdk/pull/145)
 * Implement device blocking
   [\#146](https://github.com/matrix-org/matrix-js-sdk/pull/146)
 * Clearer doc for setRoomDirectoryVisibility
   [\#144](https://github.com/matrix-org/matrix-js-sdk/pull/144)
 * crypto: use memberlist to derive recipient list
   [\#143](https://github.com/matrix-org/matrix-js-sdk/pull/143)
 * Support for marking devices as unverified
   [\#142](https://github.com/matrix-org/matrix-js-sdk/pull/142)
 * Add Olm as an optionalDependency
   [\#141](https://github.com/matrix-org/matrix-js-sdk/pull/141)
 * Add room.getAliases() and room.getCanonicalAlias()
   [\#140](https://github.com/matrix-org/matrix-js-sdk/pull/140)
 * Change how MatrixEvent manages encrypted events
   [\#138](https://github.com/matrix-org/matrix-js-sdk/pull/138)
 * Catch exceptions when encrypting events
   [\#137](https://github.com/matrix-org/matrix-js-sdk/pull/137)
 * Support for marking devices as verified
   [\#136](https://github.com/matrix-org/matrix-js-sdk/pull/136)
 * Various matrix-client refactorings and fixes
   [\#134](https://github.com/matrix-org/matrix-js-sdk/pull/134)

Changes in [0.5.4](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.4) (2016-06-02)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.3...v0.5.4)

 * Correct fix for https://github.com/vector-im/vector-web/issues/1039
 * Make release.sh work on OSX


Changes in [0.5.3](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.3) (2016-06-02)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.2...v0.5.3)

 * Add support for the openid interface
   [\#133](https://github.com/matrix-org/matrix-js-sdk/pull/133)
 * Bugfix for HTTP upload content when running on node
   [\#129](https://github.com/matrix-org/matrix-js-sdk/pull/129)
 * Ignore missing profile (displayname and avatar_url) fields on
   presence events, rather than overwriting existing valid profile
   data from membership events or elsewhere.
   Fixes https://github.com/vector-im/vector-web/issues/1039

Changes in [0.5.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.2) (2016-04-19)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.1...v0.5.2)

 * Track the absolute time that presence events are received, so that the
   relative lastActiveAgo value is meaningful.
   [\#128](https://github.com/matrix-org/matrix-js-sdk/pull/128)
 * Refactor the addition of events to rooms
   [\#127](https://github.com/matrix-org/matrix-js-sdk/pull/127)
 * Clean up test shutdown
   [\#126](https://github.com/matrix-org/matrix-js-sdk/pull/126)
 * Add methods to get (and set) pushers
   [\#125](https://github.com/matrix-org/matrix-js-sdk/pull/125)
 * URL previewing support
   [\#122](https://github.com/matrix-org/matrix-js-sdk/pull/122)
 * Avoid paginating forever in private rooms
   [\#124](https://github.com/matrix-org/matrix-js-sdk/pull/124)
 * Fix a bug where we recreated sync filters
   [\#123](https://github.com/matrix-org/matrix-js-sdk/pull/123)
 * Implement HTTP timeouts in realtime
   [\#121](https://github.com/matrix-org/matrix-js-sdk/pull/121)

Changes in [0.5.1](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.1) (2016-03-30)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.5.0...v0.5.1)

 * Only count joined members for the member count in notifications.
   [\#119](https://github.com/matrix-org/matrix-js-sdk/pull/119)
 * Add maySendEvent to match maySendStateEvent
   [\#118](https://github.com/matrix-org/matrix-js-sdk/pull/118)

Changes in [0.5.0](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.5.0) (2016-03-22)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.4.2...v0.5.0)

**BREAKING CHANGES**:
 * `opts.pendingEventOrdering`==`end` is no longer supported in the arguments to
   `MatrixClient.startClient()`. Instead we provide a `detached` option, which
   puts pending events into a completely separate list in the Room, accessible
   via `Room.getPendingEvents()`.
   [\#111](https://github.com/matrix-org/matrix-js-sdk/pull/111)

Other improvements:
 * Log the stack when we get a sync error
   [\#109](https://github.com/matrix-org/matrix-js-sdk/pull/109)
 * Refactor transmitted-messages code
   [\#110](https://github.com/matrix-org/matrix-js-sdk/pull/110)
 * Add a method to the js sdk to look up 3pids on the ID server.
   [\#113](https://github.com/matrix-org/matrix-js-sdk/pull/113)
 * Support for cancelling pending events
   [\#112](https://github.com/matrix-org/matrix-js-sdk/pull/112)
 * API to stop peeking
   [\#114](https://github.com/matrix-org/matrix-js-sdk/pull/114)
 * update store user metadata based on membership events rather than presence
   [\#116](https://github.com/matrix-org/matrix-js-sdk/pull/116)
 * Include a counter in generated transaction IDs
   [\#115](https://github.com/matrix-org/matrix-js-sdk/pull/115)
 * get/setRoomVisibility API
   [\#117](https://github.com/matrix-org/matrix-js-sdk/pull/117)

Changes in [0.4.2](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v0.4.2) (2016-03-17)
================================================================================================
[Full Changelog](https://github.com/matrix-org/matrix-js-sdk/compare/v0.4.1...v0.4.2)

 * Try again if a pagination request gives us no new messages
   [\#98](https://github.com/matrix-org/matrix-js-sdk/pull/98)
 * Add a delay before we start polling the connectivity check endpoint
   [\#99](https://github.com/matrix-org/matrix-js-sdk/pull/99)
 * Clean up a codepath that was only used for crypto messages
   [\#101](https://github.com/matrix-org/matrix-js-sdk/pull/101)
 * Add maySendStateEvent method, ported from react-sdk (but fixed).
   [\#94](https://github.com/matrix-org/matrix-js-sdk/pull/94)
 * Add Session.logged_out event
   [\#100](https://github.com/matrix-org/matrix-js-sdk/pull/100)
 * make presence work when peeking.
   [\#103](https://github.com/matrix-org/matrix-js-sdk/pull/103)
 * Add RoomState.mayClientSendStateEvent()
   [\#104](https://github.com/matrix-org/matrix-js-sdk/pull/104)
 * Fix displaynames for member join events
   [\#108](https://github.com/matrix-org/matrix-js-sdk/pull/108)

Changes in 0.4.1
================

Improvements:
 * Check that `/sync` filters are correct before reusing them, and recreate
   them if not (https://github.com/matrix-org/matrix-js-sdk/pull/85).
 * Fire a `Room.timelineReset` event when a room's timeline is reset by a gappy
   `/sync` (https://github.com/matrix-org/matrix-js-sdk/pull/87,
   https://github.com/matrix-org/matrix-js-sdk/pull/93).
 * Make `TimelineWindow.load()` faster in the simple case of loading the live
   timeline (https://github.com/matrix-org/matrix-js-sdk/pull/88).
 * Update room-name calculation code to use the name of the sender of the
   invite when invited to a room
   (https://github.com/matrix-org/matrix-js-sdk/pull/89).
 * Don't reset the timeline when we join a room after peeking into it
   (https://github.com/matrix-org/matrix-js-sdk/pull/91).
 * Fire `Room.localEchoUpdated` events as local echoes progress through their
   transmission process (https://github.com/matrix-org/matrix-js-sdk/pull/95,
   https://github.com/matrix-org/matrix-js-sdk/pull/97).
 * Avoid getting stuck in a pagination loop when the server sends us only
   messages we've already seen
   (https://github.com/matrix-org/matrix-js-sdk/pull/96).

New methods:
 * Add `MatrixClient.setPushRuleActions` to set the actions for a push
   notification rule (https://github.com/matrix-org/matrix-js-sdk/pull/90)
 * Add `RoomState.maySendStateEvent` which determines if a given user has
   permission to send a state event
   (https://github.com/matrix-org/matrix-js-sdk/pull/94)

Changes in 0.4.0
================

**BREAKING CHANGES**:
 * `RoomMember.getAvatarUrl()` and `MatrixClient.mxcUrlToHttp()` now return the
    empty string when given anything other than an mxc:// URL. This ensures that
    clients never inadvertantly reference content directly, leaking information
    to third party servers. The `allowDirectLinks` option is provided if the client
    wants to allow such links.
 * Add a 'bindEmail' option to register()

Improvements:
 * Support third party invites
 * More appropriate naming for third party invite rooms
 * Poll the 'versions' endpoint to re-establish connectivity
 * Catch exceptions when syncing
 * Room tag support
 * Generate implicit read receipts
 * Support CAS login
 * Guest access support
 * Never return non-mxc URLs by default
 * Ability to cancel file uploads
 * Use the Matrix C/S API v2 with r0 prefix
 * Account data support
 * Support non-contiguous event timelines
 * Support new unread counts
 * Local echo for read-receipts


New methods:
 * Add method to fetch URLs not on the home or identity server
 * Method to get the last receipt for a user
 * Method to get all known users
 * Method to delete an alias


Changes in 0.3.0
================

 * `MatrixClient.getAvatarUrlForMember` has been removed and replaced with
   `RoomMember.getAvatarUrl`. Arguments remain the same except the homeserver
   URL must now be supplied from `MatrixClient.getHomeserverUrl()`.

   ```javascript
   // before
   var url = client.getAvatarUrlForMember(member, width, height, resize, allowDefault)
   // after
   var url = member.getAvatarUrl(client.getHomeserverUrl(), width, height, resize, allowDefault)
   ```
 * `MatrixClient.getAvatarUrlForRoom` has been removed and replaced with
   `Room.getAvatarUrl`. Arguments remain the same except the homeserver
   URL must now be supplied from `MatrixClient.getHomeserverUrl()`.

   ```javascript
   // before
   var url = client.getAvatarUrlForRoom(room, width, height, resize, allowDefault)
   // after
   var url = room.getAvatarUrl(client.getHomeserverUrl(), width, height, resize, allowDefault)
   ```

 * `s/Room.getMembersWithMemership/Room.getMembersWithMem`b`ership/g`

New methods:
 * Added support for sending receipts via
   `MatrixClient.sendReceipt(event, receiptType, callback)` and
   `MatrixClient.sendReadReceipt(event, callback)`.
 * Added support for receiving receipts via
   `Room.getReceiptsForEvent(event)` and `Room.getUsersReadUpTo(event)`. Receipts
   can be directly added to a `Room` using `Room.addReceipt(event)` though the
   `MatrixClient` does this for you.
 * Added support for muting local video and audio via the new methods
   `MatrixCall.setMicrophoneMuted()`, `MatrixCall.isMicrophoneMuted(muted)`,
   `MatrixCall.isLocalVideoMuted()` and `Matrix.setLocalVideoMuted(muted)`.
 * Added **experimental** support for screen-sharing in Chrome via
   `MatrixCall.placeScreenSharingCall(remoteVideoElement, localVideoElement)`.
 * Added ability to perform server-side searches using
   `MatrixClient.searchMessageText(opts)` and `MatrixClient.search(opts)`.

Improvements:
 * Improve the performance of initial sync processing from `O(n^2)` to `O(n)`.
 * `Room.name` will now take into account `m.room.canonical_alias` events.
 * `MatrixClient.startClient` now takes an Object `opts` rather than a Number in
   a backwards-compatible way. This `opts` allows syncing configuration options
   to be specified including `includeArchivedRooms` and `resolveInvitesToProfiles`.
 * `Room` objects which represent room invitations will now have state populated
   from `invite_room_state` if it is included in the `m.room.member` event.
 * `Room.getAvatarUrl` will now take into account `m.room.avatar` events.

Changes in 0.2.2
================

Bug fixes:
 * Null pointer fixes for VoIP calling and push notification processing.
 * Set the `Content-Type` to `application/octet-stream` in the event that the
   file object has no `type`.

New methods:
 * Added `MatrixClient.getCasServer()` which calls through to the HTTP endpoint
   `/login/cas`.
 * Added `MatrixClient.loginWithCas(ticket, service)` which logs in with the
   type `m.login.cas`.
 * Added `MatrixClient.getHomeserverUrl()` which returns the URL passed in the
   constructor.
 * Added `MatrixClient.getIdentityServerUrl()` which returns the URL passed in
   the constructor.
 * Added `getLastModifiedTime()` to `RoomMember`, `RoomState` and `User` objects.
   This makes it easier to see if the object in question has changed, which can
   be used to improve performance by only rendering when these objects change.

Changes in 0.2.1
================

**BREAKING CHANGES**
 * `MatrixClient.joinRoom` has changed from `(roomIdOrAlias, callback)` to
   `(roomIdOrAlias, opts, callback)`.

Bug fixes:
 * The `Content-Type` of file uploads is now explicitly set, without relying
   on the browser to do it for us.

Improvements:
 * The `MatrixScheduler.RETRY_BACKOFF_RATELIMIT` function will not retry when
   the response is a 400,401,403.
 * The text returned from a room invite now includes who the invite was from.
 * There is now a try/catch block around the `request` function which will
   reject/errback appropriately if an exception is thrown synchronously in it.

New methods:
 * `MatrixClient.createAlias(alias, roomId)`
 * `MatrixClient.getRoomIdForAlias(alias)`
 * `MatrixClient.sendNotice(roomId, body, txnId, callback)`
 * `MatrixClient.sendHtmlNotice(roomId, body, htmlBody, callback)`

Modified methods:
 * `MatrixClient.joinRoom(roomIdOrAlias, opts)` where `opts` can include a
   `syncRoom: true|false` flag to control whether a room initial sync is
   performed after joining the room.
 * `MatrixClient.getAvatarUrlForMember` has a new last arg `allowDefault` which
   returns the default identicon URL if `true`.
 * `MatrixClient.getAvatarUrlForRoom` has a new last arg `allowDefault` which
   is passed through to the default identicon generation for
   `getAvatarUrlForMember`.


Changes in 0.2.0
================

**BREAKING CHANGES**:
 * `MatrixClient.setPowerLevel` now expects a `MatrixEvent` and not an `Object`
   for the `event` parameter.

New features:
 * Added `EventStatus.QUEUED` which is set on an event when it is waiting to be
   sent by the scheduler and there are other events in front.
 * Added support for processing push rules on an event. This can be obtained by
   calling `MatrixClient.getPushActionsForEvent(event)`.
 * Added WebRTC support. Outbound calls can be made via
   `call = global.createNewMatrixCall(MatrixClient, roomId)` followed by
   `call.placeVoiceCall()` or `call.placeVideoCall(remoteEle, localEle)`.
   Inbound calls will be received via the event `"Call.incoming"` which provides
   a call object which can be followed with `call.answer()` or `call.hangup()`.
 * Added the ability to upload files to the media repository.
 * Added the ability to change the client's password.
 * Added the ability to register with an email via an identity server.
 * Handle presence events by updating the associated `User` object.
 * Handle redaction events.
 * Added infrastructure for supporting End-to-End encryption. E2E is *NOT*
   available in this version.

New methods:
 * `MatrixClient.getUser(userId)`
 * `MatrixClient.getPushActionsForEvent(event)`
 * `MatrixClient.setPassword(auth, newPassword)`
 * `MatrixClient.loginWithSAML2(relayState, callback)`
 * `MatrixClient.getAvatarUrlForMember(member, w, h, method)`
 * `MatrixClient.mxcUrlToHttp(url, w, h, method)`
 * `MatrixClient.getAvatarUrlForRoom(room, w, h, method)`
 * `MatrixClient.uploadContent(file, callback)`
 * `Room.getMembersWithMembership(membership)`
 * `MatrixScheduler.getQueueForEvent(event)`
 * `MatrixScheduler.removeEventFromQueue(event)`
 * `$DATA_STORE.setSyncToken(token)`
 * `$DATA_STORE.getSyncToken()`

Crypto infrastructure (crypto is *NOT* available in this version):
 * `global.CRYPTO_ENABLED`
 * `MatrixClient.isCryptoEnabled()`
 * `MatrixClient.uploadKeys(maxKeys)`
 * `MatrixClient.downloadKeys(userIds, forceDownload)`
 * `MatrixClient.listDeviceKeys(userId)`
 * `MatrixClient.setRoomEncryption(roomId, config)`
 * `MatrixClient.isRoomEncrypted(roomId)`

New classes:
 * `MatrixCall`
 * `WebStorageStore` - *WIP; unstable*
 * `WebStorageSessionStore` - *WIP; unstable*

Bug fixes:
 * Member name bugfix: Fixed an issue which prevented `RoomMember.name` being
   disambiguated if there was exactly 1 other person with the same display name.
 * Member name bugfix: Disambiguate both clashing display names with user IDs in
   the event of a clash.
 * Room state bugfix: Fixed a bug which incorrectly overwrote power levels
   locally for a room.
 * Room name bugfix: Ignore users who have left the room when determining a room
   name.
 * Events bugfix: Fixed a bug which prevented the `sender` and `target`
   properties from being set.

Changes in 0.1.1
================

**BREAKING CHANGES**:
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
