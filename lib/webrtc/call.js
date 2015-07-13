"use strict";
/**
 * This is an internal module. See {@link createNewMatrixCall} for the public API.
 * @module webrtc/call
 */
var utils = require("../utils");
var EventEmitter = require("events").EventEmitter;

// events: onHangup, callPlaced

/**
 * Construct a new Matrix Call.
 * @constructor
 * @param {Object} opts Config options.
 * @param {string} opts.roomId The room ID for this call.
 * @param {MatrixClient} opts.client The Matrix Client instance to send events to.
 */
function MatrixCall(opts) {
    this.roomId = opts.roomId;
    this.client = opts.client;
    this.webRtc = opts.webRtc;
    // Array of Objects with urls, username, credential keys
    this.turnServers = opts.turnServers || [{
        urls: [MatrixCall.FALLBACK_STUN_SERVER]
    }];
    utils.forEach(this.turnServers, function(server) {
        utils.checkObjectHasKeys(server, ["urls"]);
    });
    this.URL = opts.URL;

    this.callId = "c" + new Date().getTime();
    this.state = 'fledgling';
    this.didConnect = false;

    // A queue for candidates waiting to go out.
    // We try to amalgamate candidates into a single candidate message where
    // possible
    this.candidateSendQueue = [];
    this.candidateSendTries = 0;
}
/** The length of time a call can be ringing for. */
MatrixCall.CALL_TIMEOUT_MS = 60000;
/** The fallback server to use for STUN. */
MatrixCall.FALLBACK_STUN_SERVER = 'stun:stun.l.google.com:19302';

utils.inherits(MatrixCall, EventEmitter);

/**
 * Place a voice call to this room.
 */
MatrixCall.prototype.placeVoiceCall = function() {
    _placeCallWithConstraints(this, _getUserMediaVideoContraints('voice'));
    this.type = 'voice';
};

/**
 * Place a video call to this room.
 */
MatrixCall.prototype.placeVideoCall = function() {
    _placeCallWithConstraints(this, _getUserMediaVideoContraints('video'));
    this.type = 'video';
};

/**
 * Retrieve the local video DOM element.
 * @return {Element} The dom element
 */
MatrixCall.prototype.getLocalVideoElement = function() {
    return this.localVideoSelector;
};

/**
 * Retrieve the remote video DOM element.
 * @return {Element} The dom element
 */
MatrixCall.prototype.getRemoteVideoElement = function() {
    return this.remoteVideoSelector;
};

/**
 * Configure this call from an invite event.
 * @param {MatrixEvent} event The m.call.invite event
 */
MatrixCall.prototype.initWithInvite = function(event) {
    this.msg = event.getContent();
    this.peerConn = _createPeerConnection(this);
    var self = this;
    if (this.peerConn) {
        this.peerConn.setRemoteDescription(
            new this.webRtc.RtcSessionDescription(this.msg.offer),
            function(s) {
                self.onSetRemoteDescriptionSuccess(s);
            },
            function(e) {
                self.onSetRemoteDescriptionError(e);
            }
        );
    }
    this.state = 'ringing';
    this.direction = 'inbound';

    // firefox and Safari's RTCPeerConnection doesn't add streams until it
    // starts getting media on them so we need to figure out whether a video
    // channel has been offered by ourselves.
    if (this.msg.offer.sdp.indexOf('m=video') > -1) {
        this.type = 'video';
    }
    else {
        this.type = 'voice';
    }

    if (event.getAge()) {
        setTimeout(function() {
            if (self.state == 'ringing') {
                self.state = 'ended';
                self.hangupParty = 'remote'; // effectively
                stopAllMedia(self);
                if (self.peerConn.signalingState != 'closed') {
                    self.peerConn.close();
                }
                self.emit("onHangup", self);
            }
        }, this.msg.lifetime - event.getAge());
    }
};

/**
 * Configure this call from a hangup event.
 * @param {MatrixEvent} event The m.call.hangup event
 */
MatrixCall.prototype.initWithHangup = function(event) {
    // perverse as it may seem, sometimes we want to instantiate a call with a
    // hangup message (because when getting the state of the room on load, events
    // come in reverse order and we want to remember that a call has been hung up)
    this.msg = event.getContent();
    this.state = 'ended';
};

/**
 * Answer a call.
 */
MatrixCall.prototype.answer = function() {
    console.log("Answering call " + this.callId);
    var self = this;

    if (!this.localAVStream && !this.waitForLocalAVStream) {
        this.webRtc.getUserMedia(
            _getUserMediaVideoContraints(this.type),
            function(stream) {
                gotUserMediaForAnswer(self, stream);
            },
            this.getUserMediaFailed
        );
        this.state = 'wait_local_media';
    } else if (this.localAVStream) {
        gotUserMediaForAnswer(this, this.localAVStream);
    } else if (this.waitForLocalAVStream) {
        this.state = 'wait_local_media';
    }
};

/**
 * Replace this call with a new call, e.g. for glare resolution.
 * @param {MatrixCall} newCall The new call.
 */
MatrixCall.prototype.replacedBy = function(newCall) {
    console.log(this.callId + " being replaced by " + newCall.callId);
    if (this.state == 'wait_local_media') {
        console.log("Telling new call to wait for local media");
        newCall.waitForLocalAVStream = true;
    } else if (this.state == 'create_offer') {
        console.log("Handing local stream to new call");
        gotUserMediaForAnswer(newCall, this.localAVStream);
        delete(this.localAVStream);
    } else if (this.state == 'invite_sent') {
        console.log("Handing local stream to new call");
        gotUserMediaForAnswer(newCall, this.localAVStream);
        delete(this.localAVStream);
    }
    newCall.localVideoSelector = this.localVideoSelector;
    newCall.remoteVideoSelector = this.remoteVideoSelector;
    this.successor = newCall;
    this.hangup(true);
};

/**
 * Hangup a call.
 * @param {string} reason The reason why the call is being hung up.
 * @param {boolean} suppressEvent True to suppress emitting an event.
 */
MatrixCall.prototype.hangup = function(reason, suppressEvent) {
    console.log("Ending call " + this.callId);
    terminate(this, "local", reason, !suppressEvent);
    var content = {
        version: 0,
        call_id: this.callId,
        reason: reason
    };
    this.sendEvent('m.call.hangup', content);
};

/**
 * Internal
 * @param {Object} stream
 */
MatrixCall.prototype.gotUserMediaForInvite = function(stream) {
    if (this.successor) {
        gotUserMediaForAnswer(this.successor, stream);
        return;
    }
    if (this.state == 'ended') {
        return;
    }
    var self = this;
    var videoEl = this.getLocalVideoElement();

    if (videoEl && this.type == 'video') {
        videoEl.autoplay = true;
        videoEl.src = this.URL.createObjectURL(stream);
        videoEl.muted = true;
        setTimeout(function() {
            var vel = self.getLocalVideoElement();
            if (vel.play) {
                vel.play();
            }
        }, 0);
    }

    this.localAVStream = stream;
    var audioTracks = stream.getAudioTracks();
    for (var i = 0; i < audioTracks.length; i++) {
        audioTracks[i].enabled = true;
    }
    this.peerConn = this._createPeerConnection();
    this.peerConn.addStream(stream);
    this.peerConn.createOffer(function(d) {
        self.gotLocalOffer(d);
    }, function(e) {
        self.getLocalOfferFailed(e);
    });
    self.state = 'create_offer';
};

var gotUserMediaForAnswer = function(self, stream) {
    if (self.state == 'ended') {
        return;
    }
    var localVidEl = self.getLocalVideoElement();

    if (localVidEl && self.type == 'video') {
        localVidEl.autoplay = true;
        localVidEl.src = self.URL.createObjectURL(stream);
        localVidEl.muted = self;
        setTimeout(function() {
            var vel = self.getLocalVideoElement();
            if (vel.play) {
                vel.play();
            }
        }, 0);
    }

    self.localAVStream = stream;
    var audioTracks = stream.getAudioTracks();
    for (var i = 0; i < audioTracks.length; i++) {
        audioTracks[i].enabled = true;
    }
    self.peerConn.addStream(stream);

    var constraints = {
        'mandatory': {
            'OfferToReceiveAudio': true,
            'OfferToReceiveVideo': self.type == 'video'
        },
    };
    self.peerConn.createAnswer(constraints, function(description) {
        console.log("Created answer: " + description);
        self.peerConn.setLocalDescription(description, function() {
            var content = {
                version: 0,
                call_id: self.callId,
                answer: {
                    sdp: self.peerConn.localDescription.sdp,
                    type: self.peerConn.localDescription.type
                }
            };
            self.sendEvent('m.call.answer', content);
            self.state = 'connecting';
        }, function() {
            console.log("Error setting local description!");
        });
    });
    self.state = 'create_answer';
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.gotLocalIceCandidate = function(event) {
    if (event.candidate) {
        console.log(
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
        this.sendCandidate(c);
    }
};

/**
 * Internal
 * @param {Object} cand
 */
MatrixCall.prototype.gotRemoteIceCandidate = function(cand) {
    if (this.state == 'ended') {
        //console.log("Ignoring remote ICE candidate because call has ended");
        return;
    }
    console.log("Got remote ICE " + cand.sdpMid + " candidate: " + cand.candidate);
    this.peerConn.addIceCandidate(
        new this.webRtc.RtcIceCandidate(cand),
        function() {},
        function(e) {}
    );
};

/**
 * Internal
 * @param {Object} msg
 */
MatrixCall.prototype.receivedAnswer = function(msg) {
    if (this.state == 'ended') {
        return;
    }

    var self = this;
    this.peerConn.setRemoteDescription(
        new this.webRtc.RtcSessionDescription(msg.answer),
        function(s) {
            self.onSetRemoteDescriptionSuccess(s);
        },
        function(e) {
           self.onSetRemoteDescriptionError(e);
        }
    );
    this.state = 'connecting';
};

/**
 * Internal
 * @param {Object} description
 */
MatrixCall.prototype.gotLocalOffer = function(description) {
    var self = this;
    console.log("Created offer: " + description);

    if (self.state == 'ended') {
        console.log("Ignoring newly created offer on call ID " + self.callId +
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
        self.sendEvent('m.call.invite', content);

        setTimeout(function() {
            if (self.state == 'invite_sent') {
                self.hangup('invite_timeout');
            }
        }, MatrixCall.CALL_TIMEOUT_MS);
        self.state = 'invite_sent';
    }, function() {
        console.log("Error setting local description!");
    });
};

/**
 * Internal
 * @param {Object} error
 */
MatrixCall.prototype.getLocalOfferFailed = function(error) {
    this.onError("Failed to start audio for call!");
};

/**
 * Internal
 */
MatrixCall.prototype.getUserMediaFailed = function() {
    this.onError(
        "Couldn't start capturing media! Is your microphone set up and does " +
        "this app have permission?"
    );
    this.hangup();
};

/**
 * Internal
 */
MatrixCall.prototype.onIceConnectionStateChanged = function() {
    if (this.state == 'ended') {
        return; // because ICE can still complete as we're ending the call
    }
    console.log(
        "Ice connection state changed to: " + this.peerConn.iceConnectionState
    );
    // ideally we'd consider the call to be connected when we get media but
    // chrome doesn't implement any of the 'onstarted' events yet
    if (this.peerConn.iceConnectionState == 'completed' ||
            this.peerConn.iceConnectionState == 'connected') {
        this.state = 'connected';
        this.didConnect = true;
    } else if (this.peerConn.iceConnectionState == 'failed') {
        this.hangup('ice_failed');
    }
};

/**
 * Internal
 */
MatrixCall.prototype.onSignallingStateChanged = function() {
    console.log(
        "call " + this.callId + ": Signalling state changed to: " +
        this.peerConn.signalingState
    );
};

/**
 * Internal
 */
MatrixCall.prototype.onSetRemoteDescriptionSuccess = function() {
    console.log("Set remote description");
};

/**
 * Internal
 * @param {Object} e
 */
MatrixCall.prototype.onSetRemoteDescriptionError = function(e) {
    console.log("Failed to set remote description" + e);
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.onAddStream = function(event) {
    console.log("Stream added" + event);

    var s = event.stream;

    this.remoteAVStream = s;

    if (this.direction == 'inbound') {
        if (s.getVideoTracks().length > 0) {
            this.type = 'video';
        } else {
            this.type = 'voice';
        }
    }

    var self = this;
    forAllTracksOnStream(s, function(t) {
        // not currently implemented in chrome
        t.onstarted = self.onRemoteStreamTrackStarted;
    });

    event.stream.onended = function(e) { self.onRemoteStreamEnded(e); };
    // not currently implemented in chrome
    event.stream.onstarted = function(e) { self.onRemoteStreamStarted(e); };

    this.tryPlayRemoteStream();
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.tryPlayRemoteStream = function(event) {
    if (this.getRemoteVideoElement() && this.remoteAVStream) {
        var player = this.getRemoteVideoElement();
        player.autoplay = true;
        player.src = this.URL.createObjectURL(this.remoteAVStream);
        var self = this;
        setTimeout(function() {
            var vel = self.getRemoteVideoElement();
            if (vel.play) {
                vel.play();
            }
            // OpenWebRTC does not support oniceconnectionstatechange yet
            if (self.webRtc.isOpenWebRTC()) {
                self.state = 'connected';
            }
        }, 0);
    }
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.onRemoteStreamStarted = function(event) {
    this.state = 'connected';
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.onRemoteStreamEnded = function(event) {
    console.log("Remote stream ended");
    this.state = 'ended';
    this.hangupParty = 'remote';
    stopAllMedia(this);
    if (this.peerConn.signalingState != 'closed') {
        this.peerConn.close();
    }
    this.emit("onHangup", this);
};

/**
 * Internal
 * @param {Object} event
 */
MatrixCall.prototype.onRemoteStreamTrackStarted = function(event) {
    this.state = 'connected';
};

/**
 * Internal
 * @param {Object} msg
 */
MatrixCall.prototype.onHangupReceived = function(msg) {
    console.log("Hangup received");
    terminate(this, "remote", msg.reason, true);
};

/**
 * Internal
 * @param {Object} msg
 */
MatrixCall.prototype.onAnsweredElsewhere = function(msg) {
    console.log("Answered elsewhere");
    terminate(this, "remote", "answered_elsewhere", true);
};

/**
 * Internal
 * @param {string} eventType
 * @param {Object} content
 * @return {Promise}
 */
MatrixCall.prototype.sendEvent = function(eventType, content) {
    return this.client.sendEvent(this.roomId, eventType, content);
};

/**
 * Internal
 * @param {Object} content
 */
MatrixCall.prototype.sendCandidate = function(content) {
    // Sends candidates with are sent in a special way because we try to amalgamate
    // them into one message
    this.candidateSendQueue.push(content);
    var self = this;
    if (this.candidateSendTries === 0) {
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, 100);
    }
};

var terminate = function(self, hangupParty, hangupReason, shouldEmit) {
    if (self.getRemoteVideoElement() && self.getRemoteVideoElement().pause) {
        self.getRemoteVideoElement().pause();
    }
    if (self.getLocalVideoElement() && self.getLocalVideoElement().pause) {
        self.getLocalVideoElement().pause();
    }
    self.state = 'ended';
    self.hangupParty = hangupParty;
    self.hangupReason = hangupReason;
    stopAllMedia(self);
    if (self.peerConn &&
            (hangupParty === "local" || self.peerConn.signalingState != 'closed')) {
        self.peerConn.close();
    }
    if (shouldEmit) {
        self.emit("onHangup", self);
    }
};

var stopAllMedia = function(self) {
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
    if (self.remoteAVStream) {
        forAllTracksOnStream(self.remoteAVStream, function(t) {
            if (t.stop) {
                t.stop();
            }
        });
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
    console.log("Attempting to send " + cands.length + " candidates");
    self.sendEvent('m.call.candidates', content).then(function() {
        self.candidateSendTries = 0;
        _sendCandidateQueue(self);
    }, function(error) {
        for (var i = 0; i < cands.length; i++) {
            self.candidateSendQueue.push(cands[i]);
        }

        if (self.candidateSendTries > 5) {
            console.log(
                "Failed to send candidates on attempt %s. Giving up for now.",
                self.candidateSendTries
            );
            self.candidateSendTries = 0;
            return;
        }

        var delayMs = 500 * Math.pow(2, self.candidateSendTries);
        ++self.candidateSendTries;
        console.log("Failed to send candidates. Retrying in " + delayMs + "ms");
        setTimeout(function() {
            _sendCandidateQueue(self);
        }, delayMs);
    });
};

var _placeCallWithConstraints = function(self, constraints) {
    self.emit("callPlaced", self);
    self.webRtc.getUserMedia(
        constraints, self.gotUserMediaForInvite, self.getUserMediaFailed
    );
    self.state = 'wait_local_media';
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
    pc.oniceconnectionstatechange = self.onIceConnectionStateChanged;
    pc.onsignalingstatechange = self.onSignallingStateChanged;
    pc.onicecandidate = self.gotLocalIceCandidate;
    pc.onaddstream = self.onAddStream;
    return pc;
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
                    maxHeight: 360,
                }
            }});
    }
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
        return null; // Web RTC is not supported.
    }
    var opts = {
        webRtc: webRtc,
        client: client,
        URL: w.URL,
        roomId: roomId
    };
    return new MatrixCall(opts);
};
