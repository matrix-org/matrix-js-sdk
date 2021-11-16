/// <reference types="node" />
import { EventEmitter } from 'events';
import { MatrixEvent } from '../models/event';
import { RoomMember } from '../models/room-member';
import { MCallAnswer, MCallHangupReject } from './callEventTypes';
import { CallFeed } from './callFeed';
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
    roomId?: string;
    client?: any;
    forceTURN?: boolean;
    turnServers?: Array<TurnServer>;
}
interface TurnServer {
    urls: Array<string>;
    username?: string;
    password?: string;
    ttl?: number;
}
interface AssertedIdentity {
    id: string;
    displayName: string;
}
export declare enum CallState {
    Fledgling = "fledgling",
    InviteSent = "invite_sent",
    WaitLocalMedia = "wait_local_media",
    CreateOffer = "create_offer",
    CreateAnswer = "create_answer",
    Connecting = "connecting",
    Connected = "connected",
    Ringing = "ringing",
    Ended = "ended"
}
export declare enum CallType {
    Voice = "voice",
    Video = "video"
}
export declare enum CallDirection {
    Inbound = "inbound",
    Outbound = "outbound"
}
export declare enum CallParty {
    Local = "local",
    Remote = "remote"
}
export declare enum CallEvent {
    Hangup = "hangup",
    State = "state",
    Error = "error",
    Replaced = "replaced",
    LocalHoldUnhold = "local_hold_unhold",
    RemoteHoldUnhold = "remote_hold_unhold",
    HoldUnhold = "hold_unhold",
    FeedsChanged = "feeds_changed",
    AssertedIdentityChanged = "asserted_identity_changed",
    LengthChanged = "length_changed",
    DataChannel = "datachannel"
}
export declare enum CallErrorCode {
    /** The user chose to end the call */
    UserHangup = "user_hangup",
    /** An error code when the local client failed to create an offer. */
    LocalOfferFailed = "local_offer_failed",
    /**
     * An error code when there is no local mic/camera to use. This may be because
     * the hardware isn't plugged in, or the user has explicitly denied access.
     */
    NoUserMedia = "no_user_media",
    /**
     * Error code used when a call event failed to send
     * because unknown devices were present in the room
     */
    UnknownDevices = "unknown_devices",
    /**
     * Error code used when we fail to send the invite
     * for some reason other than there being unknown devices
     */
    SendInvite = "send_invite",
    /**
     * An answer could not be created
     */
    CreateAnswer = "create_answer",
    /**
     * Error code used when we fail to send the answer
     * for some reason other than there being unknown devices
     */
    SendAnswer = "send_answer",
    /**
     * The session description from the other side could not be set
     */
    SetRemoteDescription = "set_remote_description",
    /**
     * The session description from this side could not be set
     */
    SetLocalDescription = "set_local_description",
    /**
     * A different device answered the call
     */
    AnsweredElsewhere = "answered_elsewhere",
    /**
     * No media connection could be established to the other party
     */
    IceFailed = "ice_failed",
    /**
     * The invite timed out whilst waiting for an answer
     */
    InviteTimeout = "invite_timeout",
    /**
     * The call was replaced by another call
     */
    Replaced = "replaced",
    /**
     * Signalling for the call could not be sent (other than the initial invite)
     */
    SignallingFailed = "signalling_timeout",
    /**
     * The remote party is busy
     */
    UserBusy = "user_busy",
    /**
     * We transferred the call off to somewhere else
     */
    Transfered = "transferred"
}
export declare class CallError extends Error {
    code: string;
    constructor(code: CallErrorCode, msg: string, err: Error);
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
export declare class MatrixCall extends EventEmitter {
    roomId: string;
    callId: string;
    state: CallState;
    hangupParty: CallParty;
    hangupReason: string;
    direction: CallDirection;
    ourPartyId: string;
    private client;
    private forceTURN;
    private turnServers;
    private candidateSendQueue;
    private candidateSendTries;
    private sentEndOfCandidates;
    private peerConn;
    private feeds;
    private usermediaSenders;
    private screensharingSenders;
    private inviteOrAnswerSent;
    private waitForLocalAVStream;
    private successor;
    private opponentMember;
    private opponentVersion;
    private opponentPartyId;
    private opponentCaps;
    private inviteTimeout;
    private remoteOnHold;
    private callStatsAtEnd;
    private makingOffer;
    private ignoreOffer;
    private remoteCandidateBuffer;
    private remoteAssertedIdentity;
    private remoteSDPStreamMetadata;
    private callLengthInterval;
    private callLength;
    constructor(opts: CallOpts);
    /**
     * Place a voice call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    placeVoiceCall(): Promise<void>;
    /**
     * Place a video call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    placeVideoCall(): Promise<void>;
    /**
     * Create a datachannel using this call's peer connection.
     * @param label A human readable label for this datachannel
     * @param options An object providing configuration options for the data channel.
     */
    createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel;
    getOpponentMember(): RoomMember;
    opponentCanBeTransferred(): boolean;
    opponentSupportsDTMF(): boolean;
    getRemoteAssertedIdentity(): AssertedIdentity;
    get type(): CallType;
    get hasLocalUserMediaVideoTrack(): boolean;
    get hasRemoteUserMediaVideoTrack(): boolean;
    get hasLocalUserMediaAudioTrack(): boolean;
    get hasRemoteUserMediaAudioTrack(): boolean;
    get localUsermediaFeed(): CallFeed;
    get localScreensharingFeed(): CallFeed;
    get localUsermediaStream(): MediaStream;
    get localScreensharingStream(): MediaStream;
    get remoteUsermediaFeed(): CallFeed;
    get remoteScreensharingFeed(): CallFeed;
    get remoteUsermediaStream(): MediaStream;
    get remoteScreensharingStream(): MediaStream;
    private getFeedByStreamId;
    /**
     * Returns an array of all CallFeeds
     * @returns {Array<CallFeed>} CallFeeds
     */
    getFeeds(): Array<CallFeed>;
    /**
     * Returns an array of all local CallFeeds
     * @returns {Array<CallFeed>} local CallFeeds
     */
    getLocalFeeds(): Array<CallFeed>;
    /**
     * Returns an array of all remote CallFeeds
     * @returns {Array<CallFeed>} remote CallFeeds
     */
    getRemoteFeeds(): Array<CallFeed>;
    /**
     * Generates and returns localSDPStreamMetadata
     * @returns {SDPStreamMetadata} localSDPStreamMetadata
     */
    private getLocalSDPStreamMetadata;
    /**
     * Returns true if there are no incoming feeds,
     * otherwise returns false
     * @returns {boolean} no incoming feeds
     */
    noIncomingFeeds(): boolean;
    private pushRemoteFeed;
    /**
     * This method is used ONLY if the other client doesn't support sending SDPStreamMetadata
     */
    private pushRemoteFeedWithoutMetadata;
    private pushNewLocalFeed;
    /**
     * Pushes supplied feed to the call
     * @param {CallFeed} callFeed to push
     * @param {boolean} addToPeerConnection whether to add the tracks to the peer connection
     */
    pushLocalFeed(callFeed: CallFeed, addToPeerConnection?: boolean): void;
    /**
     * Removes local call feed from the call and its tracks from the peer
     * connection
     * @param callFeed to remove
     */
    removeLocalFeed(callFeed: CallFeed): void;
    private deleteAllFeeds;
    private deleteFeedByStream;
    getCurrentCallStats(): Promise<any[]>;
    private collectCallStats;
    /**
     * Configure this call from an invite event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.invite event
     */
    initWithInvite(event: MatrixEvent): Promise<void>;
    /**
     * Configure this call from a hangup or reject event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.hangup event
     */
    initWithHangup(event: MatrixEvent): void;
    private shouldAnswerWithMediaType;
    /**
     * Answer a call.
     */
    answer(audio?: boolean, video?: boolean): Promise<void>;
    answerWithCallFeeds(callFeeds: CallFeed[]): void;
    /**
     * Replace this call with a new call, e.g. for glare resolution. Used by
     * MatrixClient.
     * @param {MatrixCall} newCall The new call.
     */
    replacedBy(newCall: MatrixCall): void;
    /**
     * Hangup a call.
     * @param {string} reason The reason why the call is being hung up.
     * @param {boolean} suppressEvent True to suppress emitting an event.
     */
    hangup(reason: CallErrorCode, suppressEvent: boolean): void;
    /**
     * Reject a call
     * This used to be done by calling hangup, but is a separate method and protocol
     * event as of MSC2746.
     */
    reject(): void;
    /**
     * Adds an audio and/or video track - upgrades the call
     * @param {boolean} audio should add an audio track
     * @param {boolean} video should add an video track
     */
    private upgradeCall;
    /**
     * Returns true if this.remoteSDPStreamMetadata is defined, otherwise returns false
     * @returns {boolean} can screenshare
     */
    opponentSupportsSDPStreamMetadata(): boolean;
    /**
     * If there is a screensharing stream returns true, otherwise returns false
     * @returns {boolean} is screensharing
     */
    isScreensharing(): boolean;
    /**
     * Starts/stops screensharing
     * @param enabled the desired screensharing state
     * @param {string} desktopCapturerSourceId optional id of the desktop capturer source to use
     * @returns {boolean} new screensharing state
     */
    setScreensharingEnabled(enabled: boolean, desktopCapturerSourceId?: string): Promise<boolean>;
    /**
     * Starts/stops screensharing
     * Should be used ONLY if the opponent doesn't support SDPStreamMetadata
     * @param enabled the desired screensharing state
     * @param {string} desktopCapturerSourceId optional id of the desktop capturer source to use
     * @returns {boolean} new screensharing state
     */
    private setScreensharingEnabledWithoutMetadataSupport;
    /**
     * Set whether our outbound video should be muted or not.
     * @param {boolean} muted True to mute the outbound video.
     * @returns the new mute state
     */
    setLocalVideoMuted(muted: boolean): Promise<boolean>;
    /**
     * Check if local video is muted.
     *
     * If there are multiple video tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no video tracks, this will
     * return true.
     * @return {Boolean} True if the local preview video is muted, else false
     * (including if the call is not set up yet).
     */
    isLocalVideoMuted(): boolean;
    /**
     * Set whether the microphone should be muted or not.
     * @param {boolean} muted True to mute the mic.
     * @returns the new mute state
     */
    setMicrophoneMuted(muted: boolean): Promise<boolean>;
    /**
     * Check if the microphone is muted.
     *
     * If there are multiple audio tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no audio tracks, this will
     * return true.
     * @return {Boolean} True if the mic is muted, else false (including if the call
     * is not set up yet).
     */
    isMicrophoneMuted(): boolean;
    /**
     * @returns true if we have put the party on the other side of the call on hold
     * (that is, we are signalling to them that we are not listening)
     */
    isRemoteOnHold(): boolean;
    setRemoteOnHold(onHold: boolean): void;
    /**
     * Indicates whether we are 'on hold' to the remote party (ie. if true,
     * they cannot hear us).
     * @returns true if the other party has put us on hold
     */
    isLocalOnHold(): boolean;
    /**
     * Sends a DTMF digit to the other party
     * @param digit The digit (nb. string - '#' and '*' are dtmf too)
     */
    sendDtmfDigit(digit: string): void;
    private updateMuteStatus;
    private gotCallFeedsForInvite;
    private sendAnswer;
    private gotCallFeedsForAnswer;
    /**
     * Internal
     * @param {Object} event
     */
    private gotLocalIceCandidate;
    private onIceGatheringStateChange;
    onRemoteIceCandidatesReceived(ev: MatrixEvent): Promise<void>;
    /**
     * Used by MatrixClient.
     * @param {Object} msg
     */
    onAnswerReceived(event: MatrixEvent): Promise<void>;
    onSelectAnswerReceived(event: MatrixEvent): Promise<void>;
    onNegotiateReceived(event: MatrixEvent): Promise<void>;
    private updateRemoteSDPStreamMetadata;
    onSDPStreamMetadataChangedReceived(event: MatrixEvent): void;
    onAssertedIdentityReceived(event: MatrixEvent): Promise<void>;
    private callHasEnded;
    private gotLocalOffer;
    private getLocalOfferFailed;
    private getUserMediaFailed;
    private onIceConnectionStateChanged;
    private onSignallingStateChanged;
    private onTrack;
    private onDataChannel;
    /**
     * This method removes all video/rtx codecs from screensharing video
     * transceivers. This is necessary since they can cause problems. Without
     * this the following steps should produce an error:
     *   Chromium calls Firefox
     *   Firefox answers
     *   Firefox starts screen-sharing
     *   Chromium starts screen-sharing
     *   Call crashes for Chromium with:
     *       [96685:23:0518/162603.933321:ERROR:webrtc_video_engine.cc(3296)] RTX codec (PT=97) mapped to PT=96 which is not in the codec list.
     *       [96685:23:0518/162603.933377:ERROR:webrtc_video_engine.cc(1171)] GetChangedRecvParameters called without any video codecs.
     *       [96685:23:0518/162603.933430:ERROR:sdp_offer_answer.cc(4302)] Failed to set local video description recv parameters for m-section with mid='2'. (INVALID_PARAMETER)
     */
    private getRidOfRTXCodecs;
    private onNegotiationNeeded;
    onHangupReceived: (msg: MCallHangupReject) => void;
    onRejectReceived: (msg: MCallHangupReject) => void;
    onAnsweredElsewhere: (msg: MCallAnswer) => void;
    private setState;
    /**
     * Internal
     * @param {string} eventType
     * @param {Object} content
     * @return {Promise}
     */
    private sendVoipEvent;
    private queueCandidate;
    transfer(targetUserId: string): Promise<void>;
    transferToCall(transferTargetCall?: MatrixCall): Promise<void>;
    private terminate;
    private stopAllMedia;
    private checkForErrorListener;
    private sendCandidateQueue;
    /**
     * Place a call to this room.
     * @throws if you have not specified a listener for 'error' events.
     * @throws if have passed audio=false.
     */
    placeCall(audio: boolean, video: boolean): Promise<void>;
    /**
     * Place a call to this room with call feed.
     * @param {CallFeed[]} callFeeds to use
     * @throws if you have not specified a listener for 'error' events.
     * @throws if have passed audio=false.
     */
    placeCallWithCallFeeds(callFeeds: CallFeed[]): Promise<void>;
    private createPeerConnection;
    private partyIdMatches;
    private chooseOpponent;
    private addBufferedIceCandidates;
    private addIceCandidates;
    get hasPeerConnection(): boolean;
}
/**
 * DEPRECATED
 * Use client.createCall()
 *
 * Create a new Matrix call for the browser.
 * @param {MatrixClient} client The client instance to use.
 * @param {string} roomId The room the call is in.
 * @param {Object?} options DEPRECATED optional options map.
 * @param {boolean} options.forceTURN DEPRECATED whether relay through TURN should be
 * forced. This option is deprecated - use opts.forceTURN when creating the matrix client
 * since it's only possible to set this option on outbound calls.
 * @return {MatrixCall} the call or null if the browser doesn't support calling.
 */
export declare function createNewMatrixCall(client: any, roomId: string, options?: CallOpts): MatrixCall;
export {};
//# sourceMappingURL=call.d.ts.map