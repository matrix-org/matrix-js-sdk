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
    FLEDGLING = "fledgling",
    INVITE_SENT = "invite_sent",
    WAIT_LOCAL_MEDIA = "wait_local_media",
    CREATE_OFFER = "create_offer",
    CREATE_ANSWER = "create_answer",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    RINGING = "ringing",
    ENDED = "ended",
}

enum CallType {
    VOICE = 'voice',
    VIDEO = 'video',
}

enum CallDirection {
    INBOUND,
    OUTBOUND,
}

enum CallParty {
    LOCAL = 'local',
    REMOTE = 'remote',
}

enum CallErrorCode {
    /** An error code when the local client failed to create an offer. */
    ERR_LOCAL_OFFER_FAILED = "local_offer_failed",
    /**
     * An error code when there is no local mic/camera to use. This may be because
     * the hardware isn't plugged in, or the user has explicitly denied access.
     */
    ERR_NO_USER_MEDIA = "no_user_media",

    /*
    * Error code used when a call event failed to send
    * because unknown devices were present in the room
    */
    ERR_UNKNOWN_DEVICES = "unknown_devices",

    /*
    * Error code usewd when we fail to send the invite
    * for some reason other than there being unknown devices
    */
    ERR_SEND_INVITE = "send_invite",

    /*
    * Error code usewd when we fail to send the answer
    * for some reason other than there being unknown devices
    */
    ERR_SEND_ANSWER = "send_answer",
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

    private client: any; // Fix when client is TSified
    private direction: CallDirection;
    private forceTURN: boolean;
    private turnServers: Array<TurnServer>;
    private didConnect: boolean;
    private candidateSendQueue: Array<RTCIceCandidate>;
    private candidateSendTries: number;
    private mediaPromises: { [queueId: string]: Promise<void>; };
    private sentEndOfCandidates: boolean;
    private peerConn: RTCPeerConnection;
    private localVideoElement: HTMLVideoElement;
    private remoteVideoElement: HTMLVideoElement;
    private remoteAudioElement: HTMLAudioElement;
    private screenSharingStream: MediaStream;
    private localAVStream: MediaStream;
    private remoteAVStream: MediaStream;
    private remoteAStream: MediaStream;
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
        this.state = CallState.FLEDGLING;
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

        this.sentEndOfCandidates = false;
    }

    /**
     * Place a voice call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    placeVoiceCall() {
        logger.debug("placeVoiceCall");
        this.checkForErrorListener();
        this.placeCallWithConstraints(getUserMediaVideoContraints(CallType.VOICE));
        this.type = CallType.VOICE;
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
        this.placeCallWithConstraints(getUserMediaVideoContraints(CallType.VIDEO));
        this.type = CallType.VIDEO;
        this.tryPlayRemoteStream();
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
            const audioConstraints = getUserMediaVideoContraints(CallType.VOICE);
            this.placeCallWithConstraints(audioConstraints);
        } catch (err) {
            this.emit("error",
                new CallError(
                    CallErrorCode.ERR_NO_USER_MEDIA,
                    "Failed to get screen-sharing stream: ", err,
                ),
            );
        }

        this.type = CallType.VIDEO;
        this.tryPlayRemoteStream();
    }

    /**
     * Play the given HTMLMediaElement, serialising the operation into a chain
     * of promises to avoid racing access to the element
     * @param {Element} element HTMLMediaElement element to play
     * @param {string} queueId Arbitrary ID to track the chain of promises to be used
     */
    playElement(element: HTMLMediaElement, queueId: string) {
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
    }

    /**
     * Pause the given HTMLMediaElement, serialising the operation into a chain
     * of promises to avoid racing access to the element
     * @param {Element} element HTMLMediaElement element to pause
     * @param {string} queueId Arbitrary ID to track the chain of promises to be used
     */
    pauseElement(element: HTMLMediaElement, queueId: string) {
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
            // pause doesn't return a promise, so just run it
            element.pause();
        }
    }

    /**
     * Assign the given HTMLMediaElement by setting the .src attribute on it,
     * serialising the operation into a chain of promises to avoid racing access
     * to the element
     * @param {Element} element HTMLMediaElement element to pause
     * @param {MediaStream} srcObject the srcObject attribute value to assign to the element
     * @param {string} queueId Arbitrary ID to track the chain of promises to be used
     */
    assignElement(element: HTMLMediaElement, srcObject: MediaStream, queueId: string) {
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

        if (element && this.localAVStream && this.type === CallType.VIDEO) {
            element.autoplay = true;
            this.assignElement(element, this.localAVStream, "localVideo");
            element.muted = true;
            setTimeout(() => {
                const vel = this.getLocalVideoElement();
                if (vel.play) {
                    this.playElement(vel, "localVideo");
                }
            }, 0);
        }
    }

    /**
     * Set the remote <code>&lt;video&gt;</code> DOM element. If this call is active,
     * the first received video-capable stream will be rendered to it immediately.
     * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
     */
    setRemoteVideoElement(element : HTMLVideoElement) {
        this.remoteVideoElement = element;
        this.tryPlayRemoteStream();
    }

    /**
     * Set the remote <code>&lt;audio&gt;</code> DOM element. If this call is active,
     * the first received audio-only stream will be rendered to it immediately.
     * The audio will *not* be rendered from the remoteVideoElement.
     * @param {Element} element The <code>&lt;video&gt;</code> DOM element.
     */
    setRemoteAudioElement(element : HTMLAudioElement) {
        this.remoteVideoElement.muted = true;
        this.remoteAudioElement = element;
        this.remoteAudioElement.muted = false;
        this.tryPlayRemoteAudioStream();
    }

    /**
     * Configure this call from an invite event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.invite event
     */
    initWithInvite(event : any) {
        this.msg = event.getContent();
        this.peerConn = this.createPeerConnection();
        if (this.peerConn) {
            this.peerConn.setRemoteDescription(
                this.msg.offer,
                this.onSetRemoteDescriptionSuccess,
                this.onSetRemoteDescriptionError,
            );
        }
        this.setState(CallState.RINGING);
        this.direction = CallDirection.INBOUND;

        // firefox and OpenWebRTC's RTCPeerConnection doesn't add streams until it
        // starts getting media on them so we need to figure out whether a video
        // channel has been offered by ourselves.
        // XXX: This comment is probably outdated: check & remove this if so
        if (
            this.msg.offer &&
            this.msg.offer.sdp &&
            this.msg.offer.sdp.indexOf('m=video') > -1
        ) {
            this.type = CallType.VOICE;
        } else {
            this.type = CallType.VIDEO;
        }

        if (event.getAge()) {
            setTimeout(() => {
                if (this.state == CallState.RINGING) {
                    logger.debug("Call invite has expired. Hanging up.");
                    this.hangupParty = CallParty.REMOTE; // effectively
                    this.setState(CallState.ENDED);
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
    initWithHangup(event : any) {
        // perverse as it may seem, sometimes we want to instantiate a call with a
        // hangup message (because when getting the state of the room on load, events
        // come in reverse order and we want to remember that a call has been hung up)
        this.msg = event.getContent();
        this.setState(CallState.ENDED);
    }

    /**
     * Answer a call.
     */
    answer() {
        logger.debug(`Answering call ${this.callId} of type ${this.type}`);

        if (this.answerContent) {
            this.sendAnswer();
            return;
        }

        if (!this.localAVStream && !this.waitForLocalAVStream) {
            const constraints = getUserMediaVideoContraints(this.type);
            logger.log("Getting user media with constraints", constraints);
            navigator.getUserMedia(
                constraints,
                this.maybeGotUserMediaForAnswer,
                this.maybeGotUserMediaForAnswer,
            );
            this.setState(CallState.WAIT_LOCAL_MEDIA);
        } else if (this.localAVStream) {
            this.maybeGotUserMediaForAnswer(this.localAVStream);
        } else if (this.waitForLocalAVStream) {
            this.setState(CallState.WAIT_LOCAL_MEDIA);
        }
    }

    /**
     * Replace this call with a new call, e.g. for glare resolution. Used by
     * MatrixClient.
     * @param {MatrixCall} newCall The new call.
     */
    replacedBy(newCall: MatrixCall) {
        logger.debug(this.callId + " being replaced by " + newCall.callId);
        if (this.state === CallState.WAIT_LOCAL_MEDIA) {
            logger.debug("Telling new call to wait for local media");
            newCall.waitForLocalAVStream = true;
        } else if (this.state === CallState.CREATE_OFFER) {
            logger.debugl("Handing local stream to new call");
            newCall.maybeGotUserMediaForAnswer(this.localAVStream);
            delete(this.localAVStream);
        } else if (this.state === CallState.INVITE_SENT) {
            logger.debug("Handing local stream to new call");
            newCall.maybeGotUserMediaForAnswer(this.localAVStream);
            delete(this.localAVStream);
        }
        newCall.localVideoElement = this.localVideoElement;
        newCall.remoteVideoElement = this.remoteVideoElement;
        newCall.remoteAudioElement = this.remoteAudioElement;
        this.successor = newCall;
        this.emit("replaced", newCall);
        this.hangup("replaced", true);
    }

    /**
     * Hangup a call.
     * @param {string} reason The reason why the call is being hung up.
     * @param {boolean} suppressEvent True to suppress emitting an event.
     */
    hangup(reason: string, suppressEvent: boolean) {
        if (this.state === CallState.ENDED) return;

        logger.debug("Ending call " + this.callId);
        this.terminate("local", reason, !suppressEvent);
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
    private maybeGotUserMediaForInvite = (streamOrError: any) => {
        if (this.successor) {
            this.successor.maybeGotUserMediaForAnswer(streamOrError);
            return;
        }
        if (this.state === CallState.ENDED) {
            return;
        }
        logger.debug("maybeGotUserMediaForInvite -> " + this.type);

        // XXX: switch away from callbacks API
        const error = streamOrError;
        const constraints = {
            'mandatory': {
                'OfferToReceiveAudio': true,
                'OfferToReceiveVideo': this.type === CallType.VIDEO,
            },
        };
        if (streamOrError instanceof MediaStream) {
            const videoEl = this.getLocalVideoElement();

            if (videoEl && this.type === CallType.VIDEO) {
                videoEl.autoplay = true;
                if (this.screenSharingStream) {
                    logger.debug(
                        "Setting screen sharing stream to the local video element",
                    );
                    this.assignElement(videoEl, this.screenSharingStream, "localVideo");
                } else {
                    this.assignElement(videoEl, streamOrError, "localVideo");
                }
                videoEl.muted = true;
                setTimeout(() => {
                    const vel = this.getLocalVideoElement();
                    if (vel.play) {
                        this.playElement(vel, "localVideo");
                    }
                }, 0);
            }

            if (this.screenSharingStream) {
                this.screenSharingStream.addTrack(streamOrError.getAudioTracks()[0]);
                streamOrError = this.screenSharingStream;
            }

            this.localAVStream = streamOrError;
            // why do we enable audio (and only audio) tracks here? -- matthew
            setTracksEnabled(streamOrError.getAudioTracks(), true);
            this.peerConn = this.createPeerConnection();
            this.peerConn.addStream(streamOrError);
        } else if (error.name === 'PermissionDeniedError') {
            logger.debug('User denied access to camera/microphone.' +
                ' Or possibly you are using an insecure domain. Receiving only.');
            this.peerConn = this.createPeerConnection();
        } else {
            logger.debug('Failed to getUserMedia: ' + error.name);
            this.getUserMediaFailed(error);
            return;
        }

        this.peerConn.createOffer(
            this.gotLocalOffer,
            this.getLocalOfferFailed,
            constraints,
        );
        this.setState(CallState.CREATE_OFFER);
    };

    private sendAnswer() {
        this.sendEvent('m.call.answer', this.answerContent).then(() => {
            this.setState(CallState.CONNECTING);
            // If this isn't the first time we've tried to send the answer,
            // we may have candidates queued up, so send them now.
            this.sendCandidateQueue();
        }).catch((error) => {
            // We've failed to answer: back to the ringing state
            this.setState(CallState.RINGING);
            this.client.cancelPendingEvent(error.event);

            let code = CallErrorCode.ERR_SEND_ANSWER;
            let message = "Failed to send answer";
            if (error.name == 'UnknownDeviceError') {
                code = CallErrorCode.ERR_UNKNOWN_DEVICES;
                message = "Unknown devices present in the room";
            }
            this.emit("error", new CallError(code, message, error));
            throw error;
        });
    }

    /**
     * Internal
     * @param {Object} stream
     */
    private maybeGotUserMediaForAnswer = (streamOrError: any) => {
        if (this.state === CallState.ENDED) {
            return;
        }

        // XXX: we use the same function as the success and error callback: we should
        // this was an untraditional choice to start with but now the callbacks API
        // is deprecated anyway and we should just use promises.
        const error = streamOrError;
        if (streamOrError instanceof MediaStream) {
            const localVidEl = this.getLocalVideoElement();

            if (localVidEl && this.type === CallType.VIDEO) {
                localVidEl.autoplay = true;
                this.assignElement(localVidEl, streamOrError, "localVideo");
                localVidEl.muted = true;
                setTimeout(() => {
                    const vel = this.getLocalVideoElement();
                    if (vel.play) {
                        this.playElement(vel, "localVideo");
                    }
                }, 0);
            }

            this.localAVStream = streamOrError;
            setTracksEnabled(streamOrError.getAudioTracks(), true);
            this.peerConn.addStream(streamOrError);
        } else if (error.name === 'PermissionDeniedError') {
            logger.debug('User denied access to camera/microphone.' +
                ' Or possibly you are using an insecure domain. Receiving only.');
        } else {
            logger.debug('Failed to getUserMedia: ' + error.name);
            this.getUserMediaFailed(error);
            return;
        }

        const constraints = {
            'mandatory': {
                'OfferToReceiveAudio': true,
                'OfferToReceiveVideo': this.type === CallType.VIDEO,
            },
        };
        this.peerConn.createAnswer((description) => {
            logger.debug("Created answer: ", description);
            this.peerConn.setLocalDescription(description, () => {
                this.answerContent = {
                    version: 0,
                    call_id: this.callId,
                    answer: {
                        sdp: this.peerConn.localDescription.sdp,
                        type: this.peerConn.localDescription.type,
                    },
                };
                this.sendAnswer();
            }, function() {
                logger.debug("Error setting local description!");
            });
        }, function(err) {
            logger.debug("Failed to create answer: " + err);
        }, constraints);
        this.setState(CallState.CREATE_ANSWER);
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

            if (this.state == CallState.ENDED) return;

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
        if (this.state == CallState.ENDED) {
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
    receivedAnswer(msg: any) {
        if (this.state === CallState.ENDED) {
            return;
        }

        this.peerConn.setRemoteDescription(msg.answer,
            this.onSetRemoteDescriptionSuccess,
            this.onSetRemoteDescriptionError,
        );
        this.setState(CallState.CONNECTING);
    }

    private gotLocalOffer = (description: RTCSessionDescription) => {
        logger.debug("Created offer: ", description);

        if (this.state === CallState.ENDED) {
            logger.debug("Ignoring newly created offer on call ID " + this.callId +
                " because the call has ended");
            return;
        }

        this.peerConn.setLocalDescription(description, () => {
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
                    type: this.peerConn.localDescription.type,
                },
                lifetime: CALL_TIMEOUT_MS,
            };
            this.sendEvent('m.call.invite', content).then(() => {
                this.setState(CallState.INVITE_SENT);
                setTimeout(() => {
                    if (this.state === CallState.INVITE_SENT) {
                        this.hangup('invite_timeout', false);
                    }
                }, CALL_TIMEOUT_MS);
            }).catch((error) => {
                let code = CallErrorCode.ERR_SEND_INVITE;
                let message = "Failed to send invite";
                if (error.name == 'UnknownDeviceError') {
                    code = CallErrorCode.ERR_UNKNOWN_DEVICES;
                    message = "Unknown devices present in the room";
                }

                this.client.cancelPendingEvent(error.event);
                this.terminate("local", code, false);
                this.emit("error", new CallError(code, message, error));
                throw error;
            });
        }, function() {
            logger.debug("Error setting local description!");
        });
    };

    private getLocalOfferFailed = (err: Error) => {
        this.emit(
            "error",
            new CallError(
                CallErrorCode.ERR_LOCAL_OFFER_FAILED,
                "Failed to start audio for call!", err,
            ),
        );
    };

    private getUserMediaFailed = (err: Error) => {
        this.terminate("local", 'user_media_failed', false);
        this.emit(
            "error",
            new CallError(
                CallErrorCode.ERR_NO_USER_MEDIA,
                "Couldn't start capturing media! Is your microphone set up and " +
                "does this app have permission?", err,
            ),
        );
    };

    onIceConnectionStateChanged = () => {
        if (this.state === CallState.ENDED) {
            return; // because ICE can still complete as we're ending the call
        }
        logger.debug(
            "Ice connection state changed to: " + this.peerConn.iceConnectionState,
        );
        // ideally we'd consider the call to be connected when we get media but
        // chrome doesn't implement any of the 'onstarted' events yet
        if (this.peerConn.iceConnectionState == 'completed' ||
                this.peerConn.iceConnectionState == 'connected') {
            this.setState(CallState.CONNECTED);
            this.didConnect = true;
        } else if (this.peerConn.iceConnectionState == 'failed') {
            this.hangup('ice_failed', false);
        }
    };

    private onSignallingStateChanged = () => {
        logger.debug(
            "call " + this.callId + ": Signalling state changed to: " +
            this.peerConn.signalingState,
        );
    };

    private onSetRemoteDescriptionSuccess = () => {
        logger.debug("Set remote description");
    };

    onSetRemoteDescriptionError = (e: Error) => {
        logger.debug("Failed to set remote description", e);
    };

    private onAddStream = (event: MediaStreamEvent) => {
        logger.debug("Stream id " + event.stream.id + " added");

        const s = event.stream;

        if (s.getVideoTracks().length > 0) {
            this.type = CallType.VIDEO;
            this.remoteAVStream = s;
            this.remoteAStream = s;
        } else {
            this.type = CallType.VOICE;
            this.remoteAStream = s;
        }

        forAllTracksOnStream(s, (t) => {
            logger.debug("Track id " + t.id + " added");
            // not currently implemented in chrome
            t.onstarted = this.onRemoteStreamTrackStarted;
        });

        if (event.stream.oninactive !== undefined) {
            event.stream.oninactive = this.onRemoteStreamEnded;
        } else {
            // onended is deprecated from Chrome 54
            event.stream.onended = this.onRemoteStreamEnded;
        }

        // not currently implemented in chrome
        event.stream.onstarted = this.onRemoteStreamStarted;

        if (this.type === CallType.VIDEO) {
            this.tryPlayRemoteStream();
            this.tryPlayRemoteAudioStream();
        } else {
            this.tryPlayRemoteAudioStream();
        }
    };

    private onRemoteStreamStarted = (event: Event) => {
        this.setState(CallState.CONNECTED);
    };

    /**
     * Internal
     * @private
     * @param {Object} event
     */
    private onRemoteStreamEnded = (event: Event) => {
        logger.debug("Remote stream ended");
        this.hangupParty = CallParty.REMOTE;
        this.setState(CallState.ENDED);
        this.stopAllMedia();
        if (this.peerConn.signalingState != 'closed') {
            this.peerConn.close();
        }
        this.emit("hangup", this);
    };

    private onRemoteStreamTrackStarted = (event: Event) => {
        this.setState(CallState.CONNECTED);
    };

    onHangupReceived = (msg) => {
        logger.debug("Hangup received");
        this.terminate("remote", msg.reason, true);
    };

    onAnsweredElsewhere = (msg) => {
        logger.debug("Answered elsewhere");
        this.terminate("remote", "answered_elsewhere", true);
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
    sendEvent(eventType: string, content: object) {
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
        if (this.state == CallState.RINGING) return;

        if (this.candidateSendTries === 0) {
            setTimeout(() => {
                this.sendCandidateQueue();
            }, 100);
        }
    }

    private terminate(hangupParty, hangupReason, shouldEmit: boolean) {
        if (this.getRemoteVideoElement()) {
            if (this.getRemoteVideoElement().pause) {
                this.pauseElement(this.getRemoteVideoElement(), "remoteVideo");
            }
            this.assignElement(this.getRemoteVideoElement(), null, "remoteVideo");
        }
        if (this.getRemoteAudioElement()) {
            if (this.getRemoteAudioElement().pause) {
                this.pauseElement(this.getRemoteAudioElement(), "remoteAudio");
            }
            this.assignElement(this.getRemoteAudioElement(), null, "remoteAudio");
        }
        if (this.getLocalVideoElement()) {
            if (this.getLocalVideoElement().pause) {
                this.pauseElement(this.getLocalVideoElement(), "localVideo");
            }
            this.assignElement(this.getLocalVideoElement(), null, "localVideo");
        }
        this.hangupParty = hangupParty;
        this.hangupReason = hangupReason;
        this.setState(CallState.ENDED);
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
            forAllTracksOnStream(this.localAVStream, function(t) {
                if (t.stop) {
                    t.stop();
                }
            });
            // also call stop on the main stream so firefox will stop sharing
            // the mic
            if (this.localAVStream.stop) {
                this.localAVStream.stop();
            }
        }
        if (this.screenSharingStream) {
            forAllTracksOnStream(this.screenSharingStream, function(t) {
                if (t.stop) {
                    t.stop();
                }
            });
            if (this.screenSharingStream.stop) {
                this.screenSharingStream.stop();
            }
        }
        if (this.remoteAVStream) {
            forAllTracksOnStream(this.remoteAVStream, function(t) {
                if (t.stop) {
                    t.stop();
                }
            });
        }
        if (this.remoteAStream) {
            forAllTracksOnStream(this.remoteAStream, function(t) {
                if (t.stop) {
                    t.stop();
                }
            });
        }
    }

    private tryPlayRemoteStream() {
        if (this.getRemoteVideoElement() && this.remoteAVStream) {
            const player = this.getRemoteVideoElement();
            player.autoplay = true;
            this.assignElement(player, this.remoteAVStream, "remoteVideo");
            setTimeout(() => {
                const vel = this.getRemoteVideoElement();
                if (vel.play) {
                    this.playElement(vel, "remoteVideo");
                }
            }, 0);
        }
    }

    private async tryPlayRemoteAudioStream() {
        if (this.getRemoteAudioElement() && this.remoteAStream) {
            const player = this.getRemoteAudioElement();

            // if audioOutput is non-default:
            try {
                if (audioOutput) await player.setSinkId(audioOutput);
            } catch (e) {
                logger.warn("Couldn't set requested audio output device: using default", e);
            }

            player.autoplay = true;
            this.assignElement(player, this.remoteAStream, "remoteAudio");
            setTimeout(() => {
                const ael = this.getRemoteAudioElement();
                if (ael.play) {
                    this.playElement(ael, "remoteAudio");
                }
            }, 0);
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

    private placeCallWithConstraints(constraints: MediaStreamConstraints) {
        logger.log("Getting user media with constraints", constraints);
        this.client.callList[this.callId] = this;
        navigator.getUserMedia(
            constraints,
            this.maybeGotUserMediaForInvite,
            this.maybeGotUserMediaForInvite,
        );
        this.setState(CallState.WAIT_LOCAL_MEDIA);
        this.direction = CallDirection.OUTBOUND;
        this.config = constraints;
    }

    private createPeerConnection(): RTCPeerConnection {
        const pc = new RTCPeerConnection({
            iceTransportPolicy: this.forceTURN ? 'relay' : undefined,
            iceServers: this.turnServers,
        });
        pc.oniceconnectionstatechange = this.onIceConnectionStateChanged;
        pc.onsignalingstatechange = this.onSignallingStateChanged;
        pc.onicecandidate = this.gotLocalIceCandidate;
        pc.onicegatheringstatechange = this.onIceGatheringStateChange;
        pc.onaddstream = this.onAddStream;
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
        case CallType.VOICE:
            return {
                audio: {
                    deviceId: audioInput ? {ideal: audioInput} : undefined,
                }, video: false,
            };
        case CallType.VIDEO:
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

function forAllVideoTracksOnStream(s: MediaStream, f: (t: MediaStreamTrack) => void) {
    const tracks = s.getVideoTracks();
    for (let i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
}

function forAllAudioTracksOnStream(s: MediaStream, f: (t: MediaStreamTrack) => void) {
    const tracks = s.getAudioTracks();
    for (let i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
}

function forAllTracksOnStream(s: MediaStream, f: (t: MediaStreamTrack) => void) {
    forAllVideoTracksOnStream(s, f);
    forAllAudioTracksOnStream(s, f);
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
export function createNewMatrixCall(client: any, roomId: string, options: CallOpts) {
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
