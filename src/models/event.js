/*
Copyright 2015, 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
"use strict";

/**
 * This is an internal module. See {@link MatrixEvent} and {@link RoomEvent} for
 * the public classes.
 * @module models/event
 */

import Promise from 'bluebird';
import {EventEmitter} from 'events';
import utils from '../utils.js';

/**
 * Enum for event statuses.
 * @readonly
 * @enum {string}
 */
module.exports.EventStatus = {
    /** The event was not sent and will no longer be retried. */
    NOT_SENT: "not_sent",

    /** The message is being encrypted */
    ENCRYPTING: "encrypting",

    /** The event is in the process of being sent. */
    SENDING: "sending",
    /** The event is in a queue waiting to be sent. */
    QUEUED: "queued",
    /** The event has been sent to the server, but we have not yet received the
     * echo. */
    SENT: "sent",

    /** The event was cancelled before it was successfully sent. */
    CANCELLED: "cancelled",
};

const interns = {};

/**
 * Construct a Matrix Event object
 * @constructor
 *
 * @param {Object} event The raw event to be wrapped in this DAO
 *
 * @prop {Object} event The raw (possibly encrypted) event. <b>Do not access
 * this property</b> directly unless you absolutely have to. Prefer the getter
 * methods defined on this class. Using the getter methods shields your app
 * from changes to event JSON between Matrix versions.
 *
 * @prop {RoomMember} sender The room member who sent this event, or null e.g.
 * this is a presence event. This is only guaranteed to be set for events that
 * appear in a timeline, ie. do not guarantee that it will be set on state
 * events.
 * @prop {RoomMember} target The room member who is the target of this event, e.g.
 * the invitee, the person being banned, etc.
 * @prop {EventStatus} status The sending status of the event.
 * @prop {Error} error most recent error associated with sending the event, if any
 * @prop {boolean} forwardLooking True if this event is 'forward looking', meaning
 * that getDirectionalContent() will return event.content and not event.prev_content.
 * Default: true. <strong>This property is experimental and may change.</strong>
 */
module.exports.MatrixEvent = function MatrixEvent(
    event,
) {
    // intern the values of matrix events to force share strings and reduce the
    // amount of needless string duplication. This can save moderate amounts of
    // memory (~10% on a 350MB heap).
    // 'membership' at the event level (rather than the content level) is a legacy
    // field that Riot never otherwise looks at, but it will still take up a lot
    // of space if we don't intern it.
    ["state_key", "type", "sender", "room_id", "membership"].forEach((prop) => {
        if (!event[prop]) {
            return;
        }
        if (!interns[event[prop]]) {
            interns[event[prop]] = event[prop];
        }
        event[prop] = interns[event[prop]];
    });

    ["membership", "avatar_url", "displayname"].forEach((prop) => {
        if (!event.content || !event.content[prop]) {
            return;
        }
        if (!interns[event.content[prop]]) {
            interns[event.content[prop]] = event.content[prop];
        }
        event.content[prop] = interns[event.content[prop]];
    });

    this.event = event || {};

    this.sender = null;
    this.target = null;
    this.status = null;
    this.error = null;
    this.forwardLooking = true;
    this._pushActions = null;

    this._clearEvent = {};

    /* curve25519 key which we believe belongs to the sender of the event. See
     * getSenderKey()
     */
    this._senderCurve25519Key = null;

    /* ed25519 key which the sender of this event (for olm) or the creator of
     * the megolm session (for megolm) claims to own. See getClaimedEd25519Key()
     */
    this._claimedEd25519Key = null;

    /* curve25519 keys of devices involved in telling us about the
     * _senderCurve25519Key and _claimedEd25519Key.
     * See getForwardingCurve25519KeyChain().
     */
    this._forwardingCurve25519KeyChain = [];

    /* if we have a process decrypting this event, a Promise which resolves
     * when it is finished. Normally null.
     */
    this._decryptionPromise = null;

    /* flag to indicate if we should retry decrypting this event after the
     * first attempt (eg, we have received new data which means that a second
     * attempt may succeed)
     */
    this._retryDecryption = false;
};
utils.inherits(module.exports.MatrixEvent, EventEmitter);


utils.extend(module.exports.MatrixEvent.prototype, {

    /**
     * Get the event_id for this event.
     * @return {string} The event ID, e.g. <code>$143350589368169JsLZx:localhost
     * </code>
     */
    getId: function() {
        return this.event.event_id;
    },

    /**
     * Get the user_id for this event.
     * @return {string} The user ID, e.g. <code>@alice:matrix.org</code>
     */
    getSender: function() {
        return this.event.sender || this.event.user_id; // v2 / v1
    },

    /**
     * Get the (decrypted, if necessary) type of event.
     *
     * @return {string} The event type, e.g. <code>m.room.message</code>
     */
    getType: function() {
        return this._clearEvent.type || this.event.type;
    },

    /**
     * Get the (possibly encrypted) type of the event that will be sent to the
     * homeserver.
     *
     * @return {string} The event type.
     */
    getWireType: function() {
        return this.event.type;
    },

    /**
     * Get the room_id for this event. This will return <code>undefined</code>
     * for <code>m.presence</code> events.
     * @return {string} The room ID, e.g. <code>!cURbafjkfsMDVwdRDQ:matrix.org
     * </code>
     */
    getRoomId: function() {
        return this.event.room_id;
    },

    /**
     * Get the timestamp of this event.
     * @return {Number} The event timestamp, e.g. <code>1433502692297</code>
     */
    getTs: function() {
        return this.event.origin_server_ts;
    },

    /**
     * Get the timestamp of this event, as a Date object.
     * @return {Date} The event date, e.g. <code>new Date(1433502692297)</code>
     */
    getDate: function() {
        return this.event.origin_server_ts ? new Date(this.event.origin_server_ts) : null;
    },

    /**
     * Get the (decrypted, if necessary) event content JSON.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getContent: function() {
        return this._clearEvent.content || this.event.content || {};
    },

    /**
     * Get the (possibly encrypted) event content JSON that will be sent to the
     * homeserver.
     *
     * @return {Object} The event content JSON, or an empty object.
     */
    getWireContent: function() {
        return this.event.content || {};
    },

    /**
     * Get the previous event content JSON. This will only return something for
     * state events which exist in the timeline.
     * @return {Object} The previous event content JSON, or an empty object.
     */
    getPrevContent: function() {
        // v2 then v1 then default
        return this.getUnsigned().prev_content || this.event.prev_content || {};
    },

    /**
     * Get either 'content' or 'prev_content' depending on if this event is
     * 'forward-looking' or not. This can be modified via event.forwardLooking.
     * In practice, this means we get the chronologically earlier content value
     * for this event (this method should surely be called getEarlierContent)
     * <strong>This method is experimental and may change.</strong>
     * @return {Object} event.content if this event is forward-looking, else
     * event.prev_content.
     */
    getDirectionalContent: function() {
        return this.forwardLooking ? this.getContent() : this.getPrevContent();
    },

    /**
     * Get the age of this event. This represents the age of the event when the
     * event arrived at the device, and not the age of the event when this
     * function was called.
     * @return {Number} The age of this event in milliseconds.
     */
    getAge: function() {
        return this.getUnsigned().age || this.event.age; // v2 / v1
    },

    /**
     * Get the event state_key if it has one. This will return <code>undefined
     * </code> for message events.
     * @return {string} The event's <code>state_key</code>.
     */
    getStateKey: function() {
        return this.event.state_key;
    },

    /**
     * Check if this event is a state event.
     * @return {boolean} True if this is a state event.
     */
    isState: function() {
        return this.event.state_key !== undefined;
    },

    /**
     * Replace the content of this event with encrypted versions.
     * (This is used when sending an event; it should not be used by applications).
     *
     * @internal
     *
     * @param {string} crypto_type type of the encrypted event - typically
     * <tt>"m.room.encrypted"</tt>
     *
     * @param {object} crypto_content raw 'content' for the encrypted event.
     *
     * @param {string} senderCurve25519Key curve25519 key to record for the
     *   sender of this event.
     *   See {@link module:models/event.MatrixEvent#getSenderKey}.
     *
     * @param {string} claimedEd25519Key claimed ed25519 key to record for the
     *   sender if this event.
     *   See {@link module:models/event.MatrixEvent#getClaimedEd25519Key}
     */
    makeEncrypted: function(
        crypto_type, crypto_content, senderCurve25519Key, claimedEd25519Key,
    ) {
        // keep the plain-text data for 'view source'
        this._clearEvent = {
            type: this.event.type,
            content: this.event.content,
        };
        this.event.type = crypto_type;
        this.event.content = crypto_content;
        this._senderCurve25519Key = senderCurve25519Key;
        this._claimedEd25519Key = claimedEd25519Key;
    },

    /**
     * Check if this event is currently being decrypted.
     *
     * @return {boolean} True if this event is currently being decrypted, else false.
     */
    isBeingDecrypted: function() {
        return this._decryptionPromise != null;
    },

    /**
     * Check if this event is an encrypted event which we failed to decrypt
     *
     * (This implies that we might retry decryption at some point in the future)
     *
     * @return {boolean} True if this event is an encrypted event which we
     *     couldn't decrypt.
     */
    isDecryptionFailure: function() {
        return this._clearEvent && this._clearEvent.content &&
            this._clearEvent.content.msgtype === "m.bad.encrypted";
    },

    /**
     * Start the process of trying to decrypt this event.
     *
     * (This is used within the SDK: it isn't intended for use by applications)
     *
     * @internal
     *
     * @param {module:crypto} crypto crypto module
     *
     * @returns {Promise} promise which resolves (to undefined) when the decryption
     * attempt is completed.
     */
    attemptDecryption: async function(crypto) {
        // start with a couple of sanity checks.
        if (!this.isEncrypted()) {
            throw new Error("Attempt to decrypt event which isn't encrypted");
        }

        if (
            this._clearEvent && this._clearEvent.content &&
                this._clearEvent.content.msgtype !== "m.bad.encrypted"
        ) {
            // we may want to just ignore this? let's start with rejecting it.
            throw new Error(
                "Attempt to decrypt event which has already been encrypted",
            );
        }

        // if we already have a decryption attempt in progress, then it may
        // fail because it was using outdated info. We now have reason to
        // succeed where it failed before, but we don't want to have multiple
        // attempts going at the same time, so just set a flag that says we have
        // new info.
        //
        if (this._decryptionPromise) {
            console.log(
                `Event ${this.getId()} already being decrypted; queueing a retry`,
            );
            this._retryDecryption = true;
            return this._decryptionPromise;
        }

        this._decryptionPromise = this._decryptionLoop(crypto);
        return this._decryptionPromise;
    },

    /**
     * Cancel any room key request for this event and resend another.
     *
     * @param {module:crypto} crypto crypto module
     */
    cancelAndResendKeyRequest: function(crypto) {
        const wireContent = this.getWireContent();
        crypto.cancelRoomKeyRequest({
            algorithm: wireContent.algorithm,
            room_id: this.getRoomId(),
            session_id: wireContent.session_id,
            sender_key: wireContent.sender_key,
        }, true);
    },

    _decryptionLoop: async function(crypto) {
        // make sure that this method never runs completely synchronously.
        // (doing so would mean that we would clear _decryptionPromise *before*
        // it is set in attemptDecryption - and hence end up with a stuck
        // `_decryptionPromise`).
        await Promise.resolve();

        while (true) {
            this._retryDecryption = false;

            let res;
            let err;
            try {
                if (!crypto) {
                    res = this._badEncryptedMessage("Encryption not enabled");
                } else {
                    res = await crypto.decryptEvent(this);
                }
            } catch (e) {
                if (e.name !== "DecryptionError") {
                    // not a decryption error: log the whole exception as an error
                    // (and don't bother with a retry)
                    console.error(
                        `Error decrypting event (id=${this.getId()}): ${e.stack || e}`,
                    );
                    this._decryptionPromise = null;
                    this._retryDecryption = false;
                    return;
                }

                err = e;

                // see if we have a retry queued.
                //
                // NB: make sure to keep this check in the same tick of the
                //   event loop as `_decryptionPromise = null` below - otherwise we
                //   risk a race:
                //
                //   * A: we check _retryDecryption here and see that it is
                //        false
                //   * B: we get a second call to attemptDecryption, which sees
                //        that _decryptionPromise is set so sets
                //        _retryDecryption
                //   * A: we continue below, clear _decryptionPromise, and
                //        never do the retry.
                //
                if (this._retryDecryption) {
                    // decryption error, but we have a retry queued.
                    console.log(
                        `Got error decrypting event (id=${this.getId()}: ` +
                        `${e}), but retrying`,
                    );
                    continue;
                }

                // decryption error, no retries queued. Warn about the error and
                // set it to m.bad.encrypted.
                console.warn(
                    `Error decrypting event (id=${this.getId()}): ${e.detailedString}`,
                );

                res = this._badEncryptedMessage(e.message);
            }

            // at this point, we've either successfully decrypted the event, or have given up
            // (and set res to a 'badEncryptedMessage'). Either way, we can now set the
            // cleartext of the event and raise Event.decrypted.
            //
            // make sure we clear '_decryptionPromise' before sending the 'Event.decrypted' event,
            // otherwise the app will be confused to see `isBeingDecrypted` still set when
            // there isn't an `Event.decrypted` on the way.
            //
            // see also notes on _retryDecryption above.
            //
            this._decryptionPromise = null;
            this._retryDecryption = false;
            this._setClearData(res);

            this.emit("Event.decrypted", this, err);

            return;
        }
    },

    _badEncryptedMessage: function(reason) {
        return {
            clearEvent: {
                type: "m.room.message",
                content: {
                    msgtype: "m.bad.encrypted",
                    body: "** Unable to decrypt: " + reason + " **",
                },
            },
        };
    },

    /**
     * Update the cleartext data on this event.
     *
     * (This is used after decrypting an event; it should not be used by applications).
     *
     * @internal
     *
     * @fires module:models/event.MatrixEvent#"Event.decrypted"
     *
     * @param {module:crypto~EventDecryptionResult} decryptionResult
     *     the decryption result, including the plaintext and some key info
     */
    _setClearData: function(decryptionResult) {
        this._clearEvent = decryptionResult.clearEvent;
        this._senderCurve25519Key =
            decryptionResult.senderCurve25519Key || null;
        this._claimedEd25519Key =
            decryptionResult.claimedEd25519Key || null;
        this._forwardingCurve25519KeyChain =
            decryptionResult.forwardingCurve25519KeyChain || [];
    },

    /**
     * Check if the event is encrypted.
     * @return {boolean} True if this event is encrypted.
     */
    isEncrypted: function() {
        return this.event.type === "m.room.encrypted";
    },

    /**
     * The curve25519 key for the device that we think sent this event
     *
     * For an Olm-encrypted event, this is inferred directly from the DH
     * exchange at the start of the session: the curve25519 key is involved in
     * the DH exchange, so only a device which holds the private part of that
     * key can establish such a session.
     *
     * For a megolm-encrypted event, it is inferred from the Olm message which
     * established the megolm session
     *
     * @return {string}
     */
    getSenderKey: function() {
        return this._senderCurve25519Key;
    },

    /**
     * The additional keys the sender of this encrypted event claims to possess.
     *
     * Just a wrapper for #getClaimedEd25519Key (q.v.)
     *
     * @return {Object<string, string>}
     */
    getKeysClaimed: function() {
        return {
            ed25519: this._claimedEd25519Key,
        };
    },

    /**
     * Get the ed25519 the sender of this event claims to own.
     *
     * For Olm messages, this claim is encoded directly in the plaintext of the
     * event itself. For megolm messages, it is implied by the m.room_key event
     * which established the megolm session.
     *
     * Until we download the device list of the sender, it's just a claim: the
     * device list gives a proof that the owner of the curve25519 key used for
     * this event (and returned by #getSenderKey) also owns the ed25519 key by
     * signing the public curve25519 key with the ed25519 key.
     *
     * In general, applications should not use this method directly, but should
     * instead use MatrixClient.getEventSenderDeviceInfo.
     *
     * @return {string}
     */
    getClaimedEd25519Key: function() {
        return this._claimedEd25519Key;
    },

    /**
     * Get the curve25519 keys of the devices which were involved in telling us
     * about the claimedEd25519Key and sender curve25519 key.
     *
     * Normally this will be empty, but in the case of a forwarded megolm
     * session, the sender keys are sent to us by another device (the forwarding
     * device), which we need to trust to do this. In that case, the result will
     * be a list consisting of one entry.
     *
     * If the device that sent us the key (A) got it from another device which
     * it wasn't prepared to vouch for (B), the result will be [A, B]. And so on.
     *
     * @return {string[]} base64-encoded curve25519 keys, from oldest to newest.
     */
    getForwardingCurve25519KeyChain: function() {
        return this._forwardingCurve25519KeyChain;
    },

    getUnsigned: function() {
        return this.event.unsigned || {};
    },

    /**
     * Update the content of an event in the same way it would be by the server
     * if it were redacted before it was sent to us
     *
     * @param {module:models/event.MatrixEvent} redaction_event
     *     event causing the redaction
     */
    makeRedacted: function(redaction_event) {
        // quick sanity-check
        if (!redaction_event.event) {
            throw new Error("invalid redaction_event in makeRedacted");
        }

        // we attempt to replicate what we would see from the server if
        // the event had been redacted before we saw it.
        //
        // The server removes (most of) the content of the event, and adds a
        // "redacted_because" key to the unsigned section containing the
        // redacted event.
        if (!this.event.unsigned) {
            this.event.unsigned = {};
        }
        this.event.unsigned.redacted_because = redaction_event.event;

        let key;
        for (key in this.event) {
            if (!this.event.hasOwnProperty(key)) {
                continue;
            }
            if (!_REDACT_KEEP_KEY_MAP[key]) {
                delete this.event[key];
            }
        }

        const keeps = _REDACT_KEEP_CONTENT_MAP[this.getType()] || {};
        const content = this.getContent();
        for (key in content) {
            if (!content.hasOwnProperty(key)) {
                continue;
            }
            if (!keeps[key]) {
                delete content[key];
            }
        }
    },

    /**
     * Check if this event has been redacted
     *
     * @return {boolean} True if this event has been redacted
     */
    isRedacted: function() {
        return Boolean(this.getUnsigned().redacted_because);
    },

    /**
     * Get the push actions, if known, for this event
     *
     * @return {?Object} push actions
     */
     getPushActions: function() {
        return this._pushActions;
     },

    /**
     * Set the push actions for this event.
     *
     * @param {Object} pushActions push actions
     */
     setPushActions: function(pushActions) {
        this._pushActions = pushActions;
     },

     /**
      * Replace the `event` property and recalculate any properties based on it.
      * @param {Object} event the object to assign to the `event` property
      */
     handleRemoteEcho: function(event) {
        this.event = event;
        // successfully sent.
        this.status = null;
     },
});


/* _REDACT_KEEP_KEY_MAP gives the keys we keep when an event is redacted
 *
 * This is specified here:
 *  http://matrix.org/speculator/spec/HEAD/client_server/unstable.html#redactions
 *
 * Also:
 *  - We keep 'unsigned' since that is created by the local server
 *  - We keep user_id for backwards-compat with v1
 */
const _REDACT_KEEP_KEY_MAP = [
    'event_id', 'type', 'room_id', 'user_id', 'sender', 'state_key', 'prev_state',
    'content', 'unsigned', 'origin_server_ts',
].reduce(function(ret, val) {
    ret[val] = 1; return ret;
}, {});

// a map from event type to the .content keys we keep when an event is redacted
const _REDACT_KEEP_CONTENT_MAP = {
    'm.room.member': {'membership': 1},
    'm.room.create': {'creator': 1},
    'm.room.join_rules': {'join_rule': 1},
    'm.room.power_levels': {'ban': 1, 'events': 1, 'events_default': 1,
                            'kick': 1, 'redact': 1, 'state_default': 1,
                            'users': 1, 'users_default': 1,
                           },
    'm.room.aliases': {'aliases': 1},
};


/**
 * Fires when an event is decrypted
 *
 * @event module:models/event.MatrixEvent#"Event.decrypted"
 *
 * @param {module:models/event.MatrixEvent} event
 *    The matrix event which has been decrypted
 * @param {module:crypto/algorithms/base.DecryptionError?} err
 *    The error that occured during decryption, or `undefined` if no
 *    error occured.
 */
