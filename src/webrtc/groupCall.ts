import { TypedEventEmitter } from "../models/typed-event-emitter";
import { CallFeed, SPEAKING_THRESHOLD } from "./callFeed";
import { MatrixClient } from "../client";
import {
    CallErrorCode,
    CallEvent,
    CallEventHandlerMap,
    CallState,
    genCallID,
    MatrixCall,
    setTracksEnabled,
} from "./call";
import { RoomMember } from "../models/room-member";
import { Room } from "../models/room";
import { logger } from "../logger";
import { ReEmitter } from "../ReEmitter";
import { SDPStreamMetadata, SDPStreamMetadataPurpose } from "./callEventTypes";
import { createNewMatrixCall } from "./call";
import { ISendEventResponse } from "../@types/requests";
import { MatrixEvent } from "../models/event";
import { EventType } from "../@types/event";
import { CallEventHandlerEvent } from "./callEventHandler";
import { GroupCallEventHandlerEvent } from "./groupCallEventHandler";
import { randomString } from "../randomstring";
import { IScreensharingOpts } from "./mediaHandler";
import { recursivelyAssign } from "../utils";

export enum GroupCallIntent {
    Ring = "m.ring",
    Prompt = "m.prompt",
    Room = "m.room",
}

export enum GroupCallType {
    Video = "m.video",
    Voice = "m.voice",
}

export enum GroupCallTerminationReason {
    CallEnded = "call_ended",
}

export enum GroupCallEvent {
    GroupCallStateChanged = "group_call_state_changed",
    ActiveSpeakerChanged = "active_speaker_changed",
    CallsChanged = "calls_changed",
    UserMediaFeedsChanged = "user_media_feeds_changed",
    ScreenshareFeedsChanged = "screenshare_feeds_changed",
    LocalScreenshareStateChanged = "local_screenshare_state_changed",
    LocalMuteStateChanged = "local_mute_state_changed",
    ParticipantsChanged = "participants_changed",
    Error = "error",
}

export type GroupCallEventHandlerMap = {
    [GroupCallEvent.GroupCallStateChanged]: (newState: GroupCallState, oldState: GroupCallState) => void;
    [GroupCallEvent.ActiveSpeakerChanged]: (activeSpeaker: string) => void;
    [GroupCallEvent.CallsChanged]: (calls: MatrixCall[]) => void;
    [GroupCallEvent.UserMediaFeedsChanged]: (feeds: CallFeed[]) => void;
    [GroupCallEvent.ScreenshareFeedsChanged]: (feeds: CallFeed[]) => void;
    [GroupCallEvent.LocalScreenshareStateChanged]: (
        isScreensharing: boolean, feed: CallFeed, sourceId: string,
    ) => void;
    [GroupCallEvent.LocalMuteStateChanged]: (audioMuted: boolean, videoMuted: boolean) => void;
    [GroupCallEvent.ParticipantsChanged]: (participants: RoomMember[]) => void;
    [GroupCallEvent.Error]: (error: GroupCallError) => void;
};

export enum GroupCallErrorCode {
    NoUserMedia = "no_user_media",
    UnknownDevice = "unknown_device",
    PlaceCallFailed = "place_call_failed"
}

export class GroupCallError extends Error {
    code: string;

    constructor(code: GroupCallErrorCode, msg: string, err?: Error) {
        // Still don't think there's any way to have proper nested errors
        if (err) {
            super(msg + ": " + err);
        } else {
            super(msg);
        }

        this.code = code;
    }
}

export class GroupCallUnknownDeviceError extends GroupCallError {
    constructor(public userId: string) {
        super(GroupCallErrorCode.UnknownDevice, "No device found for " + userId);
    }
}

export class OtherUserSpeakingError extends Error {
    constructor() {
        super("Cannot unmute: another user is speaking");
    }
}

export interface IGroupCallDataChannelOptions {
    ordered: boolean;
    maxPacketLifeTime: number;
    maxRetransmits: number;
    protocol: string;
}

export interface IGroupCallMemberTrack {
    id: string;
    kind: string; // TODO: use an enum
    // label: string; // removing as too privacy invasive
    settings: MediaTrackSettings;
}

export interface IGroupCallMemberFeed {
    id: string;
    purpose: SDPStreamMetadataPurpose;
    tracks: IGroupCallMemberTrack[];
}

export interface IGroupCallMemberDevice {
    "device_id": string;
    "session_id": string;
    "feeds": IGroupCallMemberFeed[];
}

export interface IGroupCallMemberCallState {
    "m.call_id": string;
    "m.foci"?: string[];
    "m.devices": IGroupCallMemberDevice[];
}

export interface ISfuTrackDesc {
    "stream_id": string;
    "track_id"?: string;
}

export interface ISfuDataChannelMessage {
    "op": string;
    "id": string;
    "conf_id"?: string;
    "sdp"?: string;
    "message"?: string;
    "start"?: ISfuTrackDesc[];
    "stop"?: ISfuTrackDesc[];
}

export interface IGroupCallRoomMemberState {
    "m.calls": IGroupCallMemberCallState[];
    "m.expires_ts": number;
}

export enum GroupCallState {
    LocalCallFeedUninitialized = "local_call_feed_uninitialized",
    InitializingLocalCallFeed = "initializing_local_call_feed",
    LocalCallFeedInitialized = "local_call_feed_initialized",
    Entering = "entering",
    Entered = "entered",
    Ended = "ended",
}

interface ICallHandlers {
    onCallFeedsChanged: (feeds: CallFeed[]) => void;
    onCallStateChanged: (state: CallState, oldState: CallState) => void;
    onCallHangup: (call: MatrixCall) => void;
    onCallReplaced: (newCall: MatrixCall) => void;
}

const CALL_MEMBER_STATE_TIMEOUT = 1000 * 60 * 60; // 1 hour

const callMemberStateIsExpired = (event: MatrixEvent): boolean => {
    const now = Date.now();
    const content = event?.getContent<IGroupCallRoomMemberState>() ?? {};
    const expiresAt = typeof content["m.expires_ts"] === "number" ? content["m.expires_ts"] : -Infinity;
    return expiresAt <= now;
};

function getCallUserId(call: MatrixCall): string | null {
    return call.getOpponentMember()?.userId || call.invitee || null;
}

function defloat(json: Object): Object {
    for (const key of Object.keys(json)) {
        if (isFloat(json[key])) {
            json[key] = "" + json[key];
        }
    }
    return json;
}

function isFloat(value) {
    return (
        typeof value === 'number' &&
        !Number.isNaN(value) &&
        !Number.isInteger(value)
    );
}

interface IMediaBlock {
    mid?: string;
    trackDesc?: ISfuTrackDesc;
}

function getTrackDesc(sdp: string, mid: string): ISfuTrackDesc | undefined {
    // sdp mangling to grab the a=msid: line out of SDP for a given mid
    if (!sdp) return;

    const mediaByMids: Map<string, IMediaBlock> = new Map();
    let mediaBlock: IMediaBlock = {};
    let matches;
    for (const line of sdp.split(/\r?\n/)) {
        if (line.match(/^m=/)) {
            if (mediaBlock.mid !== undefined) {
                mediaByMids.set(mediaBlock.mid, mediaBlock);
            }
            mediaBlock = {};
        }
        matches = line.match(/^a=mid:(.*?)$/);
        if (matches) {
            mediaBlock.mid = matches[1];
        }
        matches = line.match(/^a=msid:(.*?) (.*?)$/);
        if (matches) {
            mediaBlock.trackDesc = {
                stream_id: matches[1],
                track_id: matches[2],
            };
        }
    }
    if (mediaBlock.mid) {
        mediaByMids.set(mediaBlock.mid, mediaBlock);
    }

    if (mediaByMids.get(mid)) {
        return mediaByMids.get(mid).trackDesc;
    } else {
        return;
    }
}

export class GroupCall extends TypedEventEmitter<
    GroupCallEvent | CallEvent,
    GroupCallEventHandlerMap & CallEventHandlerMap
> {
    // Config
    public activeSpeakerInterval = 1000;
    public retryCallInterval = 5000;
    public participantTimeout = 1000 * 15;
    public pttMaxTransmitTime = 1000 * 20;

    public state = GroupCallState.LocalCallFeedUninitialized;
    public activeSpeaker?: string; // userId
    public localCallFeed?: CallFeed;
    public localScreenshareFeed?: CallFeed;
    public localDesktopCapturerSourceId?: string;
    public calls: MatrixCall[] = [];
    public participants: RoomMember[] = [];
    public userMediaFeeds: CallFeed[] = [];
    public screenshareFeeds: CallFeed[] = [];
    public groupCallId: string;

    private callHandlers: Map<string, ICallHandlers> = new Map();
    private activeSpeakerLoopTimeout?: ReturnType<typeof setTimeout>;
    private retryCallLoopTimeout?: ReturnType<typeof setTimeout>;
    private retryCallCounts: Map<string, number> = new Map();
    private reEmitter: ReEmitter;
    private transmitTimer: ReturnType<typeof setTimeout> | null = null;
    private memberStateExpirationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private resendMemberStateTimer: ReturnType<typeof setTimeout> | null = null;
    private subscribedStreams: ISfuTrackDesc[] = [];

    constructor(
        private client: MatrixClient,
        public room: Room,
        public type: GroupCallType,
        public isPtt: boolean,
        public intent: GroupCallIntent,
        groupCallId?: string,
        private dataChannelsEnabled?: boolean,
        private dataChannelOptions?: IGroupCallDataChannelOptions,
    ) {
        super();
        this.reEmitter = new ReEmitter(this);
        this.groupCallId = groupCallId || genCallID();

        if (this.client.localSfu) {
            // we have to use DCs to talk to the SFU
            this.dataChannelsEnabled = true;
        }

        for (const stateEvent of this.getMemberStateEvents()) {
            this.onMemberStateChanged(stateEvent);
        }
    }

    public async create() {
        this.client.groupCallEventHandler.groupCalls.set(this.room.roomId, this);

        await this.client.sendStateEvent(
            this.room.roomId,
            EventType.GroupCallPrefix,
            {
                "m.intent": this.intent,
                "m.type": this.type,
                "io.element.ptt": this.isPtt,
                // TODO: Specify datachannels
                "dataChannelsEnabled": this.dataChannelsEnabled,
                "dataChannelOptions": this.dataChannelOptions,
            },
            this.groupCallId,
        );

        return this;
    }

    private setState(newState: GroupCallState): void {
        const oldState = this.state;
        this.state = newState;
        this.emit(GroupCallEvent.GroupCallStateChanged, newState, oldState);
    }

    public getLocalFeeds(): CallFeed[] {
        const feeds = [];

        if (this.localCallFeed) feeds.push(this.localCallFeed);
        if (this.localScreenshareFeed) feeds.push(this.localScreenshareFeed);

        return feeds;
    }

    public hasLocalParticipant(): boolean {
        const userId = this.client.getUserId();
        return this.participants.some((member) => member.userId === userId);
    }

    public async initLocalCallFeed(): Promise<CallFeed> {
        logger.log(`groupCall ${this.groupCallId} initLocalCallFeed`);

        if (this.state !== GroupCallState.LocalCallFeedUninitialized) {
            throw new Error(`Cannot initialize local call feed in the "${this.state}" state.`);
        }

        this.setState(GroupCallState.InitializingLocalCallFeed);

        let stream: MediaStream;

        try {
            stream = await this.client.getMediaHandler().getUserMediaStream(true, this.type === GroupCallType.Video);
        } catch (error) {
            this.setState(GroupCallState.LocalCallFeedUninitialized);
            throw error;
        }

        // start muted on ptt calls
        if (this.isPtt) {
            setTracksEnabled(stream.getAudioTracks(), false);
        }

        const userId = this.client.getUserId();

        const callFeed = new CallFeed({
            client: this.client,
            roomId: this.room.roomId,
            userId,
            stream,
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: stream.getAudioTracks().length === 0 || this.isPtt,
            videoMuted: stream.getVideoTracks().length === 0,
        });

        this.localCallFeed = callFeed;
        this.addUserMediaFeed(callFeed);

        this.setState(GroupCallState.LocalCallFeedInitialized);

        return callFeed;
    }

    public async updateLocalUsermediaStream(stream: MediaStream) {
        if (this.localCallFeed) {
            const oldStream = this.localCallFeed.stream;
            this.localCallFeed.setNewStream(stream);
            const micShouldBeMuted = this.localCallFeed.isAudioMuted();
            const vidShouldBeMuted = this.localCallFeed.isVideoMuted();
            logger.log(`groupCall ${this.groupCallId} updateLocalUsermediaStream oldStream ${
                oldStream.id} newStream ${stream.id} micShouldBeMuted ${
                micShouldBeMuted} vidShouldBeMuted ${vidShouldBeMuted}`);
            setTracksEnabled(stream.getAudioTracks(), !micShouldBeMuted);
            setTracksEnabled(stream.getVideoTracks(), !vidShouldBeMuted);
            this.client.getMediaHandler().stopUserMediaStream(oldStream);
        }
    }

    public async enter() {
        if (!(this.state === GroupCallState.LocalCallFeedUninitialized ||
            this.state === GroupCallState.LocalCallFeedInitialized)) {
            throw new Error(`Cannot enter call in the "${this.state}" state`);
        }

        if (this.state === GroupCallState.LocalCallFeedUninitialized) {
            await this.initLocalCallFeed();
        }

        this.addParticipant(this.room.getMember(this.client.getUserId()));

        await this.sendMemberStateEvent();

        this.activeSpeaker = null;

        this.setState(GroupCallState.Entered);

        logger.log(`Entered group call ${this.groupCallId}`);

        this.client.on(CallEventHandlerEvent.Incoming, this.onIncomingCall);

        const calls = this.client.callEventHandler.calls.values();

        for (const call of calls) {
            this.onIncomingCall(call);
        }

        // Set up participants for the members currently in the room.
        // Other members will be picked up by the RoomState.members event.
        for (const stateEvent of this.getMemberStateEvents()) {
            this.onMemberStateChanged(stateEvent);
        }

        this.retryCallLoopTimeout = setTimeout(this.onRetryCallLoop, this.retryCallInterval);

        this.onActiveSpeakerLoop();
    }

    private dispose() {
        if (this.localCallFeed) {
            this.removeUserMediaFeed(this.localCallFeed);
            this.localCallFeed = null;
        }

        if (this.localScreenshareFeed) {
            this.client.getMediaHandler().stopScreensharingStream(this.localScreenshareFeed.stream);
            this.removeScreenshareFeed(this.localScreenshareFeed);
            this.localScreenshareFeed = undefined;
            this.localDesktopCapturerSourceId = undefined;
        }

        this.client.getMediaHandler().stopAllStreams();
        this.subscribedStreams = [];

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        this.removeParticipant(this.room.getMember(this.client.getUserId()));

        this.removeMemberStateEvent();

        while (this.calls.length > 0) {
            this.removeCall(this.calls[this.calls.length - 1], CallErrorCode.UserHangup);
        }

        this.activeSpeaker = null;
        clearTimeout(this.activeSpeakerLoopTimeout);

        this.retryCallCounts.clear();
        clearTimeout(this.retryCallLoopTimeout);

        if (this.transmitTimer !== null) {
            clearTimeout(this.transmitTimer);
            this.transmitTimer = null;
        }

        this.client.removeListener(CallEventHandlerEvent.Incoming, this.onIncomingCall);
    }

    public leave() {
        if (this.transmitTimer !== null) {
            clearTimeout(this.transmitTimer);
            this.transmitTimer = null;
        }

        this.dispose();
        this.setState(GroupCallState.LocalCallFeedUninitialized);
    }

    public async terminate(emitStateEvent = true) {
        this.dispose();

        if (this.transmitTimer !== null) {
            clearTimeout(this.transmitTimer);
            this.transmitTimer = null;
        }

        this.participants = [];
        this.client.groupCallEventHandler.groupCalls.delete(this.room.roomId);

        if (emitStateEvent) {
            const existingStateEvent = this.room.currentState.getStateEvents(
                EventType.GroupCallPrefix, this.groupCallId,
            );

            await this.client.sendStateEvent(
                this.room.roomId,
                EventType.GroupCallPrefix,
                {
                    ...existingStateEvent.getContent(),
                    ["m.terminated"]: GroupCallTerminationReason.CallEnded,
                },
                this.groupCallId,
            );
        }

        this.client.emit(GroupCallEventHandlerEvent.Ended, this);
        this.setState(GroupCallState.Ended);
    }

    /**
     * Local Usermedia
     */

    public isLocalVideoMuted() {
        if (this.localCallFeed) {
            return this.localCallFeed.isVideoMuted();
        }

        return true;
    }

    public isMicrophoneMuted() {
        if (this.localCallFeed) {
            return this.localCallFeed.isAudioMuted();
        }

        return true;
    }

    /**
     * Sets the mute state of the local participants's microphone.
     * @param {boolean} muted Whether to mute the microphone
     * @returns {Promise<boolean>} Whether muting/unmuting was successful
     */
    public async setMicrophoneMuted(muted: boolean): Promise<boolean> {
        // hasAudioDevice can block indefinitely if the window has lost focus,
        // and it doesn't make much sense to keep a device from being muted, so
        // we always allow muted = true changes to go through
        if (!muted && !await this.client.getMediaHandler().hasAudioDevice()) {
            return false;
        }

        const sendUpdatesBefore = !muted && this.isPtt;

        // set a timer for the maximum transmit time on PTT calls
        if (this.isPtt) {
            // Set or clear the max transmit timer
            if (!muted && this.isMicrophoneMuted()) {
                this.transmitTimer = setTimeout(() => {
                    this.setMicrophoneMuted(true);
                }, this.pttMaxTransmitTime);
            } else if (muted && !this.isMicrophoneMuted()) {
                clearTimeout(this.transmitTimer);
                this.transmitTimer = null;
            }
        }

        for (const call of this.calls) {
            call.localUsermediaFeed.setAudioVideoMuted(muted, null);
        }

        if (sendUpdatesBefore) {
            try {
                await Promise.all(this.calls.map(c => c.sendMetadataUpdate()));
            } catch (e) {
                logger.info("Failed to send one or more metadata updates", e);
            }
        }

        if (this.localCallFeed) {
            logger.log(`groupCall ${this.groupCallId} setMicrophoneMuted stream ${
                this.localCallFeed.stream.id} muted ${muted}`);
            this.localCallFeed.setAudioVideoMuted(muted, null);
            // I don't believe its actually necessary to enable these tracks: they
            // are the one on the groupcall's own CallFeed and are cloned before being
            // given to any of the actual calls, so these tracks don't actually go
            // anywhere. Let's do it anyway to avoid confusion.
            setTracksEnabled(this.localCallFeed.stream.getAudioTracks(), !muted);
        }

        for (const call of this.calls) {
            setTracksEnabled(call.localUsermediaFeed.stream.getAudioTracks(), !muted);
        }

        if (!sendUpdatesBefore) {
            try {
                await Promise.all(this.calls.map(c => c.sendMetadataUpdate()));
            } catch (e) {
                logger.info("Failed to send one or more metadata updates", e);
            }
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, muted, this.isLocalVideoMuted());
        return true;
    }

    /**
     * Sets the mute state of the local participants's video.
     * @param {boolean} muted Whether to mute the video
     * @returns {Promise<boolean>} Whether muting/unmuting was successful
     */
    public async setLocalVideoMuted(muted: boolean): Promise<boolean> {
        // hasAudioDevice can block indefinitely if the window has lost focus,
        // and it doesn't make much sense to keep a device from being muted, so
        // we always allow muted = true changes to go through
        if (!muted && !await this.client.getMediaHandler().hasVideoDevice()) {
            return false;
        }

        if (this.localCallFeed) {
            logger.log(`groupCall ${this.groupCallId} setLocalVideoMuted stream ${
                this.localCallFeed.stream.id} muted ${muted}`);
            this.localCallFeed.setAudioVideoMuted(null, muted);
            setTracksEnabled(this.localCallFeed.stream.getVideoTracks(), !muted);
        }

        for (const call of this.calls) {
            call.setLocalVideoMuted(muted);
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, this.isMicrophoneMuted(), muted);
        return true;
    }

    public async setScreensharingEnabled(
        enabled: boolean, opts: IScreensharingOpts = {},
    ): Promise<boolean> {
        if (enabled === this.isScreensharing()) {
            return enabled;
        }

        if (enabled) {
            try {
                logger.log("Asking for screensharing permissions...");
                const stream = await this.client.getMediaHandler().getScreensharingStream(opts);

                for (const track of stream.getTracks()) {
                    const onTrackEnded = () => {
                        this.setScreensharingEnabled(false);
                        track.removeEventListener("ended", onTrackEnded);
                    };

                    track.addEventListener("ended", onTrackEnded);
                }

                logger.log("Screensharing permissions granted. Setting screensharing enabled on all calls");

                this.localDesktopCapturerSourceId = opts.desktopCapturerSourceId;
                this.localScreenshareFeed = new CallFeed({
                    client: this.client,
                    roomId: this.room.roomId,
                    userId: this.client.getUserId(),
                    stream,
                    purpose: SDPStreamMetadataPurpose.Screenshare,
                    audioMuted: false,
                    videoMuted: false,
                });
                this.addScreenshareFeed(this.localScreenshareFeed);

                this.emit(
                    GroupCallEvent.LocalScreenshareStateChanged,
                    true,
                    this.localScreenshareFeed,
                    this.localDesktopCapturerSourceId,
                );

                // TODO: handle errors
                await Promise.all(this.calls.map(call => call.pushLocalFeed(
                    this.localScreenshareFeed.clone(),
                )));

                await this.sendMemberStateEvent();

                return true;
            } catch (error) {
                logger.error("Enabling screensharing error", error);
                this.emit(GroupCallEvent.Error,
                    new GroupCallError(GroupCallErrorCode.NoUserMedia, "Failed to get screen-sharing stream: ", error),
                );
                return false;
            }
        } else {
            await Promise.all(this.calls.map(call => call.removeLocalFeed(call.localScreensharingFeed)));
            this.client.getMediaHandler().stopScreensharingStream(this.localScreenshareFeed.stream);
            this.removeScreenshareFeed(this.localScreenshareFeed);
            this.localScreenshareFeed = undefined;
            this.localDesktopCapturerSourceId = undefined;
            await this.sendMemberStateEvent();
            this.emit(GroupCallEvent.LocalScreenshareStateChanged, false, undefined, undefined);
            return false;
        }
    }

    public isScreensharing(): boolean {
        return !!this.localScreenshareFeed;
    }

    /**
     * Call Setup
     *
     * There are two different paths for calls to be created:
     * 1. Incoming calls triggered by the Call.incoming event.
     * 2. Outgoing calls to the initial members of a room or new members
     *    as they are observed by the RoomState.members event.
     */

    private onIncomingCall = (newCall: MatrixCall) => {
        // The incoming calls may be for another room, which we will ignore.
        if (newCall.roomId !== this.room.roomId) {
            return;
        }

        if (newCall.state !== CallState.Ringing) {
            logger.warn("Incoming call no longer in ringing state. Ignoring.");
            return;
        }

        if (!newCall.groupCallId || newCall.groupCallId !== this.groupCallId) {
            logger.log(`Incoming call with groupCallId ${
                newCall.groupCallId} ignored because it doesn't match the current group call`);
            newCall.reject();
            return;
        }

        const opponentMemberId = newCall.getOpponentMember().userId;
        const existingCall = this.getCallByUserId(opponentMemberId);

        if (existingCall && existingCall.callId === newCall.callId) {
            return;
        }

        logger.log(`GroupCall: incoming call from: ${opponentMemberId}`);

        // we are handlng this call as a PTT call, so enable PTT semantics
        newCall.isPtt = this.isPtt;

        // Check if the user calling has an existing call and use this call instead.
        if (existingCall) {
            this.replaceCall(existingCall, newCall);
        } else {
            this.addCall(newCall);
        }

        newCall.answerWithCallFeeds(this.getLocalFeeds().map((feed) => feed.clone()));
    };

    /**
     * Room Member State
     */

    private getMemberStateEvents(): MatrixEvent[];
    private getMemberStateEvents(userId: string): MatrixEvent | null;
    private getMemberStateEvents(userId?: string): MatrixEvent[] | MatrixEvent | null {
        if (userId != null) {
            const event = this.room.currentState.getStateEvents(EventType.GroupCallMemberPrefix, userId);
            return callMemberStateIsExpired(event) ? null : event;
        } else {
            return this.room.currentState.getStateEvents(EventType.GroupCallMemberPrefix)
                .filter(event => !callMemberStateIsExpired(event));
        }
    }

    private async sendMemberStateEvent(): Promise<ISendEventResponse> {
        const feeds = this.getLocalFeeds().map((feed) => ({
            purpose: feed.purpose,
            id: feed.stream.id,

            // we have to advertise the actual tracks we're sending to the SFU from the PC
            // we can't use the feeds' mediaStream IDs, as they are local rather than the copy
            // sent over WebRTC
            //
            // TODO: correctly track which rtpSenders are associated with which feed
            // rather than assuming that all our senders are from this feed.
            tracks: this.calls[0]
                ? this.calls[0].peerConn.getTransceivers().map(transceiver => ({
                    "id": getTrackDesc(this.calls[0].peerConn.localDescription?.sdp, transceiver.mid)?.track_id,
                    "kind": transceiver.sender.track.kind,
                    "settings": defloat(transceiver.sender.track.getSettings()),
                }))
                : undefined,
        }));

        const send = () => this.updateMemberCallState({
            "m.call_id": this.groupCallId,
            "m.devices": [
                {
                    "device_id": this.client.getDeviceId(),
                    "session_id": this.client.getSessionId(),
                    "feeds": feeds,
                    // TODO: Add data channels
                },
            ],
            // TODO "m.foci"
        });

        const res = await send();

        // Resend the state event every so often so it doesn't become stale
        this.resendMemberStateTimer = setInterval(async () => {
            logger.log("Resending call member state");
            await send();
        }, CALL_MEMBER_STATE_TIMEOUT * 3 / 4);

        return res;
    }

    private async removeMemberStateEvent(): Promise<ISendEventResponse> {
        clearInterval(this.resendMemberStateTimer);
        this.resendMemberStateTimer = null;
        return await this.updateMemberCallState(undefined);
    }

    private async updateMemberCallState(memberCallState?: IGroupCallMemberCallState): Promise<ISendEventResponse> {
        const localUserId = this.client.getUserId();

        const memberState = this.getMemberStateEvents(localUserId)?.getContent<IGroupCallRoomMemberState>();

        let calls: IGroupCallMemberCallState[] = [];

        // Sanitize existing member state event
        if (memberState && Array.isArray(memberState["m.calls"])) {
            calls = memberState["m.calls"].filter((call) => !!call);
        }

        const existingCallIndex = calls.findIndex((call) => call && call["m.call_id"] === this.groupCallId);

        if (existingCallIndex !== -1) {
            if (memberCallState) {
                calls.splice(existingCallIndex, 1, memberCallState);
            } else {
                calls.splice(existingCallIndex, 1);
            }
        } else if (memberCallState) {
            calls.push(memberCallState);
        }

        const content = {
            "m.calls": calls,
            "m.expires_ts": Date.now() + CALL_MEMBER_STATE_TIMEOUT,
        };

        return this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, content, localUserId);
    }

    private getRemoteFeedsFromState(): IGroupCallMemberFeed[] {
        return this.getMemberStateEvents()?.reduce((feeds, event) => {
            if (event.getSender() === this.client.getUserId()) return feeds; // Ignore local
            const newFeeds = event.getContent<IGroupCallRoomMemberState>()?.["m.calls"]?.[0]?.["m.devices"]?.[0]?.feeds;
            if (!newFeeds) return feeds;
            return [...feeds, ...newFeeds];
        }, []) ?? [];
    }

    private getRemoteSDPStreamMetadataForCall(): SDPStreamMetadata {
        return this.getMemberStateEvents().reduce((metaAcc: SDPStreamMetadata, event: MatrixEvent) => {
            if (event.getSender() === this.client.getUserId()) return metaAcc; // Ignore local
            const feeds = event.getContent<IGroupCallRoomMemberState>()?.["m.calls"]?.[0]?.["m.devices"]?.[0]?.feeds;
            if (!feeds) return metaAcc;
            const metadata = feeds.reduce((feedAcc: SDPStreamMetadata, feed: IGroupCallMemberFeed) => {
                if (!feed?.id) return feedAcc;
                return recursivelyAssign(feedAcc, {
                    [feed.id]: {
                        purpose: feed.purpose,
                        userId: event.getSender(),
                    },
                }, true);
            }, {});
            return recursivelyAssign(metaAcc, metadata, true);
        }, {});
    }

    public onMemberStateChanged = async (event: MatrixEvent) => {
        // The member events may be received for another room, which we will ignore.
        if (event.getRoomId() !== this.room.roomId) return;

        const member = this.room.getMember(event.getStateKey());
        if (!member) return;

        const ignore = () => {
            this.removeParticipant(member);
            clearTimeout(this.memberStateExpirationTimers.get(member.userId));
            this.memberStateExpirationTimers.delete(member.userId);
        };

        const content = event.getContent<IGroupCallRoomMemberState>();
        const callsState = !callMemberStateIsExpired(event) && Array.isArray(content["m.calls"])
            ? content["m.calls"].filter((call) => call)
            : []; // Ignore expired device data

        if (callsState.length === 0) {
            logger.log(`Ignoring member state from ${member.userId} member not in any calls.`);
            ignore();
            return;
        }

        // Currently we only support a single call per room. So grab the first call.
        const callState = callsState[0];
        const callId = callState["m.call_id"];

        if (!callId) {
            logger.warn(`Room member ${member.userId} does not have a valid m.call_id set. Ignoring.`);
            ignore();
            return;
        }

        if (callId !== this.groupCallId) {
            logger.warn(`Call id ${callId} does not match group call id ${this.groupCallId}, ignoring.`);
            ignore();
            return;
        }

        this.addParticipant(member);

        clearTimeout(this.memberStateExpirationTimers.get(member.userId));
        this.memberStateExpirationTimers.set(member.userId, setTimeout(() => {
            logger.warn(`Call member state for ${member.userId} has expired`);
            this.removeParticipant(member);
        }, content["m.expires_ts"] - Date.now()));

        // Don't process your own member.
        const localUserId = this.client.getUserId();

        if (member.userId === localUserId) {
            return;
        }

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        let opponentDevice: IGroupCallMemberDevice;
        let peerUserId: string;
        let existingCall: MatrixCall;

        if (this.client.localSfu) {
            peerUserId = this.client.localSfu;
            opponentDevice = {
                "device_id": this.client.localSfuDeviceId,
                // XXX: the SFU might need to specify a session_id so that if it
                // restarts and starts sending invites to us, we know that it's
                // forgotten who we were?  But then we need a way to communicate
                // the session_id to the clients, which is tough if the SFU is
                // not in the right room.
                "session_id": "sfu",
                "feeds": [],
            };
            existingCall = this.getCallByUserId(peerUserId);
        } else {
            // Only initiate a call with a user who has a userId that is
            // lexicographically less than your own. Otherwise, that user will
            // call you.
            if (member.userId < localUserId) {
                logger.log(`Waiting for ${member.userId} to send call invite.`);
                return;
            }

            opponentDevice = this.getDeviceForMember(member.userId);
            if (!opponentDevice) {
                logger.warn(`No opponent device found for ${member.userId}, ignoring.`);
                this.emit(
                    GroupCallEvent.Error,
                    new GroupCallUnknownDeviceError(member.userId),
                );
                return;
            }

            peerUserId = member.userId;
            existingCall = this.getCallByUserId(peerUserId);

            // if we already have an existing call to the same session on the
            // other side, then use it - it must have already called us first.
            if (
                existingCall &&
                existingCall.getOpponentSessionId() === opponentDevice.session_id
            ) {
                return;
            }
        }

        if (
            !this.client.localSfu ||
            (this.client.localSfu && !existingCall)
        ) {
            const newCall = createNewMatrixCall(
                this.client,
                this.room.roomId,
                {
                    invitee: peerUserId,
                    opponentDeviceId: opponentDevice.device_id,
                    opponentSessionId: opponentDevice.session_id,
                    groupCallId: this.groupCallId,
                    initialRemoteSDPStreamMetadata: this.client.localSfu
                        ? this.getRemoteSDPStreamMetadataForCall()
                        : undefined,
                },
            );

            newCall.isPtt = this.isPtt;

            const requestScreenshareFeed = opponentDevice.feeds.some(
                (feed) => feed.purpose === SDPStreamMetadataPurpose.Screenshare);

            try {
                await newCall.placeCallWithCallFeeds(
                    this.client.localSfu === peerUserId
                        ? this.getLocalFeeds() // TODO: We should just setup the datachannel
                        : this.getLocalFeeds().map(feed => feed.clone()), // Safari can't send a MediaStream to multiple sources, so clone it
                    requestScreenshareFeed,
                );
            } catch (e) {
                logger.warn(`Failed to place call to ${member.userId}!`, e);
                this.emit(
                    GroupCallEvent.Error,
                    new GroupCallError(
                        GroupCallErrorCode.PlaceCallFailed,
                        `Failed to place call to ${member.userId}.`,
                    ),
                );
                return;
            }

            if (this.dataChannelsEnabled) {
                newCall.createDataChannel("datachannel", this.dataChannelOptions);
            }

            if (existingCall) {
                this.replaceCall(existingCall, newCall, CallErrorCode.NewSession);
            } else {
                this.addCall(newCall);
            }
        } else if (this.client.localSfu && existingCall) {
            // subscribe if we already had an existing call (otherwise
            // we'll subscribe on the new call being set up)
            existingCall.updateRemoteSDPStreamMetadata(this.getRemoteSDPStreamMetadataForCall());
            this.subscribeToSFU(existingCall, this.getRemoteFeedsFromState());
        }
    };

    private async waitForDatachannelToBeOpen(call: MatrixCall): Promise<void> {
        if (call.dataChannel.readyState === 'connecting') {
            const p = new Promise<void>(resolve => {
                call.dataChannel.onopen = () => resolve();
                call.dataChannel.onclose = () => resolve();
            });
            await p;
        }
        return;
    }

    private async subscribeToSFU(call: MatrixCall, feeds: IGroupCallMemberFeed[]) {
        await this.waitForDatachannelToBeOpen(call);
        if (call.dataChannel.readyState !== "open") {
            logger.warn("Can't sent to DC in state:", call.dataChannel.readyState);
            return;
        }

        // Only subscribe to streams we aren't already subscribed to
        const streams: ISfuTrackDesc[] = feeds.filter((feed) => {
            if (!feed.tracks) return false; // If we don't have info about tracks, the SFU won't have them either
            return !this.subscribedStreams.find((stream) => stream.stream_id === feed.id);
        }).map((feed) => ({ stream_id: feed.id }));

        if (streams.length === 0) {
            logger.warn("Failed to find any new streams to subscribe to");
            return;
        } else {
            this.subscribedStreams.push(...streams);
            logger.warn("Subscribing to:", streams);
        }

        // TODO: rather than gutwrenching into our MatrixCall's peerConnection,
        // should this be handled inside MatrixCall instead?
        //
        // FIXME: RPC reliability over DC
        const msg: ISfuDataChannelMessage = {
            "op": "select",
            "conf_id": this.groupCallId,
            "id": Date.now() + randomString(5),
            "start": streams,
        };

        call.dataChannel.send(JSON.stringify(msg));
        logger.warn("Sent select message over DC", msg);
    }

    public getDeviceForMember(userId: string): IGroupCallMemberDevice {
        const memberStateEvent = this.getMemberStateEvents(userId);

        if (!memberStateEvent) {
            return undefined;
        }

        const memberState = memberStateEvent.getContent<IGroupCallRoomMemberState>();
        const memberGroupCallState = memberState["m.calls"]?.find(
            (call) => call && call["m.call_id"] === this.groupCallId);

        if (!memberGroupCallState) {
            return undefined;
        }

        const memberDevices = memberGroupCallState["m.devices"];

        if (!memberDevices || memberDevices.length === 0) {
            return undefined;
        }

        // NOTE: For now we only support one device so we use the device id in the first source.
        return memberDevices[0];
    }

    private onRetryCallLoop = () => {
        for (const event of this.getMemberStateEvents()) {
            const memberId = event.getStateKey();
            const existingCall = this.calls.find((call) => getCallUserId(call) === memberId);
            const retryCallCount = this.retryCallCounts.get(memberId) || 0;

            if (!existingCall && retryCallCount < 3) {
                this.retryCallCounts.set(memberId, retryCallCount + 1);
                this.onMemberStateChanged(event);
            }
        }

        this.retryCallLoopTimeout = setTimeout(this.onRetryCallLoop, this.retryCallInterval);
    };

    /**
     * Call Event Handlers
     */

    public getCallByUserId(userId: string): MatrixCall {
        return this.calls.find((call) => getCallUserId(call) === userId);
    }

    private addCall(call: MatrixCall) {
        this.calls.push(call);
        this.initCall(call);
        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private replaceCall(existingCall: MatrixCall, replacementCall: MatrixCall, hangupReason = CallErrorCode.Replaced) {
        const existingCallIndex = this.calls.indexOf(existingCall);

        if (existingCallIndex === -1) {
            throw new Error("Couldn't find call to replace");
        }

        this.calls.splice(existingCallIndex, 1, replacementCall);

        this.disposeCall(existingCall, hangupReason);
        this.initCall(replacementCall);

        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private removeCall(call: MatrixCall, hangupReason: CallErrorCode) {
        this.disposeCall(call, hangupReason);

        const callIndex = this.calls.indexOf(call);

        if (callIndex === -1) {
            throw new Error("Couldn't find call to remove");
        }

        this.calls.splice(callIndex, 1);

        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private initCall(call: MatrixCall) {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot init call without user id");
        }

        const onCallFeedsChanged = () => this.onCallFeedsChanged(call);
        const onCallStateChanged =
            (state: CallState, oldState: CallState) => this.onCallStateChanged(call, state, oldState);
        const onCallHangup = this.onCallHangup;
        const onCallReplaced = (newCall: MatrixCall) => this.replaceCall(call, newCall);

        this.callHandlers.set(opponentMemberId, {
            onCallFeedsChanged,
            onCallStateChanged,
            onCallHangup,
            onCallReplaced,
        });

        call.on(CallEvent.FeedsChanged, onCallFeedsChanged);
        call.on(CallEvent.State, onCallStateChanged);
        call.on(CallEvent.Hangup, onCallHangup);
        call.on(CallEvent.Replaced, onCallReplaced);

        this.reEmitter.reEmit(call, Object.values(CallEvent));

        onCallFeedsChanged();
    }

    private disposeCall(call: MatrixCall, hangupReason: CallErrorCode) {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot dispose call without user id");
        }

        // FIXME: We need a queue for onMemberStateEvent as if two events are
        // received in rapid succession, we get two calls
        const callHandlers = this.callHandlers.get(opponentMemberId);
        if (!callHandlers) return;
        const {
            onCallFeedsChanged,
            onCallStateChanged,
            onCallHangup,
            onCallReplaced,
        } = callHandlers;

        call.removeListener(CallEvent.FeedsChanged, onCallFeedsChanged);
        call.removeListener(CallEvent.State, onCallStateChanged);
        call.removeListener(CallEvent.Hangup, onCallHangup);
        call.removeListener(CallEvent.Replaced, onCallReplaced);

        this.callHandlers.delete(opponentMemberId);

        if (call.hangupReason === CallErrorCode.Replaced) {
            return;
        }

        if (call.state !== CallState.Ended) {
            call.hangup(hangupReason, false);
        }

        const usermediaFeed = this.getUserMediaFeedByUserId(opponentMemberId);

        if (usermediaFeed) {
            this.removeUserMediaFeed(usermediaFeed);
        }

        const screenshareFeed = this.getScreenshareFeedByUserId(opponentMemberId);

        if (screenshareFeed) {
            this.removeScreenshareFeed(screenshareFeed);
        }
    }

    private onCallFeedsChanged = (call: MatrixCall) => {
        // Find removed feeds
        [...this.userMediaFeeds, ...this.screenshareFeeds].filter((gf) => gf.isDisposed()).forEach((feed) => {
            if (feed.purpose === SDPStreamMetadataPurpose.Usermedia) this.removeUserMediaFeed(feed);
            else if (feed.purpose === SDPStreamMetadataPurpose.Screenshare) this.removeScreenshareFeed(feed);
        });

        // Find new feeds
        call.getRemoteFeeds().filter((cf) => {
            return !this.userMediaFeeds.find((gf) => gf.stream.id === cf.stream.id);
        }).forEach((feed) => {
            if (feed.purpose === SDPStreamMetadataPurpose.Usermedia) this.addUserMediaFeed(feed);
            else if (feed.purpose === SDPStreamMetadataPurpose.Screenshare) this.addScreenshareFeed(feed);
        });
    };

    private onCallStateChanged = (call: MatrixCall, state: CallState, _oldState: CallState) => {
        const audioMuted = this.localCallFeed.isAudioMuted();

        if (
            call.localUsermediaStream &&
            call.isMicrophoneMuted() !== audioMuted
        ) {
            call.setMicrophoneMuted(audioMuted);
        }

        const videoMuted = this.localCallFeed.isVideoMuted();

        if (
            call.localUsermediaStream &&
            call.isLocalVideoMuted() !== videoMuted
        ) {
            call.setLocalVideoMuted(videoMuted);
        }

        if (state === CallState.Connected) {
            this.retryCallCounts.delete(getCallUserId(call));

            // Now we know what our track IDs are, we can publish them so others
            // can subscribe to us...
            this.sendMemberStateEvent();

            // if we're calling an SFU, subscribe to its feeds
            if (call.getOpponentMember().userId === this.client.localSfu) {
                this.subscribeToSFU(call, this.getRemoteFeedsFromState());
            }
        }
    };

    private onCallHangup = (call: MatrixCall) => {
        if (call.hangupReason === CallErrorCode.Replaced) {
            return;
        }

        this.removeCall(call, call.hangupReason as CallErrorCode);
    };

    /**
     * UserMedia CallFeed Event Handlers
     */

    public getUserMediaFeedByUserId(userId: string) {
        return this.userMediaFeeds.find((feed) => feed.userId === userId);
    }

    private addUserMediaFeed(callFeed: CallFeed) {
        this.userMediaFeeds.push(callFeed);
        callFeed.measureVolumeActivity(true);
        this.emit(GroupCallEvent.UserMediaFeedsChanged, this.userMediaFeeds);
    }

    private removeUserMediaFeed(callFeed: CallFeed) {
        const feedIndex = this.userMediaFeeds.findIndex((feed) => feed.userId === callFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find user media feed to remove");
        }

        this.userMediaFeeds.splice(feedIndex, 1);

        callFeed.dispose();
        this.emit(GroupCallEvent.UserMediaFeedsChanged, this.userMediaFeeds);

        if (
            this.activeSpeaker === callFeed.userId &&
            this.userMediaFeeds.length > 0
        ) {
            this.activeSpeaker = this.userMediaFeeds[0].userId;
            this.emit(GroupCallEvent.ActiveSpeakerChanged, this.activeSpeaker);
        }
    }

    private onActiveSpeakerLoop = () => {
        let topAvg: number;
        let nextActiveSpeaker: string;

        for (const callFeed of this.userMediaFeeds) {
            if (callFeed.userId === this.client.getUserId() && this.userMediaFeeds.length > 1) {
                continue;
            }

            let total = 0;

            for (let i = 0; i < callFeed.speakingVolumeSamples.length; i++) {
                const volume = callFeed.speakingVolumeSamples[i];
                total += Math.max(volume, SPEAKING_THRESHOLD);
            }

            const avg = total / callFeed.speakingVolumeSamples.length;

            if (!topAvg || avg > topAvg) {
                topAvg = avg;
                nextActiveSpeaker = callFeed.userId;
            }
        }

        if (nextActiveSpeaker && this.activeSpeaker !== nextActiveSpeaker && topAvg > SPEAKING_THRESHOLD) {
            this.activeSpeaker = nextActiveSpeaker;
            this.emit(GroupCallEvent.ActiveSpeakerChanged, this.activeSpeaker);
        }

        this.activeSpeakerLoopTimeout = setTimeout(
            this.onActiveSpeakerLoop,
            this.activeSpeakerInterval,
        );
    };

    /**
     * Screenshare Call Feed Event Handlers
     */

    public getScreenshareFeedByUserId(userId: string) {
        return this.screenshareFeeds.find((feed) => feed.userId === userId);
    }

    private addScreenshareFeed(callFeed: CallFeed) {
        this.screenshareFeeds.push(callFeed);
        this.emit(GroupCallEvent.ScreenshareFeedsChanged, this.screenshareFeeds);
    }

    private removeScreenshareFeed(callFeed: CallFeed) {
        const feedIndex = this.screenshareFeeds.findIndex((feed) => feed.userId === callFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find screenshare feed to remove");
        }

        this.screenshareFeeds.splice(feedIndex, 1);

        callFeed.dispose();
        this.emit(GroupCallEvent.ScreenshareFeedsChanged, this.screenshareFeeds);
    }

    /**
     * Participant Management
     */

    private addParticipant(member: RoomMember) {
        if (this.participants.find((m) => m.userId === member.userId)) {
            return;
        }

        this.participants.push(member);

        this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        this.client.emit(GroupCallEventHandlerEvent.Participants, this.participants, this);
    }

    private removeParticipant(member: RoomMember) {
        const index = this.participants.findIndex((m) => m.userId === member.userId);

        if (index === -1) {
            return;
        }

        this.participants.splice(index, 1);

        this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        this.client.emit(GroupCallEventHandlerEvent.Participants, this.participants, this);
    }
}
