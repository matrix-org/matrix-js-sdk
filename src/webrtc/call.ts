/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

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
import MatrixEvent from "../models/event"

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

interface CallOpts {
    roomId: string,
    client: any, // Fix when client is TSified
    forceTURN: boolean,
    turnServers: Array<TurnServer>,
}

interface TurnServer {
    urls: Array<string>,
    username?: string,
    password?: string,
    ttl?: number,
}

enum CallState {
    Fledgling = 'fledgling',
    InviteSent = 'invite_sent',
    WaitLocalMedia = 'wait_local_media',
    CreateOffer = 'create_offer',
    CreateAnswer = 'create_answer',
    Connecting = 'connecting',
    Connected = 'connected',
    Ringing = 'ringing',
    Ended = 'ended',
}

enum CallType {
    Voice = 'voice',
    Video = 'video',
}

enum CallDirection {
    Inbound = 'inbound',
    Outbound = 'outbound',
}

enum CallParty {
    Local = 'local',
    Remote = 'remote',
}

enum MediaQueueId {
    RemoteVideo = 'remote_video',
    RemoteAudio = 'remote_audio',
    LocalVideo = 'local_video',
}

enum CallErrorCode {
    /** An error code when the local client failed to create an offer. */
    LocalOfferFailed = 'local_offer_failed',
    /**
     * An error code when there is no local mic/camera to use. This may be because
     * the hardware isn't plugged in, or the user has explicitly denied access.
     */
    NoUserMedia = 'no_user_media',

    /**
     * Error code used when a call event failed to send
     * because unknown devices were present in the room
     */
    UnknownDevices = 'unknown_devices',

    /**
     * Error code usewd when we fail to send the invite
     * for some reason other than there being unknown devices
     */
    SendInvite = 'send_invite',

    /**
     * An answer could not be created
     */
    CreateAnswer = 'create_answer',

    /**
     * Error code usewd when we fail to send the answer
     * for some reason other than there being unknown devices
     */
    SendAnswer = 'send_answer',

    /**
     * The session description from the other side could not be set
     */
    SetRemoteDescription = 'set_remote_description',

    /**
     * The session description from this side could not be set
     */
    SetLocalDescription = 'set_local_description',

    /**
     * A different device answered the call
     */
    AnsweredElsewhere = 'answered_elsewhere',

    /**
     * No media connection could be established to the other party
     */
    IceFailed = 'ice_failed',

    /**
     * The invite timed out whilst waiting for an answer
     */
    InviteTimeout = 'invite_timeout',

    /**
     * The call was replaced by another call
     */
    Replaced = 'replaced',
}

/** The fallback ICE server to use for STUN or TURN protocols. */
const FALLBACK_ICE_SERVER = 'stun:turn.matrix.org';

/** The length of time a call can be ringing for. */
const CALL_TIMEOUT_MS = 60000;

class CallError extends Error {
    code : string;

    constructor(code : CallErrorCode, msg: string, err: Error) {
        // Stil ldon't think there's any way to have proper nested errors
        super(msg + ": " + err);

        this.code = code;
    }
}

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
export class MatrixCall extends EventEmitter {
    roomId: string;
    type: CallType;
    callId: string;
    state: CallState;
    hangupParty: CallParty;
    hangupReason: string;
    direction: CallDirection;

    private client: any; // Fix when client is TSified
    private forceTURN: boolean;
    private turnServers: Array<TurnServer>;
    private candidateSendQueue: Array<RTCIceCandidate>;
    private candidateSendTries: number;
    private mediaPromises: { [queueId: string]: Promise<void>; };
    private sentEndOfCandidates: boolean;
    private peerConn: RTCPeerConnection;
    private localVideoElement: HTMLVideoElement;
    private remoteVideoElement: HTMLVideoElement;
    private remoteAudioElement: HTMLAudioElement;
    private screenSharingStream: MediaStream;
    private remoteStream: MediaStream;
    private localAVStream: MediaStream;
    private answerContent: object;
    private waitForLocalAVStream: boolean;
    // XXX: This is either the invite or answer from remote...
    private msg: any;
    // XXX: I don't know why this is called 'config'.
    private config: MediaStreamConstraints;
    private successor: MatrixCall;

    constructor(opts: CallOpts) {
        super();
        this.roomId = opts.roomId;
        this.client = opts.client;
        this.type = null;
        this.forceTURN = opts.forceTURN;
        // Array of Objects with urls, username, credential keys
        this.turnServers = opts.turnServers || [];
        if (this.turnServers.length === 0 && this.client.isFallbackICEServerAllowed()) {
            this.turnServers.push({
                urls: [FALLBACK_ICE_SERVER],
            });
        }
        for (const server of this.turnServers) {
            utils.checkObjectHasKeys(server, ["urls"]);
        }

        this.callId = "c" + new Date().getTime() + Math.random();
        this.state = CallState.Fledgling;

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

        this.sentEndOfCandidates = false;
    }

    /**
     * Place a voice call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    placeVoiceCall() {
        logger.debug("placeVoiceCall");
        this.checkForErrorListener();
        this.placeCallWithConstraints(getUserMediaVideoContraints(CallType.Voice));
        this.type = CallType.Voice;
    }

    /**
     * Place a video call to this room.
     * @param {Element} remoteVideoElement a <code>&lt;video&gt;</code> DOM element
     * to render video to.
     * @param {Element} localVideoElement a <code>&lt;video&gt;</code> DOM element
     * to render the local camera preview.
     * @throws If you have not specified a listener for 'error' events.
     */
    placeVideoCall(remoteVideoElement: HTMLVideoElement, localVideoElement: HTMLVideoElement) {
        logger.debug("placeVideoCall");
        this.checkForErrorListener();
        this.localVideoElement = localVideoElement;
        this.remoteVideoElement = remoteVideoElement;
        this.placeCallWithConstraints(getUserMediaVideoContraints(CallType.Video));
        this.type = CallType.Video;
    }

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
    async placeScreenSharingCall(remoteVideoElement: HTMLVideoElement, localVideoElement: HTMLVideoElement) {
        logger.debug("placeScreenSharingCall");
        this.checkForErrorListener();
        this.localVideoElement = localVideoElement;
        this.remoteVideoElement = remoteVideoElement;
        try {
            this.screenSharingStream = await navigator.mediaDevices.getDisplayMedia({'audio': false});
            logger.debug("Got screen stream, requesting audio stream...");
            const audioConstraints = getUserMediaVideoContraints(CallType.Voice);
            this.placeCallWithConstraints(audioConstraints);
        } catch (err) {
            this.emit("error",
                new CallError(
                    CallErrorCode.NoUserMedia,
                    "Failed to get screen-sharing stream: ", err,
                ),
            );
        }

        this.type = CallType.Video;
    }

    private queueMediaOperation(queueId: MediaQueueId, operation: () => any) {
        if (this.mediaPromises[queueId] !== undefined) {
            this.mediaPromises[queueId] = this.mediaPromises[queueId].then(operation, operation);
        } else {
            this.mediaPromises[queueId] = Promise.resolve(operation());
        }
    }

    /**
     * Retrieve the local <code>&lt;video&gt;</code> DOM element.
     * @return {Element} The dom element
     */
    getLocalVideoElement(): HTMLVideoElement {
        return this.localVideoElement;
    }

    /**
     * Retrieve the remote <code>&lt;video&gt;</code> DOM element
     * used for playing back video capable streams.
     * @return {Element} The dom element
     */
    getRemoteVideoElement(): HTMLVideoElement {
        return this.remoteVideoElement;
    }

    /**
     * Retrieve the remote <code>&lt;audio&gt;</code> DOM element
     * used for playing back audio only streams.
     * @return {Element} The dom element
     */
    getRemoteAudioElement(): HTMLAudioElement {
        return this.remoteAudioElement;
    }

    /**
     * Set the local <code>&lt;video&gt;</code> DOM element. If this call is active,
     * video will be rendered to it immediately.
     * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
     */
    setLocalVideoElement(element : HTMLVideoElement) {
        this.localVideoElement = element;

        if (element && this.localAVStream && this.type === CallType.Video) {
            element.autoplay = true;

            this.queueMediaOperation(MediaQueueId.LocalVideo, () => {
                element.srcObject = this.localAVStream;
                element.muted = true;
                return element.play();
            });
        }
    }

    /**
     * Set the remote <code>&lt;video&gt;</code> DOM element. If this call is active,
     * the first received video-capable stream will be rendered to it immediately.
     * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
     */
    setRemoteVideoElement(element : HTMLVideoElement) {
        if (element === this.remoteVideoElement) return;

        element.autoplay = true;

        // if we already have an audio element set, use that instead and mute the audio
        // on this video element.
        if (this.remoteAudioElement) element.muted = true;

        this.remoteVideoElement = element;

        if (this.remoteStream) {
            this.queueMediaOperation(MediaQueueId.RemoteVideo, () => {
                element.srcObject = this.remoteStream;
                return element.play();
            });
        }
    }

    /**
     * Set the remote <code>&lt;audio&gt;</code> DOM element. If this call is active,
     * the first received audio-only stream will be rendered to it immediately.
     * The audio will *not* be rendered from the remoteVideoElement.
     * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
     */
    async setRemoteAudioElement(element: HTMLAudioElement) {
        if (element === this.remoteAudioElement) return;

        this.remoteVideoElement.muted = true;
        this.remoteAudioElement = element;
        this.remoteAudioElement.muted = false;

        if (this.remoteStream) this.playRemoteAudio();
    }

    /**
     * Configure this call from an invite event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.invite event
     */
    async initWithInvite(event: MatrixEvent) {
        this.msg = event.getContent();
        this.peerConn = this.createPeerConnection();
        try {
            await this.peerConn.setRemoteDescription(this.msg.offer);
        } catch (e) {
            logger.debug("Failed to set remote description", e);
            this.terminate(CallParty.Local, CallErrorCode.SetRemoteDescription, false);
            return;
        }

        this.setState(CallState.Ringing);
        this.direction = CallDirection.Inbound;

        // firefox and OpenWebRTC's RTCPeerConnection doesn't add streams until it
        // starts getting media on them so we need to figure out whether a video
        // channel has been offered by ourselves.
        // XXX: This comment is probably outdated: check & remove this if so
        if (
            this.msg.offer &&
            this.msg.offer.sdp &&
            this.msg.offer.sdp.indexOf('m=video') > -1
        ) {
            this.type = CallType.Video;
        } else {
            this.type = CallType.Voice;
        }

        if (event.getAge()) {
            setTimeout(() => {
                if (this.state == CallState.Ringing) {
                    logger.debug("Call invite has expired. Hanging up.");
                    this.hangupParty = CallParty.Remote; // effectively
                    this.setState(CallState.Ended);
                    this.stopAllMedia();
                    if (this.peerConn.signalingState != 'closed') {
                        this.peerConn.close();
                    }
                    this.emit("hangup");
                }
            }, this.msg.lifetime - event.getAge());
        }
    }

    /**
     * Configure this call from a hangup event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.hangup event
     */
    initWithHangup(event: MatrixEvent) {
        // perverse as it may seem, sometimes we want to instantiate a call with a
        // hangup message (because when getting the state of the room on load, events
        // come in reverse order and we want to remember that a call has been hung up)
        this.msg = event.getContent();
        this.setState(CallState.Ended);
    }

    /**
     * Answer a call.
     */
    async answer() {
        logger.debug(`Answering call ${this.callId} of type ${this.type}`);

        if (this.answerContent) {
            this.sendAnswer();
            return;
        }

        if (!this.localAVStream && !this.waitForLocalAVStream) {
            const constraints = getUserMediaVideoContraints(this.type);
            logger.log("Getting user media with constraints", constraints);
            this.setState(CallState.WaitLocalMedia);

            try {
                const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
                this.gotUserMediaForAnswer(mediaStream);
            } catch (e) {
                this.getUserMediaFailed(e);
                return
            }
        } else if (this.localAVStream) {
            this.gotUserMediaForAnswer(this.localAVStream);
        } else if (this.waitForLocalAVStream) {
            this.setState(CallState.WaitLocalMedia);
        }
    }

    /**
     * Replace this call with a new call, e.g. for glare resolution. Used by
     * MatrixClient.
     * @param {MatrixCall} newCall The new call.
     */
    replacedBy(newCall: MatrixCall) {
        logger.debug(this.callId + " being replaced by " + newCall.callId);
        if (this.state === CallState.WaitLocalMedia) {
            logger.debug("Telling new call to wait for local media");
            newCall.waitForLocalAVStream = true;
        } else if (this.state === CallState.CreateOffer) {
            logger.debugl("Handing local stream to new call");
            newCall.gotUserMediaForAnswer(this.localAVStream);
            delete(this.localAVStream);
        } else if (this.state === CallState.InviteSent) {
            logger.debug("Handing local stream to new call");
            newCall.gotUserMediaForAnswer(this.localAVStream);
            delete(this.localAVStream);
        }
        newCall.localVideoElement = this.localVideoElement;
        newCall.remoteVideoElement = this.remoteVideoElement;
        newCall.remoteAudioElement = this.remoteAudioElement;
        this.successor = newCall;
        this.emit("replaced", newCall);
        this.hangup(CallErrorCode.Replaced, true);
    }

    /**
     * Hangup a call.
     * @param {string} reason The reason why the call is being hung up.
     * @param {boolean} suppressEvent True to suppress emitting an event.
     */
    hangup(reason: CallErrorCode, suppressEvent: boolean) {
        if (this.state === CallState.Ended) return;

        logger.debug("Ending call " + this.callId);
        this.terminate(CallParty.Local, reason, !suppressEvent);
        const content = {
            version: 0,
            call_id: this.callId,
            reason: reason,
        };
        this.sendEvent('m.call.hangup', content);
    }

    /**
     * Set whether the local video preview should be muted or not.
     * @param {boolean} muted True to mute the local video.
     */
    setLocalVideoMuted(muted: boolean) {
        if (!this.localAVStream) {
            return;
        }
        setTracksEnabled(this.localAVStream.getVideoTracks(), !muted);
    }

    /**
     * Check if local video is muted.
     *
     * If there are multiple video tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no video tracks, this will
     * return true.
     * @return {Boolean} True if the local preview video is muted, else false
     * (including if the call is not set up yet).
     */
    isLocalVideoMuted(): boolean {
        if (!this.localAVStream) {
            return false;
        }
        return !isTracksEnabled(this.localAVStream.getVideoTracks());
    }

    /**
     * Set whether the microphone should be muted or not.
     * @param {boolean} muted True to mute the mic.
     */
    setMicrophoneMuted(muted: boolean) {
        if (!this.localAVStream) {
            return;
        }
        setTracksEnabled(this.localAVStream.getAudioTracks(), !muted);
    }

    /**
     * Check if the microphone is muted.
     *
     * If there are multiple audio tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no audio tracks, this will
     * return true.
     * @return {Boolean} True if the mic is muted, else false (including if the call
     * is not set up yet).
     */
    isMicrophoneMuted(): boolean {
        if (!this.localAVStream) {
            return false;
        }
        return !isTracksEnabled(this.localAVStream.getAudioTracks());
    }

    /**
     * Internal
     * @param {Object} stream
     */
    private gotUserMediaForInvite = async (stream: MediaStream) => {
        if (this.successor) {
            this.successor.gotUserMediaForAnswer(stream);
            return;
        }
        if (this.state === CallState.Ended) {
            return;
        }
        logger.debug("gotUserMediaForInvite -> " + this.type);

        const videoEl = this.getLocalVideoElement();

        if (videoEl && this.type === CallType.Video) {
            this.queueMediaOperation(MediaQueueId.LocalVideo, () => {
                videoEl.autoplay = true;
                if (this.screenSharingStream) {
                    logger.debug(
                        "Setting screen sharing stream to the local video element",
                    );
                    videoEl.srcObject = this.screenSharingStream;
                } else {
                    videoEl.srcObject = stream;
                }
                videoEl.muted = true;
                return videoEl.play();
            });
        }

        this.localAVStream = stream;
        // why do we enable audio (and only audio) tracks here? -- matthew
        setTracksEnabled(stream.getAudioTracks(), true);
        this.peerConn = this.createPeerConnection();

        for (const audioTrack of stream.getAudioTracks()) {
            this.peerConn.addTrack(audioTrack, stream);
        }
        for (const videoTrack of (this.screenSharingStream || stream).getVideoTracks()) {
            this.peerConn.addTrack(videoTrack, stream);
        }

        try {
            const myOffer = await this.peerConn.createOffer();
            this.gotLocalOffer(myOffer);
        } catch (e) {
            this.getLocalOfferFailed(e);
            return;
        }
        this.setState(CallState.CreateOffer);
    };

    private sendAnswer() {
        this.sendEvent('m.call.answer', this.answerContent).then(() => {
            this.setState(CallState.Connecting);
            // If this isn't the first time we've tried to send the answer,
            // we may have candidates queued up, so send them now.
            this.sendCandidateQueue();
        }).catch((error) => {
            // We've failed to answer: back to the ringing state
            this.setState(CallState.Ringing);
            this.client.cancelPendingEvent(error.event);

            let code = CallErrorCode.SendAnswer;
            let message = "Failed to send answer";
            if (error.name == 'UnknownDeviceError') {
                code = CallErrorCode.UnknownDevices;
                message = "Unknown devices present in the room";
            }
            this.emit("error", new CallError(code, message, error));
            throw error;
        });
    }

    private gotUserMediaForAnswer = async (stream: MediaStream) => {
        if (this.state === CallState.Ended) {
            return;
        }

        const localVidEl = this.getLocalVideoElement();

        if (localVidEl && this.type === CallType.Video) {
            this.queueMediaOperation(MediaQueueId.LocalVideo, () => {
                localVidEl.autoplay = true;
                localVidEl.srcObject = stream;

                localVidEl.muted = true;
                return localVidEl.play();
            });
        }

        this.localAVStream = stream;
        setTracksEnabled(stream.getAudioTracks(), true);
        for (const track of stream.getTracks()) {
            this.peerConn.addTrack(track, stream);
        }

        this.setState(CallState.CreateAnswer);

        let myAnswer;
        try {
            myAnswer = await this.peerConn.createAnswer();
        } catch (err) {
            logger.debug("Failed to create answer: ", err);
            this.terminate(CallParty.Local, CallErrorCode.CreateAnswer, true);
            return;
        }

        try {
            await this.peerConn.setLocalDescription(myAnswer);

            this.answerContent = {
                version: 0,
                call_id: this.callId,
                answer: {
                    sdp: this.peerConn.localDescription.sdp,
                    // type is now deprecated as of Matrix VoIP v1, but
                    // required to still be sent for backwards compat
                    type: this.peerConn.localDescription.type,
                },
            };
            this.sendAnswer();
        } catch (err) {
            logger.debug("Error setting local description!", err);
            this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
            return;
        }
    };

    /**
     * Internal
     * @param {Object} event
     */
    private gotLocalIceCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
            logger.debug(
                "Got local ICE " + event.candidate.sdpMid + " candidate: " +
                event.candidate.candidate,
            );

            if (this.state == CallState.Ended) return;

            // As with the offer, note we need to make a copy of this object, not
            // pass the original: that broke in Chrome ~m43.
            if (event.candidate.candidate !== '' || !this.sentEndOfCandidates) {
                this.sendCandidate(event.candidate);

                if (event.candidate.candidate === '') this.sentEndOfCandidates = true;
            }
        }
    };

    private onIceGatheringStateChange = (event: Event) => {
        logger.debug("ice gathering state changed to " + this.peerConn.iceGatheringState);
        if (this.peerConn.iceGatheringState === 'complete' && !this.sentEndOfCandidates) {
            // If we didn't get an empty-string candidate to signal the end of candidates,
            // create one ourselves now gathering has finished.
            // We cast because the interface lists all the properties as required but we
            // only want to send 'candidate'
            // XXX: We probably want to send either sdpMid or sdpMLineIndex, as it's not strictly
            // correct to have a candidate that lacks both of these. We'd have to figure out what
            // previous candidates had been sent with and copy them.
            const c = {
                candidate: '',
            } as RTCIceCandidate;
            this.sendCandidate(c);
            this.sentEndOfCandidates = true;
        }
    };

    /**
     * Used by MatrixClient.
     * @param {Object} cand
     */
    gotRemoteIceCandidate(cand: RTCIceCandidate) {
        if (this.state == CallState.Ended) {
            //debuglog("Ignoring remote ICE candidate because call has ended");
            return;
        }
        if (
            (cand.sdpMid === null || cand.sdpMid === undefined) &&
            (cand.sdpMLineIndex === null || cand.sdpMLineIndex === undefined)
        ) {
            logger.debug("Ignoring remote ICE candidate with no sdpMid or sdpMLineIndex");
            return;
        }
        logger.debug("Got remote ICE " + cand.sdpMid + " candidate: " + cand.candidate);
        this.peerConn.addIceCandidate(cand);
    }

    /**
     * Used by MatrixClient.
     * @param {Object} msg
     */
    async receivedAnswer(msg: MatrixEvent) {
        if (this.state === CallState.Ended) {
            return;
        }

        try {
            this.peerConn.setRemoteDescription(msg.answer);
        } catch (e) {
            logger.debug("Failed to set remote description", e);
            this.terminate(CallParty.Local, CallErrorCode.SetRemoteDescription, false);
            return;
        }

        this.setState(CallState.Connecting);
    }

    private gotLocalOffer = async (description: RTCSessionDescriptionInit) => {
        logger.debug("Created offer: ", description);

        if (this.state === CallState.Ended) {
            logger.debug("Ignoring newly created offer on call ID " + this.callId +
                " because the call has ended");
            return;
        }

        try {
            await this.peerConn.setLocalDescription(description);
        } catch (err) {
            logger.debug("Error setting local description!", err);
            this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
            return
        }

        const content = {
            version: 0,
            call_id: this.callId,
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
                sdp: this.peerConn.localDescription.sdp,
                // type now deprecated in Matrix VoIP v1, but
                // required to still be sent for backwards compat
                type: this.peerConn.localDescription.type,
            },
            lifetime: CALL_TIMEOUT_MS,
        };
        try {
            await this.sendEvent('m.call.invite', content);
            this.setState(CallState.InviteSent);
            setTimeout(() => {
                if (this.state === CallState.InviteSent) {
                    this.hangup(CallErrorCode.InviteTimeout, false);
                }
            }, CALL_TIMEOUT_MS);
        } catch (error) {
            let code = CallErrorCode.SendInvite;
            let message = "Failed to send invite";
            if (error.name == 'UnknownDeviceError') {
                code = CallErrorCode.UnknownDevices;
                message = "Unknown devices present in the room";
            }

            this.client.cancelPendingEvent(error.event);
            this.terminate(CallParty.Local, code, false);
            this.emit("error", new CallError(code, message, error));
        }
    };

    private getLocalOfferFailed = (err: Error) => {
        logger.error("Failed to get local offer", err);

        this.terminate(CallParty.Local, CallErrorCode.LocalOfferFailed, false);
        this.emit(
            "error",
            new CallError(
                CallErrorCode.LocalOfferFailed,
                "Failed to get local offer!", err,
            ),
        );
    };

    private getUserMediaFailed = (err: Error) => {
        if (this.successor) {
            this.successor.getUserMediaFailed(err);
            return;
        }

        this.terminate(CallParty.Local, CallErrorCode.NoUserMedia, false);
        this.emit(
            "error",
            new CallError(
                CallErrorCode.NoUserMedia,
                "Couldn't start capturing media! Is your microphone set up and " +
                "does this app have permission?", err,
            ),
        );
    };

    onIceConnectionStateChanged = () => {
        if (this.state === CallState.Ended) {
            return; // because ICE can still complete as we're ending the call
        }
        logger.debug(
            "Ice connection state changed to: " + this.peerConn.iceConnectionState,
        );
        // ideally we'd consider the call to be connected when we get media but
        // chrome doesn't implement any of the 'onstarted' events yet
        if (this.peerConn.iceConnectionState == 'completed' ||
                this.peerConn.iceConnectionState == 'connected') {
            this.setState(CallState.Connected);
        } else if (this.peerConn.iceConnectionState == 'failed') {
            this.hangup(CallErrorCode.IceFailed, false);
        }
    };

    private onSignallingStateChanged = () => {
        logger.debug(
            "call " + this.callId + ": Signalling state changed to: " +
            this.peerConn.signalingState,
        );
    };

    private onTrack = (ev: RTCTrackEvent) => {
        logger.debug(`Track id ${ev.track.id} of kind ${ev.track.kind} added`);

        if (ev.track.kind == 'video') {
            this.type = CallType.Video;
        }

        // This is relatively complex as we may get any number of tracks that may
        // be in any number of streams, or not in streams at all, etc.
        // I'm not entirely sure how this API is supposed to be used: it would
        // be nice to know when the browser is finished telling us about a bunch
        // of tracks so we could go & figure out which ones to use in which streams,
        // but it doesn't. There was an 'addstream' event, but that is now deprecated.

        // The base case is that there will be one stream with one audio track, or in
        // the case of a video call, and audio and video track.

        // This algorithm is not perfect and will fail in edge cases such as a streamless
        // track being added first, followed by a normal audio + video stream.

        const haveStream = this.remoteStream !== undefined;
        if (!haveStream) {
            // If we don't currently have a stream, use one this track is already in
            if (ev.streams.length > 0) {
                this.remoteStream = ev.streams[0];
            } else {
                // ...unless it's a streamless track, in which case we'll need to make
                // our own stream.
                this.remoteStream = new MediaStream();
            }
        }

        // if this track isn't in a stream, add it to the one we have.
        // This basically assumes all the tracks are streamless, otherwise it
        // will end up adding the track to a stream provided by the RTCPeerConnection,
        // which would be weird.
        if (ev.streams.length === 0) this.remoteStream.addTrack(ev.track);

        // If we've just gained our stream, wire it up to the media object
        if (!haveStream) {
            if (this.remoteVideoElement) {
                this.queueMediaOperation(MediaQueueId.RemoteVideo, async () => {
                    this.remoteVideoElement.srcObject = this.remoteStream;
                    try {
                        await this.remoteVideoElement.play();
                    } catch (e) {
                        logger.error("Failed to play remote video element", e);
                    }
                });
            }

            if (this.remoteAudioElement) {
                this.playRemoteAudio();
            }
        }
    };

    playRemoteAudio() {
        this.queueMediaOperation(MediaQueueId.RemoteAudio, async () => {
            this.remoteAudioElement.srcObject = this.remoteStream;

            // if audioOutput is non-default:
            try {
                if (audioOutput) {
                    // This seems quite unreliable in Chrome, although I haven't yet managed to make a jsfiddle where
                    // it fails.
                    // It seems reliable if you set the sink ID after setting the srcObject and then set the sink ID
                    // back to the default after the call is over
                    logger.info("Setting audio sink to " + audioOutput + ", was " + this.remoteAudioElement.sinkId);
                    await this.remoteAudioElement.setSinkId(audioOutput);
                }
            } catch (e) {
                logger.warn("Couldn't set requested audio output device: using default", e);
            }

            try {
                await this.remoteAudioElement.play();
            } catch (e) {
                logger.error("Failed to play remote video element", e);
            }
        });
    }

    onHangupReceived = (msg) => {
        logger.debug("Hangup received");
        this.terminate(CallParty.Remote, msg.reason, true);
    };

    onAnsweredElsewhere = (msg) => {
        logger.debug("Answered elsewhere");
        this.terminate(CallParty.Remote, CallErrorCode.AnsweredElsewhere, true);
    };

    setState(state: CallState) {
        const oldState = this.state;
        this.state = state;
        this.emit("state", state, oldState);
    }

    /**
     * Internal
     * @param {string} eventType
     * @param {Object} content
     * @return {Promise}
     */
    private sendEvent(eventType: string, content: object) {
        return this.client.sendEvent(this.roomId, eventType, content);
    }

    sendCandidate(content: RTCIceCandidate) {
        // Sends candidates with are sent in a special way because we try to amalgamate
        // them into one message
        this.candidateSendQueue.push(content);

        // Don't send the ICE candidates yet if the call is in the ringing state: this
        // means we tried to pick (ie. started generating candidates) and then failed to
        // send the answer and went back to the ringing state. Queue up the candidates
        // to send if we sucessfully send the answer.
        if (this.state === CallState.Ringing) return;

        if (this.candidateSendTries === 0) {
            setTimeout(() => {
                this.sendCandidateQueue();
            }, 100);
        }
    }

    private terminate(hangupParty: CallParty, hangupReason: CallErrorCode, shouldEmit: boolean) {
        if (this.state === CallState.Ended) return;

        const remoteVid = this.getRemoteVideoElement();
        const remoteAud = this.getRemoteAudioElement();
        const localVid = this.getLocalVideoElement();

        if (remoteVid) {
            this.queueMediaOperation(MediaQueueId.RemoteVideo, () => {
                remoteVid.pause();
                remoteVid.srcObject = null;
            });
        }
        if (remoteAud) {
            this.queueMediaOperation(MediaQueueId.RemoteAudio, async () => {
                remoteAud.pause();
                remoteAud.srcObject = null;
                try {
                    // As per comment in playRemoteAudio, setting the sink ID back to the default
                    // once the call is over makes setSinkId work reliably.
                    await this.remoteAudioElement.setSinkId('')
                } catch (e) {
                    logger.warn("Failed to set sink ID back to default");
                }
            });
        }
        if (localVid) {
            this.queueMediaOperation(MediaQueueId.LocalVideo, () => {
                localVid.pause();
                localVid.srcObject = null;
            });
        }
        this.hangupParty = hangupParty;
        this.hangupReason = hangupReason;
        this.setState(CallState.Ended);
        this.stopAllMedia();
        if (this.peerConn && this.peerConn.signalingState !== 'closed') {
            this.peerConn.close();
        }
        if (shouldEmit) {
            this.emit("hangup", self);
        }
    }

    private stopAllMedia() {
        logger.debug(`stopAllMedia (stream=${this.localAVStream})`);
        if (this.localAVStream) {
            for (const track of this.localAVStream.getTracks()) {
                track.stop();
            }
        }
        if (this.screenSharingStream) {
            for (const track of this.screenSharingStream.getTracks()) {
                track.stop();
            }
        }

        for (const track of this.remoteStream.getTracks()) {
            track.stop();
        }
    }

    private checkForErrorListener() {
        if (this.listeners("error").length === 0) {
            throw new Error(
                "You MUST attach an error listener using call.on('error', function() {})",
            );
        }
    }

    private sendCandidateQueue() {
        if (this.candidateSendQueue.length === 0) {
            return;
        }

        const cands = this.candidateSendQueue;
        this.candidateSendQueue = [];
        ++this.candidateSendTries;
        const content = {
            version: 0,
            call_id: this.callId,
            candidates: cands,
        };
        logger.debug("Attempting to send " + cands.length + " candidates");
        this.sendEvent('m.call.candidates', content).then(() => {
            this.candidateSendTries = 0;
            this.sendCandidateQueue();
        }, (error) => {
            for (let i = 0; i < cands.length; i++) {
                this.candidateSendQueue.push(cands[i]);
            }

            if (this.candidateSendTries > 5) {
                logger.debug(
                    "Failed to send candidates on attempt " + this.candidateSendTries +
                    ". Giving up for now.",
                );
                this.candidateSendTries = 0;
                return;
            }

            const delayMs = 500 * Math.pow(2, this.candidateSendTries);
            ++this.candidateSendTries;
            logger.debug("Failed to send candidates. Retrying in " + delayMs + "ms");
            setTimeout(() => {
                this.sendCandidateQueue();
            }, delayMs);
        });
    }

    private async placeCallWithConstraints(constraints: MediaStreamConstraints) {
        logger.log("Getting user media with constraints", constraints);
        this.client.callList[this.callId] = this;
        this.setState(CallState.WaitLocalMedia);
        this.direction = CallDirection.Outbound;
        this.config = constraints;
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.gotUserMediaForInvite(mediaStream);
        } catch (e) {
            this.getUserMediaFailed(e);
            return;
        }
    }

    private createPeerConnection(): RTCPeerConnection {
        const pc = new RTCPeerConnection({
            iceTransportPolicy: this.forceTURN ? 'relay' : undefined,
            iceServers: this.turnServers,
        });

        pc.addEventListener('iceconnectionstatechange', this.onIceConnectionStateChanged);
        pc.addEventListener('signalingstatechange', this.onSignallingStateChanged);
        pc.addEventListener('icecandidate', this.gotLocalIceCandidate);
        pc.addEventListener('icegatheringstatechange', this.onIceGatheringStateChange);
        pc.addEventListener('track', this.onTrack);

        return pc;
    }
}

function setTracksEnabled(tracks: Array<MediaStreamTrack>, enabled: boolean) {
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = enabled;
    }
}

function isTracksEnabled(tracks: Array<MediaStreamTrack>) {
    for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].enabled) {
            return true; // at least one track is enabled
        }
    }
    return false;
}

function getUserMediaVideoContraints(callType: CallType) {
    const isWebkit = !!window.navigator.webkitGetUserMedia;

    switch (callType) {
        case CallType.Voice:
            return {
                audio: {
                    deviceId: audioInput ? {ideal: audioInput} : undefined,
                }, video: false,
            };
        case CallType.Video:
            return {
                audio: {
                    deviceId: audioInput ? {ideal: audioInput} : undefined,
                }, video: {
                    deviceId: videoInput ? {ideal: videoInput} : undefined,
                    /* We want 640x360.  Chrome will give it only if we ask exactly,
                       FF refuses entirely if we ask exactly, so have to ask for ideal
                       instead
                       XXX: Is this still true?
                     */
                    width: isWebkit ? { exact: 640 } : { ideal: 640 },
                    height: isWebkit ? { exact: 360 } : { ideal: 360 },
                },
            };
    }
}

let audioOutput: string;
let audioInput: string;
let videoInput: string;
/**
 * Set an audio output device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioOutput(deviceId: string) { audioOutput = deviceId; }
/**
 * Set an audio input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioInput(deviceId: string) { audioInput = deviceId; }
/**
 * Set a video input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setVideoInput(deviceId: string) { videoInput = deviceId; }

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
export function createNewMatrixCall(client: any, roomId: string, options?: CallOpts) {
    // typeof prevents Node from erroring on an undefined reference
    if (typeof(window) === 'undefined' || typeof(document) === 'undefined') {
        logger.error("No window or document object: WebRTC is not supported in this environement");
        return null;
    }

    // Firefox throws on so little as accessing the RTCPeerConnection when operating in
    // a secure mode. There's some information at https://bugzilla.mozilla.org/show_bug.cgi?id=1542616
    // though the concern is that the browser throwing a SecurityError will brick the
    // client creation process.
    try {
        const supported = Boolean(
            window.RTCPeerConnection || window.RTCSessionDescription ||
            window.RTCIceCandidate || navigator.getUserMedia,
        );
        if (!supported) {
            logger.error("WebRTC is not supported in this browser / environment");
            return null;
        }
    } catch (e) {
        logger.error("Exception thrown when trying to access WebRTC", e);
        return null;
    }

    const optionsForceTURN = options ? options.forceTURN : false;

    const opts = {
        client: client,
        roomId: roomId,
        turnServers: client.getTurnServers(),
        // call level options
        forceTURN: client._forceTURN || optionsForceTURN,
    };
    return new MatrixCall(opts);
}
