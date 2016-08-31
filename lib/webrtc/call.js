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
 * This is an internal module. See {@link createNewMatrixCall} for the public API.
 * @module webrtc/call
 */
var utils = require("../utils");
var EventEmitter = require("events").EventEmitter;
var DEBUG = true;  // set true to enable console logging.

// events: hangup, error(err), replaced(call), state(state, oldState)

/**
 * Construct a new Matrix Call.
 * @constructor
 * @param {Object} opts Config options.
 * @param {string} opts.roomId The room ID for this call.
 * @param {Object} opts.webRtc The WebRTC globals from the browser.
 * @param {Object} opts.URL The URL global.
 * @param {Array<Object>} opts.turnServers Optional. A list of TURN servers.
 * @param {MatrixClient} opts.client The Matrix Client instance to send events to.
 */
function MatrixCall(opts) {
    this.roomId = opts.roomId;
    this.client = opts.client;
    this.webRtc = opts.webRtc;
    this.URL = opts.URL;
    // Array of Objects with urls, username, credential keys
    this.turnServers = opts.turnServers || [];
    if (this.turnServers.length === 0) {
        this.turnServers.push({
            urls: [MatrixCall.FALLBACK_STUN_SERVER]
        });
    }
    utils.forEach(this.turnServers, function(server) {
        utils.checkObjectHasKeys(server, ["urls"]);
    });

    this.callId = "c" + new Date().getTime();
    this.state = 'fledgling';
    this.didConnect = false;

    // A queue for candidates waiting to go out.
    // We try to amalgamate candidates into a single candidate message where
    // possible
    this.candidateSendQueue = [];
    this.candidateSendTries = 0;

    // Lookup from opaque queue ID to a promise for media element operations that
    // need to be serialised into a given queue.  Store this per-MatrixCall on the
    // assumption that multiple matrix calls will never compete for control of the
    // same DOM elements.
    this.mediaPromises = Object.create(null);

    this.screenSharingStream = null;
}
/** The length of time a call can be ringing for. */
MatrixCall.CALL_TIMEOUT_MS = 60000;
/** The fallback server to use for STUN. */
MatrixCall.FALLBACK_STUN_SERVER = 'stun:stun.l.google.com:19302';
/** An error code when the local client failed to create an offer. */
MatrixCall.ERR_LOCAL_OFFER_FAILED = "local_offer_failed";
/**
 * An error code when there is no local mic/camera to use. This may be because
 * the hardware isn't plugged in, or the user has explicitly denied access.
 */
MatrixCall.ERR_NO_USER_MEDIA = "no_user_media";

utils.inherits(MatrixCall, EventEmitter);

/**
 * Place a voice call to this room.
 * @throws If you have not specified a listener for 'error' events.
 */
MatrixCall.prototype.placeVoiceCall = function() {
    debuglog("placeVoiceCall");
    checkForErrorListener(this);
    _placeCallWithConstraints(this, _getUserMediaVideoContraints('voice'));
    this.type = 'voice';
};

/**
 * Place a video call to this room.
 * @param {Element} remoteVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render video to.
 * @param {Element} localVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render the local camera preview.
 * @throws If you have not specified a listener for 'error' events.
 */
MatrixCall.prototype.placeVideoCall = function(remoteVideoElement, localVideoElement) {
    debuglog("placeVideoCall");
    checkForErrorListener(this);
    this.localVideoElement = localVideoElement;
    this.remoteVideoElement = remoteVideoElement;
    _placeCallWithConstraints(this, _getUserMediaVideoContraints('video'));
    this.type = 'video';
    _tryPlayRemoteStream(this);
};

/**
 * Place a screen-sharing call to this room. This includes audio.
 * <b>This method is EXPERIMENTAL and subject to change without warning. It
 * only works in Google Chrome.</b>
 * @param {Element} remoteVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render video to.
 * @param {Element} localVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render the local camera preview.
 * @throws If you have not specified a listener for 'error' events.
 */
MatrixCall.prototype.placeScreenSharingCall =
    function(remoteVideoElement, localVideoElement)
{
    debuglog("placeScreenSharingCall");
    checkForErrorListener(this);
    var screenConstraints = _getChromeScreenSharingConstraints(this);
    if (!screenConstraints) {
        return;
    }
    this.localVideoElement = localVideoElement;
    this.remoteVideoElement = remoteVideoElement;
    var self = this;
    this.webRtc.getUserMedia(screenConstraints, function(stream) {
        self.screenSharingStream = stream;
        debuglog("Got screen stream, requesting audio stream...");
        var audioConstraints = _getUserMediaVideoContraints('voice');
        _placeCallWithConstraints(self, audioConstraints);
    }, function(err) {
        self.emit("error",
            callError(
                MatrixCall.ERR_NO_USER_MEDIA,
                "Failed to get screen-sharing stream: " + err
            )
        );
    });
    this.type = 'video';
    _tryPlayRemoteStream(this);
};

/**
 * Play the given HTMLMediaElement, serialising the operation into a chain
 * of promises to avoid racing access to the element
 * @param {Element} HTMLMediaElement element to play
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.playElement = function(element, queueId) {
    console.log("queuing play on " + queueId + " and element " + element);
    // XXX: FIXME: Does this leak elements, given the old promises
    // may hang around and retain a reference to them?
    if (this.mediaPromises[queueId]) {
        // XXX: these promises can fail (e.g. by <video/> being unmounted whilst
        // pending receiving media to play - e.g. whilst switching between
        // rooms before answering an inbound call), and throw unhandled exceptions.
        // However, we should soldier on as best we can even if they fail, given
        // these failures may be non-fatal (as in the case of unmounts)
        this.mediaPromises[queueId] =
            this.mediaPromises[queueId].then(function() {
                console.log("previous promise completed for " + queueId);
                return element.play();
            }, function() {
                console.log("previous promise failed for " + queueId);
                return element.play();
            });
    }
    else {
        this.mediaPromises[queueId] = element.play();
    }
};

/**
 * Pause the given HTMLMediaElement, serialising the operation into a chain
 * of promises to avoid racing access to the element
 * @param {Element} HTMLMediaElement element to pause
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.pauseElement = function(element, queueId) {
    console.log("queuing pause on " + queueId + " and element " + element);
    if (this.mediaPromises[queueId]) {
        this.mediaPromises[queueId] =
            this.mediaPromises[queueId].then(function() {
                console.log("previous promise completed for " + queueId);
                return element.pause();
            }, function() {
                console.log("previous promise failed for " + queueId);
                return element.pause();
            });
    }
    else {
        // pause doesn't actually return a promise, but do this for symmetry
        // and just in case it does in future.
        this.mediaPromises[queueId] = element.pause();
    }
};

/**
 * Assign the given HTMLMediaElement by setting the .src attribute on it,
 * serialising the operation into a chain of promises to avoid racing access
 * to the element
 * @param {Element} HTMLMediaElement element to pause
 * @param {string} src the src attribute value to assign to the element
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.assignElement = function(element, src, queueId) {
    console.log("queuing assign on " + queueId + " element " + element + " for " + src);
    if (this.mediaPromises[queueId]) {
        this.mediaPromises[queueId] =
            this.mediaPromises[queueId].then(function() {
                console.log("previous promise completed for " + queueId);
                element.src = src;
            }, function() {
                console.log("previous promise failed for " + queueId);
                element.src = src;
            });
    }
    else {
        element.src = src;
    }
};

/**
 * Retrieve the local <code>&lt;video&gt;</code> DOM element.
 * @return {Element} The dom element
 */
MatrixCall.prototype.getLocalVideoElement = function() {
    return this.localVideoElement;
};

/**
 * Retrieve the remote <code>&lt;video&gt;</code> DOM element
 * used for playing back video capable streams.
 * @return {Element} The dom element
 */
MatrixCall.prototype.getRemoteVideoElement = function() {
    return this.remoteVideoElement;
};

/**
 * Retrieve the remote <code>&lt;audio&gt;</code> DOM element
 * used for playing back audio only streams.
 * @return {Element} The dom element
 */
MatrixCall.prototype.getRemoteAudioElement = function() {
    return this.remoteAudioElement;
};

/**
 * Set the local <code>&lt;video&gt;</code> DOM element. If this call is active,
 * video will be rendered to it immediately.
 * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
 */
MatrixCall.prototype.setLocalVideoElement = function(element) {
    this.localVideoElement = element;

    if (element && this.localAVStream && this.type === 'video') {
        element.autoplay = true;
        this.assignElement(element,
                           this.URL.createObjectURL(this.localAVStream),
                           "localVideo");
        element.muted = true;
        var self = this;
        setTimeout(function() {
            var vel = self.getLocalVideoElement();
            if (vel.play) {
                self.playElement(vel, "localVideo");
            }
        }, 0);
    }
};

/**
 * Set the remote <code>&lt;video&gt;</code> DOM element. If this call is active,
 * the first received video-capable stream will be rendered to it immediately.
 * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
 */
MatrixCall.prototype.setRemoteVideoElement = function(element) {
    this.remoteVideoElement = element;
    _tryPlayRemoteStream(this);
};

/**
 * Set the remote <code>&lt;audio&gt;</code> DOM element. If this call is active,
 * the first received audio-only stream will be rendered to it immediately.
 * The audio will *not* be rendered from the remoteVideoElement.
 * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
 */
MatrixCall.prototype.setRemoteAudioElement = function(element) {
    this.remoteVideoElement.muted = true;
    this.remoteAudioElement = element;
    _tryPlayRemoteAudioStream(this);
};

/**
 * Configure this call from an invite event. Used by MatrixClient.
 * @protected
 * @param {MatrixEvent} event The m.call.invite event
 */
MatrixCall.prototype._initWithInvite = function(event) {
    this.msg = event.getContent();
    this.peerConn = _createPeerConnection(this);
    var self = this;
    if (this.peerConn) {
        this.peerConn.setRemoteDescription(
            new this.webRtc.RtcSessionDescription(this.msg.offer),
            hookCallback(self, self._onSetRemoteDescriptionSuccess),
            hookCallback(self, self._onSetRemoteDescriptionError)
        );
    }
    setState(this, 'ringing');
    this.direction = 'inbound';

    // firefox and OpenWebRTC's RTCPeerConnection doesn't add streams until it
    // starts getting media on them so we need to figure out whether a video
    // channel has been offered by ourselves.
    if (
        this.msg.offer &&
        this.msg.offer.sdp &&
        this.msg.offer.sdp.indexOf('m=video') > -1
    ) {
        this.type = 'video';
    }
    else {
        this.type = 'voice';
    }

    if (event.getAge()) {
        setTimeout(function() {
            if (self.state == 'ringing') {
                debuglog("Call invite has expired. Hanging up.");
                self.hangupParty = 'remote'; // effectively
                setState(self, 'ended');
                stopAllMedia(self);
                if (self.peerConn.signalingState != 'closed') {
                    self.peerConn.close();
                }
                self.emit("hangup", self);
            }
        }, this.msg.lifetime - event.getAge());
    }
};

/**
 * Configure this call from a hangup event. Used by MatrixClient.
 * @protected
 * @param {MatrixEvent} event The m.call.hangup event
 */
MatrixCall.prototype._initWithHangup = function(event) {
    // perverse as it may seem, sometimes we want to instantiate a call with a
    // hangup message (because when getting the state of the room on load, events
    // come in reverse order and we want to remember that a call has been hung up)
    this.msg = event.getContent();
    setState(this, 'ended');
};

/**
 * Answer a call.
 */
MatrixCall.prototype.answer = function() {
    debuglog("Answering call %s of type %s", this.callId, this.type);
    var self = this;

    if (!this.localAVStream && !this.waitForLocalAVStream) {
        this.webRtc.getUserMedia(
            _getUserMediaVideoContraints(this.type),
            hookCallback(self, self._gotUserMediaForAnswer),
            hookCallback(self, self._getUserMediaFailed)
        );
        setState(this, 'wait_local_media');
    } else if (this.localAVStream) {
        this._gotUserMediaForAnswer(this.localAVStream);
    } else if (this.waitForLocalAVStream) {
        setState(this, 'wait_local_media');
    }
};

/**
 * Replace this call with a new call, e.g. for glare resolution. Used by
 * MatrixClient.
 * @protected
 * @param {MatrixCall} newCall The new call.
 */
MatrixCall.prototype._replacedBy = function(newCall) {
    debuglog(this.callId + " being replaced by " + newCall.callId);
    if (this.state == 'wait_local_media') {
        debuglog("Telling new call to wait for local media");
        newCall.waitForLocalAVStream = true;
    } else if (this.state == 'create_offer') {
        debuglog("Handing local stream to new call");
        newCall._gotUserMediaForAnswer(this.localAVStream);
        delete(this.localAVStream);
    } else if (this.state == 'invite_sent') {
        debuglog("Handing local stream to new call");
        newCall._gotUserMediaForAnswer(this.localAVStream);
        delete(this.localAVStream);
    }
    newCall.localVideoElement = this.localVideoElement;
    newCall.remoteVideoElement = this.remoteVideoElement;
    newCall.remoteAudioElement = this.remoteAudioElement;
    this.successor = newCall;
    this.emit("replaced", newCall);
    this.hangup(true);
};

/**
 * Hangup a call.
 * @param {string} reason The reason why the call is being hung up.
 * @param {boolean} suppressEvent True to suppress emitting an event.
 */
MatrixCall.prototype.hangup = function(reason, suppressEvent) {
    debuglog("Ending call " + this.callId);
    terminate(this, "local", reason, !suppressEvent);
    var content = {
        version: 0,
        call_id: this.callId,
        reason: reason
    };
    sendEvent(this, 'm.call.hangup', content);
};

/**
 * Set whether the local video preview should be muted or not.
 * @param {boolean} muted True to mute the local video.
 */
MatrixCall.prototype.setLocalVideoMuted = function(muted) {
    if (!this.localAVStream) {
        return;
    }
    setTracksEnabled(this.localAVStream.getVideoTracks(), !muted);
};

/**
 * Check if local video is muted.
 *
 * If there are multiple video tracks, <i>all</i> of the tracks need to be muted
 * for this to return true. This means if there are no video tracks, this will
 * return true.
 * @return {Boolean} True if the local preview video is muted, else false
 * (including if the call is not set up yet).
 */
MatrixCall.prototype.isLocalVideoMuted = function() {
    if (!this.localAVStream) {
        return false;
    }
    return !isTracksEnabled(this.localAVStream.getVideoTracks());
};

/**
 * Set whether the microphone should be muted or not.
 * @param {boolean} muted True to mute the mic.
 */
MatrixCall.prototype.setMicrophoneMuted = function(muted) {
    if (!this.localAVStream) {
        return;
    }
    setTracksEnabled(this.localAVStream.getAudioTracks(), !muted);
};

/**
 * Check if the microphone is muted.
 *
 * If there are multiple audio tracks, <i>all</i> of the tracks need to be muted
 * for this to return true. This means if there are no audio tracks, this will
 * return true.
 * @return {Boolean} True if the mic is muted, else false (including if the call
 * is not set up yet).
 */
MatrixCall.prototype.isMicrophoneMuted = function() {
    if (!this.localAVStream) {
        return false;
    }
    return !isTracksEnabled(this.localAVStream.getAudioTracks());
};

/**
 * Internal
 * @private
 * @param {Object} stream
 */
MatrixCall.prototype._gotUserMediaForInvite = function(stream) {
    if (this.successor) {
        this.successor._gotUserMediaForAnswer(stream);
        return;
    }
    if (this.state == 'ended') {
        return;
    }
    debuglog("_gotUserMediaForInvite -> " + this.type);
    var self = this;
    var videoEl = this.getLocalVideoElement();

    if (videoEl && this.type == 'video') {
        videoEl.autoplay = true;
        if (this.screenSharingStream) {
            debuglog("Setting screen sharing stream to the local video element");
            this.assignElement(videoEl,
                   this.URL.createObjectURL(this.screenSharingStream),
                   "localVideo");
        }
        else {
            this.assignElement(videoEl,
                   this.URL.createObjectURL(stream),
                   "localVideo");
        }
        videoEl.muted = true;
        setTimeout(function() {
            var vel = self.getLocalVideoElement();
            if (vel.play) {
                self.playElement(vel, "localVideo");
            }
        }, 0);
    }

    this.localAVStream = stream;
    // why do we enable audio (and only audio) tracks here? -- matthew
    setTracksEnabled(stream.getAudioTracks(), true);
    this.peerConn = _createPeerConnection(this);
    this.peerConn.addStream(stream);
    if (this.screenSharingStream) {
        console.log("Adding screen-sharing stream to peer connection");
        this.peerConn.addStream(this.screenSharingStream);
        // let's use this for the local preview...
        this.localAVStream = this.screenSharingStream;
    }
    this.peerConn.createOffer(
        hookCallback(self, self._gotLocalOffer),
        hookCallback(self, self._getLocalOfferFailed)
    );
    setState(self, 'create_offer');
};

/**
 * Internal
 * @private
 * @param {Object} stream
 */
MatrixCall.prototype._gotUserMediaForAnswer = function(stream) {
    var self = this;
    if (self.state == 'ended') {
        return;
    }
    var localVidEl = self.getLocalVideoElement();

    if (localVidEl && self.type == 'video') {
        localVidEl.autoplay = true;
        this.assignElement(localVidEl,
               this.URL.createObjectURL(stream),
               "localVideo");
        localVidEl.muted = true;
        setTimeout(function() {
            var vel = self.getLocalVideoElement();
            if (vel.play) {
                self.playElement(vel, "localVideo");
            }
        }, 0);
    }

    self.localAVStream = stream;
    setTracksEnabled(stream.getAudioTracks(), true);
    self.peerConn.addStream(stream);

    var constraints = {
        'mandatory': {
            'OfferToReceiveAudio': true,
            'OfferToReceiveVideo': self.type == 'video'
        }
    };
    self.peerConn.createAnswer(function(description) {
        debuglog("Created answer: " + description);
        self.peerConn.setLocalDescription(description, function() {
            var content = {
                version: 0,
                call_id: self.callId,
                answer: {
                    sdp: self.peerConn.localDescription.sdp,
                    type: self.peerConn.localDescription.type
                }
            };
            sendEvent(self, 'm.call.answer', content);
            setState(self, 'connecting');
        }, function() {
            debuglog("Error setting local description!");
        }, constraints);
    }, function(err) {
        debuglog("Failed to create answer: " + err);
    });
    setState(self, 'create_answer');
};

/**
 * Internal
 * @private
 * @param {Object} event
 */
MatrixCall.prototype._gotLocalIceCandidate = function(event) {
    if (event.candidate) {
        debuglog(
            "Got local ICE " + event.candidate.sdpMid + " candidate: " +
            event.candidate.candidate
        );
        // As with the offer, note we need to make a copy of this object, not
        // pass the original: that broke in Chrome ~m43.
        var c = {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
        };
        sendCandidate(this, c);
    }
};

/**
 * Used by MatrixClient.
 * @protected
 * @param {Object} cand
 */
MatrixCall.prototype._gotRemoteIceCandidate = function(cand) {
    if (this.state == 'ended') {
        //debuglog("Ignoring remote ICE candidate because call has ended");
        return;
    }
    debuglog("Got remote ICE " + cand.sdpMid + " candidate: " + cand.candidate);
    this.peerConn.addIceCandidate(
        new this.webRtc.RtcIceCandidate(cand),
        function() {},
        function(e) {}
    );
};

/**
 * Used by MatrixClient.
 * @protected
 * @param {Object} msg
 */
MatrixCall.prototype._receivedAnswer = function(msg) {
    if (this.state == 'ended') {
        return;
    }

    var self = this;
    this.peerConn.setRemoteDescription(
        new this.webRtc.RtcSessionDescription(msg.answer),
        hookCallback(self, self._onSetRemoteDescriptionSuccess),
        hookCallback(self, self._onSetRemoteDescriptionError)
    );
    setState(self, 'connecting');
};

/**
 * Internal
 * @private
 * @param {Object} description
 */
MatrixCall.prototype._gotLocalOffer = function(description) {
    var self = this;
    debuglog("Created offer: " + description);

    if (self.state == 'ended') {
        debuglog("Ignoring newly created offer on call ID " + self.callId +
            " because the call has ended");
        return;
    }

    self.peerConn.setLocalDescription(description, function() {
        var content = {
            version: 0,
            call_id: self.callId,
            // OpenWebRTC appears to add extra stuff (like the DTLS fingerprint)
            // to the description when setting it on the peerconnection.
            // According to the spec it should only add ICE
            // candidates. Any ICE candidates that have already been generated
            // at this point will probably be sent both in the offer and separately.
            // Also, note that we have to make a new object here, copying the
            // type and sdp properties.
            // Passing the RTCSessionDescription object as-is doesn't work in
            // Chrome (as of about m43).
            offer: {
                sdp: self.peerConn.localDescription.sdp,
                type: self.peerConn.localDescription.type
            },
            lifetime: MatrixCall.CALL_TIMEOUT_MS
        };
        sendEvent(self, 'm.call.invite', content);

        setTimeout(function() {
            if (self.state == 'invite_sent') {
                self.hangup('invite_timeout');
            }
        }, MatrixCall.CALL_TIMEOUT_MS);
        setState(self, 'invite_sent');
    }, function() {
        debuglog("Error setting local description!");
    });
};

/**
 * Internal
 * @private
 * @param {Object} error
 */
MatrixCall.prototype._getLocalOfferFailed = function(error) {
    this.emit(
        "error",
        callError(MatrixCall.ERR_LOCAL_OFFER_FAILED, "Failed to start audio for call!")
    );
};

/**
 * Internal
 * @private
 * @param {Object} error
 */
MatrixCall.prototype._getUserMediaFailed = function(error) {
    this.emit(
        "error",
        callError(
            MatrixCall.ERR_NO_USER_MEDIA,
            "Couldn't start capturing media! Is your microphone set up and " +
            "does this app have permission?"
        )
    );
    this.hangup("user_media_failed");
};

/**
 * Internal
 * @private
 */
MatrixCall.prototype._onIceConnectionStateChanged = function() {
    if (this.state == 'ended') {
        return; // because ICE can still complete as we're ending the call
    }
    debuglog(
        "Ice connection state changed to: " + this.peerConn.iceConnectionState
    );
    // ideally we'd consider the call to be connected when we get media but
    // chrome doesn't implement any of the 'onstarted' events yet
    if (this.peerConn.iceConnectionState == 'completed' ||
            this.peerConn.iceConnectionState == 'connected') {
        setState(this, 'connected');
        this.didConnect = true;
    } else if (this.peerConn.iceConnectionState == 'failed') {
        this.hangup('ice_failed');
    }
};

/**
 * Internal
 * @private
 */
MatrixCall.prototype._onSignallingStateChanged = function() {
    debuglog(
        "call " + this.callId + ": Signalling state changed to: " +
        this.peerConn.signalingState
    );
};

/**
 * Internal
 * @private
 */
MatrixCall.prototype._onSetRemoteDescriptionSuccess = function() {
    debuglog("Set remote description");
};

/**
 * Internal
 * @private
 * @param {Object} e
 */
MatrixCall.prototype._onSetRemoteDescriptionError = function(e) {
    debuglog("Failed to set remote description" + e);
};

/**
 * Internal
 * @private
 * @param {Object} event
 */
MatrixCall.prototype._onAddStream = function(event) {
    debuglog("Stream id " + event.stream.id + " added");

    var s = event.stream;

    if (s.getVideoTracks().length > 0) {
        this.type = 'video';
        this.remoteAVStream = s;
        this.remoteAStream = s;
    } else {
        this.type = 'voice';
        this.remoteAStream = s;
    }

    var self = this;
    forAllTracksOnStream(s, function(t) {
        debuglog("Track id " + t.id + " added");
        // not currently implemented in chrome
        t.onstarted = hookCallback(self, self._onRemoteStreamTrackStarted);
    });

    if (event.stream.oninactive !== undefined) {
        event.stream.oninactive = hookCallback(self, self._onRemoteStreamEnded);
    }
    else {
        // onended is deprecated from Chrome 54
        event.stream.onended = hookCallback(self, self._onRemoteStreamEnded);
    }

    // not currently implemented in chrome
    event.stream.onstarted = hookCallback(self, self._onRemoteStreamStarted);

    if (this.type === 'video') {
        _tryPlayRemoteStream(this);
        _tryPlayRemoteAudioStream(this);
    }
    else {
        _tryPlayRemoteAudioStream(this);
    }
};

/**
 * Internal
 * @private
 * @param {Object} event
 */
MatrixCall.prototype._onRemoteStreamStarted = function(event) {
    setState(this, 'connected');
};

/**
 * Internal
 * @private
 * @param {Object} event
 */
MatrixCall.prototype._onRemoteStreamEnded = function(event) {
    debuglog("Remote stream ended");
    this.hangupParty = 'remote';
    setState(this, 'ended');
    stopAllMedia(this);
    if (this.peerConn.signalingState != 'closed') {
        this.peerConn.close();
    }
    this.emit("hangup", this);
};

/**
 * Internal
 * @private
 * @param {Object} event
 */
MatrixCall.prototype._onRemoteStreamTrackStarted = function(event) {
    setState(this, 'connected');
};

/**
 * Used by MatrixClient.
 * @protected
 * @param {Object} msg
 */
MatrixCall.prototype._onHangupReceived = function(msg) {
    debuglog("Hangup received");
    terminate(this, "remote", msg.reason, true);
};

/**
 * Used by MatrixClient.
 * @protected
 * @param {Object} msg
 */
MatrixCall.prototype._onAnsweredElsewhere = function(msg) {
    debuglog("Answered elsewhere");
    terminate(this, "remote", "answered_elsewhere", true);
};

var setTracksEnabled = function(tracks, enabled) {
    for (var i = 0; i < tracks.length; i++) {
        tracks[i].enabled = enabled;
    }
};

var isTracksEnabled = function(tracks) {
    for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].enabled) {
            return true; // at least one track is enabled
        }
    }
    return false;
};

var setState = function(self, state) {
    var oldState = self.state;
    self.state = state;
    self.emit("state", state, oldState);
};

/**
 * Internal
 * @param {MatrixCall} self
 * @param {string} eventType
 * @param {Object} content
 * @return {Promise}
 */
var sendEvent = function(self, eventType, content) {
    return self.client.sendEvent(self.roomId, eventType, content);
};

var sendCandidate = function(self, content) {
    // Sends candidates with are sent in a special way because we try to amalgamate
    // them into one message
    self.candidateSendQueue.push(content);
    if (self.candidateSendTries === 0) {
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, 100);
    }
};

var terminate = function(self, hangupParty, hangupReason, shouldEmit) {
    if (self.getRemoteVideoElement()) {
        if (self.getRemoteVideoElement().pause) {
            self.pauseElement(self.getRemoteVideoElement(), "remoteVideo");
        }
        self.assignElement(self.getRemoteVideoElement(), "", "remoteVideo");
    }
    if (self.getRemoteAudioElement()) {
        if (self.getRemoteAudioElement().pause) {
            self.pauseElement(self.getRemoteAudioElement(), "remoteAudio");
        }
        self.assignElement(self.getRemoteAudioElement(), "", "remoteAudio");
    }
    if (self.getLocalVideoElement()) {
        if (self.getLocalVideoElement().pause) {
            self.pauseElement(self.getLocalVideoElement(), "localVideo");
        }
        self.assignElement(self.getLocalVideoElement(), "", "localVideo");
    }
    self.hangupParty = hangupParty;
    self.hangupReason = hangupReason;
    setState(self, 'ended');
    stopAllMedia(self);
    if (self.peerConn && self.peerConn.signalingState !== 'closed') {
        self.peerConn.close();
    }
    if (shouldEmit) {
        self.emit("hangup", self);
    }
};

var stopAllMedia = function(self) {
    debuglog("stopAllMedia (stream=%s)", self.localAVStream);
    if (self.localAVStream) {
        forAllTracksOnStream(self.localAVStream, function(t) {
            if (t.stop) {
                t.stop();
            }
        });
        // also call stop on the main stream so firefox will stop sharing
        // the mic
        if (self.localAVStream.stop) {
            self.localAVStream.stop();
        }
    }
    if (self.screenSharingStream) {
        forAllTracksOnStream(self.screenSharingStream, function(t) {
            if (t.stop) {
                t.stop();
            }
        });
        if (self.screenSharingStream.stop) {
            self.screenSharingStream.stop();
        }
    }
    if (self.remoteAVStream) {
        forAllTracksOnStream(self.remoteAVStream, function(t) {
            if (t.stop) {
                t.stop();
            }
        });
    }
    if (self.remoteAStream) {
        forAllTracksOnStream(self.remoteAStream, function(t) {
            if (t.stop) {
                t.stop();
            }
        });
    }
};

var _tryPlayRemoteStream = function(self) {
    if (self.getRemoteVideoElement() && self.remoteAVStream) {
        var player = self.getRemoteVideoElement();
        player.autoplay = true;
        self.assignElement(player,
                           self.URL.createObjectURL(self.remoteAVStream),
                           "remoteVideo");
        setTimeout(function() {
            var vel = self.getRemoteVideoElement();
            if (vel.play) {
                self.playElement(vel, "remoteVideo");
            }
            // OpenWebRTC does not support oniceconnectionstatechange yet
            if (self.webRtc.isOpenWebRTC()) {
                setState(self, 'connected');
            }
        }, 0);
    }
};

var _tryPlayRemoteAudioStream = function(self) {
    if (self.getRemoteAudioElement() && self.remoteAStream) {
        var player = self.getRemoteAudioElement();
        player.autoplay = true;
        self.assignElement(player,
                           self.URL.createObjectURL(self.remoteAStream),
                           "remoteAudio");
        setTimeout(function() {
            var ael = self.getRemoteAudioElement();
            if (ael.play) {
                self.playElement(ael, "remoteAudio");
            }
            // OpenWebRTC does not support oniceconnectionstatechange yet
            if (self.webRtc.isOpenWebRTC()) {
                setState(self, 'connected');
            }
        }, 0);
    }
};

var checkForErrorListener = function(self) {
    if (self.listeners("error").length === 0) {
        throw new Error(
            "You MUST attach an error listener using call.on('error', function() {})"
        );
    }
};

var callError = function(code, msg) {
    var e = new Error(msg);
    e.code = code;
    return e;
};

var debuglog = function() {
    if (DEBUG) {
        console.log.apply(console, arguments);
    }
};

var _sendCandidateQueue = function(self) {
    if (self.candidateSendQueue.length === 0) {
        return;
    }

    var cands = self.candidateSendQueue;
    self.candidateSendQueue = [];
    ++self.candidateSendTries;
    var content = {
        version: 0,
        call_id: self.callId,
        candidates: cands
    };
    debuglog("Attempting to send " + cands.length + " candidates");
    sendEvent(self, 'm.call.candidates', content).then(function() {
        self.candidateSendTries = 0;
        _sendCandidateQueue(self);
    }, function(error) {
        for (var i = 0; i < cands.length; i++) {
            self.candidateSendQueue.push(cands[i]);
        }

        if (self.candidateSendTries > 5) {
            debuglog(
                "Failed to send candidates on attempt %s. Giving up for now.",
                self.candidateSendTries
            );
            self.candidateSendTries = 0;
            return;
        }

        var delayMs = 500 * Math.pow(2, self.candidateSendTries);
        ++self.candidateSendTries;
        debuglog("Failed to send candidates. Retrying in " + delayMs + "ms");
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, delayMs);
    });
};

var _placeCallWithConstraints = function(self, constraints) {
    self.client.callList[self.callId] = self;
    self.webRtc.getUserMedia(
        constraints,
        hookCallback(self, self._gotUserMediaForInvite),
        hookCallback(self, self._getUserMediaFailed)
    );
    setState(self, 'wait_local_media');
    self.direction = 'outbound';
    self.config = constraints;
};

var _createPeerConnection = function(self) {
    var servers = self.turnServers;
    if (self.webRtc.vendor === "mozilla") {
        // modify turnServers struct to match what mozilla expects.
        servers = [];
        for (var i = 0; i < self.turnServers.length; i++) {
            for (var j = 0; j < self.turnServers[i].urls.length; j++) {
                servers.push({
                    url: self.turnServers[i].urls[j],
                    username: self.turnServers[i].username,
                    credential: self.turnServers[i].credential
                });
            }
        }
    }

    var pc = new self.webRtc.RtcPeerConnection({
        iceServers: servers
    });
    pc.oniceconnectionstatechange = hookCallback(self, self._onIceConnectionStateChanged);
    pc.onsignalingstatechange = hookCallback(self, self._onSignallingStateChanged);
    pc.onicecandidate = hookCallback(self, self._gotLocalIceCandidate);
    pc.onaddstream = hookCallback(self, self._onAddStream);
    return pc;
};

var _getChromeScreenSharingConstraints = function(call) {
    var screen = global.screen;
    if (!screen) {
        call.emit("error", callError(
            MatrixCall.ERR_NO_USER_MEDIA,
            "Couldn't determine screen sharing constaints."
        ));
        return;
    }
    // it won't work at all if you're not on HTTPS so whine whine whine
    if (!global.window || global.window.location.protocol !== "https:") {
        call.emit("error", callError(
            MatrixCall.ERR_NO_USER_MEDIA,
            "You need to be using HTTPS to place a screen-sharing call."
        ));
        return;
    }

    return {
        video: {
            mandatory: {
                chromeMediaSource: "screen",
                chromeMediaSourceId: "" + Date.now(),
                maxWidth: screen.width,
                maxHeight: screen.height,
                minFrameRate: 1,
                maxFrameRate: 10
            }
        }
    };
};

var _getUserMediaVideoContraints = function(callType) {
    switch (callType) {
        case 'voice':
            return ({audio: true, video: false});
        case 'video':
            return ({audio: true, video: {
                mandatory: {
                    minWidth: 640,
                    maxWidth: 640,
                    minHeight: 360,
                    maxHeight: 360
                }
            }});
    }
};

var hookCallback = function(call, fn) {
    return function() {
        return fn.apply(call, arguments);
    };
};

var forAllVideoTracksOnStream = function(s, f) {
    var tracks = s.getVideoTracks();
    for (var i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
};

var forAllAudioTracksOnStream = function(s, f) {
    var tracks = s.getAudioTracks();
    for (var i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
};

var forAllTracksOnStream = function(s, f) {
    forAllVideoTracksOnStream(s, f);
    forAllAudioTracksOnStream(s, f);
};

/** The MatrixCall class. */
module.exports.MatrixCall = MatrixCall;


/**
 * Create a new Matrix call for the browser.
 * @param {MatrixClient} client The client instance to use.
 * @param {string} roomId The room the call is in.
 * @return {MatrixCall} the call or null if the browser doesn't support calling.
 */
module.exports.createNewMatrixCall = function(client, roomId) {
    var w = global.window;
    var doc = global.document;
    if (!w || !doc) {
        return null;
    }
    var webRtc = {};
    webRtc.isOpenWebRTC = function() {
        var scripts = doc.getElementById("script");
        if (!scripts || !scripts.length) {
            return false;
        }
        for (var i = 0; i < scripts.length; i++) {
            if (scripts[i].src.indexOf("owr.js") > -1) {
                return true;
            }
        }
        return false;
    };
    var getUserMedia = (
        w.navigator.getUserMedia || w.navigator.webkitGetUserMedia ||
        w.navigator.mozGetUserMedia
    );
    if (getUserMedia) {
        webRtc.getUserMedia = function() {
            return getUserMedia.apply(w.navigator, arguments);
        };
    }
    webRtc.RtcPeerConnection = (
        w.RTCPeerConnection || w.webkitRTCPeerConnection || w.mozRTCPeerConnection
    );
    webRtc.RtcSessionDescription = (
        w.RTCSessionDescription || w.webkitRTCSessionDescription ||
        w.mozRTCSessionDescription
    );
    webRtc.RtcIceCandidate = (
        w.RTCIceCandidate || w.webkitRTCIceCandidate || w.mozRTCIceCandidate
    );
    webRtc.vendor = null;
    if (w.mozRTCPeerConnection) {
        webRtc.vendor = "mozilla";
    }
    else if (w.webkitRTCPeerConnection) {
        webRtc.vendor = "webkit";
    }
    else if (w.RTCPeerConnection) {
        webRtc.vendor = "generic";
    }
    if (!webRtc.RtcIceCandidate || !webRtc.RtcSessionDescription ||
            !webRtc.RtcPeerConnection || !webRtc.getUserMedia) {
        return null; // WebRTC is not supported.
    }
    var opts = {
        webRtc: webRtc,
        client: client,
        URL: w.URL,
        roomId: roomId,
        turnServers: client.getTurnServers()
    };
    return new MatrixCall(opts);
};
