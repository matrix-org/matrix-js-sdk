/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/**
 * This is an internal module. See {@link createNewMatrixCall} for the public API.
 * @module webrtc/call
 */

import {logger} from '../logger';
import {EventEmitter} from "events";
import * as utils from "../utils";

const DEBUG = true;  // set true to enable console logging.

// events: hangup, error(err), replaced(call), state(state, oldState)

/**
 * Fires whenever an error occurs when call.js encounters an issue with setting up the call.
 * <p>
 * The error given will have a code equal to either `MatrixCall.ERR_LOCAL_OFFER_FAILED` or
 * `MatrixCall.ERR_NO_USER_MEDIA`. `ERR_LOCAL_OFFER_FAILED` is emitted when the local client
 * fails to create an offer. `ERR_NO_USER_MEDIA` is emitted when the user has denied access
 * to their audio/video hardware.
 *
 * @event module:webrtc/call~MatrixCall#"error"
 * @param {Error} err The error raised by MatrixCall.
 * @example
 * matrixCall.on("error", function(err){
 *   console.error(err.code, err);
 * });
 */

/**
 * Construct a new Matrix Call.
 * @constructor
 * @param {Object} opts Config options.
 * @param {string} opts.roomId The room ID for this call.
 * @param {Object} opts.webRtc The WebRTC globals from the browser.
 * @param {boolean} opts.forceTURN whether relay through TURN should be forced.
 * @param {Object} opts.URL The URL global.
 * @param {Array<Object>} opts.turnServers Optional. A list of TURN servers.
 * @param {MatrixClient} opts.client The Matrix Client instance to send events to.
 */
export function MatrixCall(opts) {
    this.roomId = opts.roomId;
    this.client = opts.client;
    this.webRtc = opts.webRtc;
    this.forceTURN = opts.forceTURN;
    this.URL = opts.URL;
    // Array of Objects with urls, username, credential keys
    this.turnServers = opts.turnServers || [];
    if (this.turnServers.length === 0 && this.client.isFallbackICEServerAllowed()) {
        this.turnServers.push({
            urls: [MatrixCall.FALLBACK_ICE_SERVER],
        });
    }
    utils.forEach(this.turnServers, function(server) {
        utils.checkObjectHasKeys(server, ["urls"]);
    });

    this.callId = "c" + new Date().getTime() + Math.random();
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

    this._answerContent = null;
}
/** The length of time a call can be ringing for. */
MatrixCall.CALL_TIMEOUT_MS = 60000;
/** The fallback ICE server to use for STUN or TURN protocols. */
MatrixCall.FALLBACK_ICE_SERVER = 'stun:turn.matrix.org';
/** An error code when the local client failed to create an offer. */
MatrixCall.ERR_LOCAL_OFFER_FAILED = "local_offer_failed";
/**
 * An error code when there is no local mic/camera to use. This may be because
 * the hardware isn't plugged in, or the user has explicitly denied access.
 */
MatrixCall.ERR_NO_USER_MEDIA = "no_user_media";

/*
 * Error code used when a call event failed to send
 * because unknown devices were present in the room
 */
MatrixCall.ERR_UNKNOWN_DEVICES = "unknown_devices";

/*
 * Error code usewd when we fail to send the invite
 * for some reason other than there being unknown devices
 */
MatrixCall.ERR_SEND_INVITE = "send_invite";

/*
 * Error code usewd when we fail to send the answer
 * for some reason other than there being unknown devices
 */
MatrixCall.ERR_SEND_ANSWER = "send_answer";

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
 * only works in Google Chrome and Firefox >= 44.</b>
 * @param {Element} remoteVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render video to.
 * @param {Element} localVideoElement a <code>&lt;video&gt;</code> DOM element
 * to render the local camera preview.
 * @throws If you have not specified a listener for 'error' events.
 */
MatrixCall.prototype.placeScreenSharingCall =
    async function(remoteVideoElement, localVideoElement) {
    debuglog("placeScreenSharingCall");
    checkForErrorListener(this);
    this.localVideoElement = localVideoElement;
    this.remoteVideoElement = remoteVideoElement;
    const self = this;
    try {
        self.screenSharingStream = await this.webRtc.getDisplayMedia({'audio': false});
        debuglog("Got screen stream, requesting audio stream...");
        const audioConstraints = _getUserMediaVideoContraints('voice');
        _placeCallWithConstraints(self, audioConstraints);
    } catch(err) {
        self.emit("error",
            callError(
                MatrixCall.ERR_NO_USER_MEDIA,
                "Failed to get screen-sharing stream: " + err,
            ),
        );
    }

    this.type = 'video';
    _tryPlayRemoteStream(this);
};

/**
 * Play the given HTMLMediaElement, serialising the operation into a chain
 * of promises to avoid racing access to the element
 * @param {Element} element HTMLMediaElement element to play
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.playElement = function(element, queueId) {
    logger.log("queuing play on " + queueId + " and element " + element);
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
                logger.log("previous promise completed for " + queueId);
                return element.play();
            }, function() {
                logger.log("previous promise failed for " + queueId);
                return element.play();
            });
    } else {
        this.mediaPromises[queueId] = element.play();
    }
};

/**
 * Pause the given HTMLMediaElement, serialising the operation into a chain
 * of promises to avoid racing access to the element
 * @param {Element} element HTMLMediaElement element to pause
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.pauseElement = function(element, queueId) {
    logger.log("queuing pause on " + queueId + " and element " + element);
    if (this.mediaPromises[queueId]) {
        this.mediaPromises[queueId] =
            this.mediaPromises[queueId].then(function() {
                logger.log("previous promise completed for " + queueId);
                return element.pause();
            }, function() {
                logger.log("previous promise failed for " + queueId);
                return element.pause();
            });
    } else {
        // pause doesn't actually return a promise, but do this for symmetry
        // and just in case it does in future.
        this.mediaPromises[queueId] = element.pause();
    }
};

/**
 * Assign the given HTMLMediaElement by setting the .src attribute on it,
 * serialising the operation into a chain of promises to avoid racing access
 * to the element
 * @param {Element} element HTMLMediaElement element to pause
 * @param {MediaStream} srcObject the srcObject attribute value to assign to the element
 * @param {string} queueId Arbitrary ID to track the chain of promises to be used
 */
MatrixCall.prototype.assignElement = function(element, srcObject, queueId) {
    logger.log("queuing assign on " + queueId + " element " + element + " for " +
        srcObject);
    if (this.mediaPromises[queueId]) {
        this.mediaPromises[queueId] =
            this.mediaPromises[queueId].then(function() {
                logger.log("previous promise completed for " + queueId);
                element.srcObject = srcObject;
            }, function() {
                logger.log("previous promise failed for " + queueId);
                element.srcObject = srcObject;
            });
    } else {
        element.srcObject = srcObject;
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
        this.assignElement(element, this.localAVStream, "localVideo");
        element.muted = true;
        const self = this;
        setTimeout(function() {
            const vel = self.getLocalVideoElement();
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
    this.remoteAudioElement.muted = false;
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
    const self = this;
    if (this.peerConn) {
        this.peerConn.setRemoteDescription(
            new this.webRtc.RtcSessionDescription(this.msg.offer),
            hookCallback(self, self._onSetRemoteDescriptionSuccess),
            hookCallback(self, self._onSetRemoteDescriptionError),
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
    } else {
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
    const self = this;

    if (self._answerContent) {
        self._sendAnswer();
        return;
    }

    if (!this.localAVStream && !this.waitForLocalAVStream) {
        this.webRtc.getUserMedia(
            _getUserMediaVideoContraints(this.type),
            hookCallback(self, self._maybeGotUserMediaForAnswer),
            hookCallback(self, self._maybeGotUserMediaForAnswer),
        );
        setState(this, 'wait_local_media');
    } else if (this.localAVStream) {
        this._maybeGotUserMediaForAnswer(this.localAVStream);
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
        newCall._maybeGotUserMediaForAnswer(this.localAVStream);
        delete(this.localAVStream);
    } else if (this.state == 'invite_sent') {
        debuglog("Handing local stream to new call");
        newCall._maybeGotUserMediaForAnswer(this.localAVStream);
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
    if (this.state == 'ended') return;

    debuglog("Ending call " + this.callId);
    terminate(this, "local", reason, !suppressEvent);
    const content = {
        version: 0,
        call_id: this.callId,
        reason: reason,
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
MatrixCall.prototype._maybeGotUserMediaForInvite = function(stream) {
    if (this.successor) {
        this.successor._maybeGotUserMediaForAnswer(stream);
        return;
    }
    if (this.state == 'ended') {
        return;
    }
    debuglog("_maybeGotUserMediaForInvite -> " + this.type);
    const self = this;

    const error = stream;
    const constraints = {
        'mandatory': {
            'OfferToReceiveAudio': true,
            'OfferToReceiveVideo': self.type === 'video',
        },
    };
    if (stream instanceof MediaStream) {
        const videoEl = this.getLocalVideoElement();

        if (videoEl && this.type == 'video') {
            videoEl.autoplay = true;
            if (this.screenSharingStream) {
                debuglog("Setting screen sharing stream to the local video" +
                    " element");
                this.assignElement(videoEl, this.screenSharingStream, "localVideo");
            } else {
                this.assignElement(videoEl, stream, "localVideo");
            }
            videoEl.muted = true;
            setTimeout(function() {
                const vel = self.getLocalVideoElement();
                if (vel.play) {
                    self.playElement(vel, "localVideo");
                }
            }, 0);
        }

        if (this.screenSharingStream) {
            this.screenSharingStream.addTrack(stream.getAudioTracks()[0]);
            stream = this.screenSharingStream;
        }

        this.localAVStream = stream;
        // why do we enable audio (and only audio) tracks here? -- matthew
        setTracksEnabled(stream.getAudioTracks(), true);
        this.peerConn = _createPeerConnection(this);
        this.peerConn.addStream(stream);
    } else if (error.name === 'PermissionDeniedError') {
        debuglog('User denied access to camera/microphone.' +
            ' Or possibly you are using an insecure domain. Receiving only.');
        this.peerConn = _createPeerConnection(this);
    } else {
        debuglog('Failed to getUserMedia: ' + error.name);
        this._getUserMediaFailed(error);
        return;
    }

    this.peerConn.createOffer(
        hookCallback(self, self._gotLocalOffer),
        hookCallback(self, self._getLocalOfferFailed),
        constraints,
    );
    setState(self, 'create_offer');
};

MatrixCall.prototype._sendAnswer = function(stream) {
    sendEvent(this, 'm.call.answer', this._answerContent).then(() => {
        setState(this, 'connecting');
        // If this isn't the first time we've tried to send the answer,
        // we may have candidates queued up, so send them now.
        _sendCandidateQueue(this);
    }).catch((error) => {
        // We've failed to answer: back to the ringing state
        setState(this, 'ringing');
        this.client.cancelPendingEvent(error.event);

        let code = MatrixCall.ERR_SEND_ANSWER;
        let message = "Failed to send answer";
        if (error.name == 'UnknownDeviceError') {
            code = MatrixCall.ERR_UNKNOWN_DEVICES;
            message = "Unknown devices present in the room";
        }
        this.emit("error", callError(code, message));
        throw error;
    });
};

/**
 * Internal
 * @private
 * @param {Object} stream
 */
MatrixCall.prototype._maybeGotUserMediaForAnswer = function(stream) {
    const self = this;
    if (self.state == 'ended') {
        return;
    }

    const error = stream;
    if (stream instanceof MediaStream) {
        const localVidEl = self.getLocalVideoElement();

        if (localVidEl && self.type == 'video') {
            localVidEl.autoplay = true;
            this.assignElement(localVidEl, stream, "localVideo");
            localVidEl.muted = true;
            setTimeout(function() {
                const vel = self.getLocalVideoElement();
                if (vel.play) {
                    self.playElement(vel, "localVideo");
                }
            }, 0);
        }

        self.localAVStream = stream;
        setTracksEnabled(stream.getAudioTracks(), true);
        self.peerConn.addStream(stream);
    } else if (error.name === 'PermissionDeniedError') {
        debuglog('User denied access to camera/microphone.' +
            ' Or possibly you are using an insecure domain. Receiving only.');
    } else {
        debuglog('Failed to getUserMedia: ' + error.name);
        this._getUserMediaFailed(error);
        return;
    }

    const constraints = {
        'mandatory': {
            'OfferToReceiveAudio': true,
            'OfferToReceiveVideo': self.type === 'video',
        },
    };
    self.peerConn.createAnswer(function(description) {
        debuglog("Created answer: ", description);
        self.peerConn.setLocalDescription(description, function() {
            self._answerContent = {
                version: 0,
                call_id: self.callId,
                answer: {
                    sdp: self.peerConn.localDescription.sdp,
                    type: self.peerConn.localDescription.type,
                },
            };
            self._sendAnswer();
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
            event.candidate.candidate,
        );

        if (this.state == 'ended') return;

        // As with the offer, note we need to make a copy of this object, not
        // pass the original: that broke in Chrome ~m43.
        const c = {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
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
        function(e) {},
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

    const self = this;
    this.peerConn.setRemoteDescription(
        new this.webRtc.RtcSessionDescription(msg.answer),
        hookCallback(self, self._onSetRemoteDescriptionSuccess),
        hookCallback(self, self._onSetRemoteDescriptionError),
    );
    setState(self, 'connecting');
};

/**
 * Internal
 * @private
 * @param {Object} description
 */
MatrixCall.prototype._gotLocalOffer = function(description) {
    const self = this;
    debuglog("Created offer: ", description);

    if (self.state == 'ended') {
        debuglog("Ignoring newly created offer on call ID " + self.callId +
            " because the call has ended");
        return;
    }

    self.peerConn.setLocalDescription(description, function() {
        const content = {
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
                type: self.peerConn.localDescription.type,
            },
            lifetime: MatrixCall.CALL_TIMEOUT_MS,
        };
        sendEvent(self, 'm.call.invite', content).then(() => {
            setState(self, 'invite_sent');
            setTimeout(function() {
                if (self.state == 'invite_sent') {
                    self.hangup('invite_timeout');
                }
            }, MatrixCall.CALL_TIMEOUT_MS);
        }).catch((error) => {
            let code = MatrixCall.ERR_SEND_INVITE;
            let message = "Failed to send invite";
            if (error.name == 'UnknownDeviceError') {
                code = MatrixCall.ERR_UNKNOWN_DEVICES;
                message = "Unknown devices present in the room";
            }

            self.client.cancelPendingEvent(error.event);
            terminate(self, "local", code, false);
            self.emit("error", callError(code, message));
            throw error;
        });
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
        callError(MatrixCall.ERR_LOCAL_OFFER_FAILED, "Failed to start audio for call!"),
    );
};

/**
 * Internal
 * @private
 * @param {Object} error
 */
MatrixCall.prototype._getUserMediaFailed = function(error) {
    terminate(this, "local", 'user_media_failed', false);
    this.emit(
        "error",
        callError(
            MatrixCall.ERR_NO_USER_MEDIA,
            "Couldn't start capturing media! Is your microphone set up and " +
            "does this app have permission?",
        ),
    );
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
        "Ice connection state changed to: " + this.peerConn.iceConnectionState,
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
        this.peerConn.signalingState,
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

    const s = event.stream;

    if (s.getVideoTracks().length > 0) {
        this.type = 'video';
        this.remoteAVStream = s;
        this.remoteAStream = s;
    } else {
        this.type = 'voice';
        this.remoteAStream = s;
    }

    const self = this;
    forAllTracksOnStream(s, function(t) {
        debuglog("Track id " + t.id + " added");
        // not currently implemented in chrome
        t.onstarted = hookCallback(self, self._onRemoteStreamTrackStarted);
    });

    if (event.stream.oninactive !== undefined) {
        event.stream.oninactive = hookCallback(self, self._onRemoteStreamEnded);
    } else {
        // onended is deprecated from Chrome 54
        event.stream.onended = hookCallback(self, self._onRemoteStreamEnded);
    }

    // not currently implemented in chrome
    event.stream.onstarted = hookCallback(self, self._onRemoteStreamStarted);

    if (this.type === 'video') {
        _tryPlayRemoteStream(this);
        _tryPlayRemoteAudioStream(this);
    } else {
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

const setTracksEnabled = function(tracks, enabled) {
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = enabled;
    }
};

const isTracksEnabled = function(tracks) {
    for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].enabled) {
            return true; // at least one track is enabled
        }
    }
    return false;
};

const setState = function(self, state) {
    const oldState = self.state;
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
const sendEvent = function(self, eventType, content) {
    return self.client.sendEvent(self.roomId, eventType, content);
};

const sendCandidate = function(self, content) {
    // Sends candidates with are sent in a special way because we try to amalgamate
    // them into one message
    self.candidateSendQueue.push(content);

    // Don't send the ICE candidates yet if the call is in the ringing state: this
    // means we tried to pick (ie. started generating candidates) and then failed to
    // send the answer and went back to the ringing state. Queue up the candidates
    // to send if we sucessfully send the answer.
    if (self.state == 'ringing') return;

    if (self.candidateSendTries === 0) {
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, 100);
    }
};

const terminate = function(self, hangupParty, hangupReason, shouldEmit) {
    if (self.getRemoteVideoElement()) {
        if (self.getRemoteVideoElement().pause) {
            self.pauseElement(self.getRemoteVideoElement(), "remoteVideo");
        }
        self.assignElement(self.getRemoteVideoElement(), null, "remoteVideo");
    }
    if (self.getRemoteAudioElement()) {
        if (self.getRemoteAudioElement().pause) {
            self.pauseElement(self.getRemoteAudioElement(), "remoteAudio");
        }
        self.assignElement(self.getRemoteAudioElement(), null, "remoteAudio");
    }
    if (self.getLocalVideoElement()) {
        if (self.getLocalVideoElement().pause) {
            self.pauseElement(self.getLocalVideoElement(), "localVideo");
        }
        self.assignElement(self.getLocalVideoElement(), null, "localVideo");
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

const stopAllMedia = function(self) {
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

const _tryPlayRemoteStream = function(self) {
    if (self.getRemoteVideoElement() && self.remoteAVStream) {
        const player = self.getRemoteVideoElement();
        player.autoplay = true;
        self.assignElement(player, self.remoteAVStream, "remoteVideo");
        setTimeout(function() {
            const vel = self.getRemoteVideoElement();
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

const _tryPlayRemoteAudioStream = async function(self) {
    if (self.getRemoteAudioElement() && self.remoteAStream) {
        const player = self.getRemoteAudioElement();

        // if audioOutput is non-default:
        if (audioOutput) await player.setSinkId(audioOutput);

        player.autoplay = true;
        self.assignElement(player, self.remoteAStream, "remoteAudio");
        setTimeout(function() {
            const ael = self.getRemoteAudioElement();
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

const checkForErrorListener = function(self) {
    if (self.listeners("error").length === 0) {
        throw new Error(
            "You MUST attach an error listener using call.on('error', function() {})",
        );
    }
};

const callError = function(code, msg) {
    const e = new Error(msg);
    e.code = code;
    return e;
};

const debuglog = function() {
    if (DEBUG) {
        logger.log(...arguments);
    }
};

const _sendCandidateQueue = function(self) {
    if (self.candidateSendQueue.length === 0) {
        return;
    }

    const cands = self.candidateSendQueue;
    self.candidateSendQueue = [];
    ++self.candidateSendTries;
    const content = {
        version: 0,
        call_id: self.callId,
        candidates: cands,
    };
    debuglog("Attempting to send " + cands.length + " candidates");
    sendEvent(self, 'm.call.candidates', content).then(function() {
        self.candidateSendTries = 0;
        _sendCandidateQueue(self);
    }, function(error) {
        for (let i = 0; i < cands.length; i++) {
            self.candidateSendQueue.push(cands[i]);
        }

        if (self.candidateSendTries > 5) {
            debuglog(
                "Failed to send candidates on attempt %s. Giving up for now.",
                self.candidateSendTries,
            );
            self.candidateSendTries = 0;
            return;
        }

        const delayMs = 500 * Math.pow(2, self.candidateSendTries);
        ++self.candidateSendTries;
        debuglog("Failed to send candidates. Retrying in " + delayMs + "ms");
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, delayMs);
    });
};

const _placeCallWithConstraints = function(self, constraints) {
    self.client.callList[self.callId] = self;
    self.webRtc.getUserMedia(
        constraints,
        hookCallback(self, self._maybeGotUserMediaForInvite),
        hookCallback(self, self._maybeGotUserMediaForInvite),
    );
    setState(self, 'wait_local_media');
    self.direction = 'outbound';
    self.config = constraints;
};

const _createPeerConnection = function(self) {
    const pc = new self.webRtc.RtcPeerConnection({
        iceTransportPolicy: self.forceTURN ? 'relay' : undefined,
        iceServers: self.turnServers,
    });
    pc.oniceconnectionstatechange = hookCallback(self, self._onIceConnectionStateChanged);
    pc.onsignalingstatechange = hookCallback(self, self._onSignallingStateChanged);
    pc.onicecandidate = hookCallback(self, self._gotLocalIceCandidate);
    pc.onaddstream = hookCallback(self, self._onAddStream);
    return pc;
};

const _getUserMediaVideoContraints = function(callType) {
    const isWebkit = !!global.window.navigator.webkitGetUserMedia;

    switch (callType) {
        case 'voice':
            return {
                audio: {
                    deviceId: audioInput ? {ideal: audioInput} : undefined,
                }, video: false,
            };
        case 'video':
            return {
                audio: {
                    deviceId: audioInput ? {ideal: audioInput} : undefined,
                }, video: {
                    deviceId: videoInput ? {ideal: videoInput} : undefined,
                    /* We want 640x360.  Chrome will give it only if we ask exactly,
                       FF refuses entirely if we ask exactly, so have to ask for ideal
                       instead */
                    width: isWebkit ? { exact: 640 } : { ideal: 640 },
                    height: isWebkit ? { exact: 360 } : { ideal: 360 },
                },
            };
    }
};

const hookCallback = function(call, fn) {
    return function() {
        return fn.apply(call, arguments);
    };
};

const forAllVideoTracksOnStream = function(s, f) {
    const tracks = s.getVideoTracks();
    for (let i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
};

const forAllAudioTracksOnStream = function(s, f) {
    const tracks = s.getAudioTracks();
    for (let i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
};

const forAllTracksOnStream = function(s, f) {
    forAllVideoTracksOnStream(s, f);
    forAllAudioTracksOnStream(s, f);
};

let audioOutput;
let audioInput;
let videoInput;
/**
 * Set an audio output device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioOutput(deviceId) { audioOutput = deviceId; }
/**
 * Set an audio input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioInput(deviceId) { audioInput = deviceId; }
/**
 * Set a video input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setVideoInput(deviceId) { videoInput = deviceId; }

/**
 * Create a new Matrix call for the browser.
 * @param {MatrixClient} client The client instance to use.
 * @param {string} roomId The room the call is in.
 * @param {Object?} options DEPRECATED optional options map.
 * @param {boolean} options.forceTURN DEPRECATED whether relay through TURN should be
 * forced. This option is deprecated - use opts.forceTURN when creating the matrix client
 * since it's only possible to set this option on outbound calls.
 * @return {MatrixCall} the call or null if the browser doesn't support calling.
 */
export function createNewMatrixCall(client, roomId, options) {
    const w = global.window;
    const doc = global.document;
    if (!w || !doc) {
        return null;
    }
    const webRtc = {};
    webRtc.isOpenWebRTC = function() {
        const scripts = doc.getElementById("script");
        if (!scripts || !scripts.length) {
            return false;
        }
        for (let i = 0; i < scripts.length; i++) {
            if (scripts[i].src.indexOf("owr.js") > -1) {
                return true;
            }
        }
        return false;
    };
    const getUserMedia = (
        w.navigator.getUserMedia || w.navigator.webkitGetUserMedia ||
        w.navigator.mozGetUserMedia
    );
    if (getUserMedia) {
        webRtc.getUserMedia = function() {
            return getUserMedia.apply(w.navigator, arguments);
        };
    }

    const getDisplayMedia = (
        w.navigator.mediaDevices && w.navigator.mediaDevices.getDisplayMedia ||
        w.navigator.getDisplayMedia
    );
    if (getDisplayMedia) {
        webRtc.getDisplayMedia = getDisplayMedia.bind(w.navigator.mediaDevices);
    }

    // Firefox throws on so little as accessing the RTCPeerConnection when operating in
    // a secure mode. There's some information at https://bugzilla.mozilla.org/show_bug.cgi?id=1542616
    // though the concern is that the browser throwing a SecurityError will brick the
    // client creation process.
    try {
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
        } else if (w.webkitRTCPeerConnection) {
            webRtc.vendor = "webkit";
        } else if (w.RTCPeerConnection) {
            webRtc.vendor = "generic";
        }
    } catch (e) {
        logger.error("Failed to set up WebRTC object: possible browser interference?");
        logger.error(e);
        return null;
    }

    if (!webRtc.RtcIceCandidate || !webRtc.RtcSessionDescription ||
            !webRtc.RtcPeerConnection || !webRtc.getUserMedia) {
        return null; // WebRTC is not supported.
    }

    const optionsForceTURN = options ? options.forceTURN : false;

    const opts = {
        webRtc: webRtc,
        client: client,
        URL: w.URL,
        roomId: roomId,
        turnServers: client.getTurnServers(),
        // call level options
        forceTURN: client._forceTURN || optionsForceTURN,
    };
    return new MatrixCall(opts);
}
