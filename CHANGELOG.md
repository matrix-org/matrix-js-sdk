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
