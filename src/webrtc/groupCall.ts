import EventEmitter from "events";
import { CallFeed, SPEAKING_THRESHOLD } from "./callFeed";
import { MatrixClient } from "../client";
import { CallErrorCode, CallEvent, CallState, genCallID, MatrixCall, setTracksEnabled } from "./call";
import { RoomMember } from "../models/room-member";
import { Room } from "../models/room";
import { logger } from "../logger";
import { ReEmitter } from "../ReEmitter";
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { createNewMatrixCall } from "./call";
import { ISendEventResponse } from "../@types/requests";
import { MatrixEvent } from "../models/event";
import { EventType } from "../@types/event";

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
    Error = "error"
}

export enum GroupCallErrorCode {
    NoUserMedia = "no_user_media",
    UnknownDevice = "unknown_device"
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

export interface IGroupCallDataChannelOptions {
    ordered: boolean;
    maxPacketLifeTime: number;
    maxRetransmits: number;
    protocol: string;
}

export interface IGroupCallRoomMemberFeed {
    purpose: SDPStreamMetadataPurpose;
    // TODO: Sources for adaptive bitrate
}

export interface IGroupCallRoomMemberDevice {
    "device_id": string;
    "session_id": string;
    "feeds": IGroupCallRoomMemberFeed[];
}

export interface IGroupCallRoomMemberCallState {
    "m.call_id": string;
    "m.foci"?: string[];
    "m.devices": IGroupCallRoomMemberDevice[];
}

export interface IGroupCallRoomMemberState {
    "m.calls": IGroupCallRoomMemberCallState[];
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

function getCallUserId(call: MatrixCall): string | null {
    return call.getOpponentMember()?.userId || call.invitee || null;
}

export class GroupCall extends EventEmitter {
    // Config
    public activeSpeakerInterval = 1000;
    public retryCallInterval = 5000;
    public participantTimeout = 1000 * 15;

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
    private activeSpeakerLoopTimeout?: number;
    private retryCallLoopTimeout?: number;
    private retryCallCounts: Map<string, number> = new Map();
    private reEmitter: ReEmitter;

    constructor(
        private client: MatrixClient,
        public room: Room,
        public type: GroupCallType,
        public intent: GroupCallIntent,
        groupCallId?: string,
        private dataChannelsEnabled?: boolean,
        private dataChannelOptions?: IGroupCallDataChannelOptions,
    ) {
        super();
        this.reEmitter = new ReEmitter(this);
        this.groupCallId = groupCallId || genCallID();

        const roomState = this.room.currentState;
        const memberStateEvents = roomState.getStateEvents(EventType.GroupCallMemberPrefix);

        for (const stateEvent of memberStateEvents) {
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

        const userId = this.client.getUserId();

        const callFeed = new CallFeed({
            client: this.client,
            roomId: this.room.roomId,
            userId,
            stream,
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: stream.getAudioTracks().length === 0,
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

        this.client.on("Call.incoming", this.onIncomingCall);

        const calls = this.client.callEventHandler.calls.values();

        for (const call of calls) {
            this.onIncomingCall(call);
        }

        // Set up participants for the members currently in the room.
        // Other members will be picked up by the RoomState.members event.
        const roomState = this.room.currentState;
        const memberStateEvents = roomState.getStateEvents(EventType.GroupCallMemberPrefix);

        for (const stateEvent of memberStateEvents) {
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

        this.client.removeListener("Call.incoming", this.onIncomingCall);
    }

    public leave() {
        this.dispose();
        this.setState(GroupCallState.LocalCallFeedUninitialized);
    }

    public async terminate(emitStateEvent = true) {
        this.dispose();

        this.participants = [];
        this.client.removeListener(
            "RoomState.members",
            this.onMemberStateChanged,
        );

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

        this.client.emit("GroupCall.ended", this);
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

    public async setMicrophoneMuted(muted) {
        if (!await this.client.getMediaHandler().hasAudioDevice()) {
            return false;
        }

        if (this.localCallFeed) {
            logger.log(`groupCall ${this.groupCallId} setMicrophoneMuted stream ${
                this.localCallFeed.stream.id} muted ${muted}`);
            this.localCallFeed.setAudioMuted(muted);
            setTracksEnabled(this.localCallFeed.stream.getAudioTracks(), !muted);
        }

        for (const call of this.calls) {
            call.setMicrophoneMuted(muted);
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, muted, this.isLocalVideoMuted());
    }

    public async setLocalVideoMuted(muted) {
        if (!await this.client.getMediaHandler().hasVideoDevice()) {
            return false;
        }

        if (this.localCallFeed) {
            logger.log(`groupCall ${this.groupCallId} setLocalVideoMuted stream ${
                this.localCallFeed.stream.id} muted ${muted}`);
            this.localCallFeed.setVideoMuted(muted);
            setTracksEnabled(this.localCallFeed.stream.getVideoTracks(), !muted);
        }

        for (const call of this.calls) {
            call.setLocalVideoMuted(muted);
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, this.isMicrophoneMuted(), muted);
    }

    public async setScreensharingEnabled(
        enabled: boolean, desktopCapturerSourceId?: string,
    ): Promise<boolean> {
        if (enabled === this.isScreensharing()) {
            return enabled;
        }

        if (enabled) {
            try {
                logger.log("Asking for screensharing permissions...");

                const stream = await this.client.getMediaHandler().getScreensharingStream(desktopCapturerSourceId);

                for (const track of stream.getTracks()) {
                    const onTrackEnded = () => {
                        this.setScreensharingEnabled(false);
                        track.removeEventListener("ended", onTrackEnded);
                    };

                    track.addEventListener("ended", onTrackEnded);
                }

                logger.log("Screensharing permissions granted. Setting screensharing enabled on all calls");

                this.localDesktopCapturerSourceId = desktopCapturerSourceId;
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
                await Promise.all(this.calls.map(call => call.pushLocalFeed(this.localScreenshareFeed.clone())));

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

        // Check if the user calling has an existing call and use this call instead.
        if (existingCall) {
            this.replaceCall(existingCall, newCall);
        } else {
            this.addCall(newCall);
        }

        // Safari can't send a MediaStream to multiple sources, so clone it
        newCall.answerWithCallFeeds(this.getLocalFeeds().map((feed) => feed.clone()));
    };

    /**
     * Room Member State
     */

    private sendMemberStateEvent(): Promise<ISendEventResponse> {
        const deviceId = this.client.getDeviceId();

        return this.updateMemberCallState({
            "m.call_id": this.groupCallId,
            "m.devices": [
                {
                    "device_id": deviceId,
                    "session_id": this.client.getSessionId(),
                    "feeds": this.getLocalFeeds().map((feed) => ({
                        purpose: feed.purpose,
                    })),
                    // TODO: Add data channels
                },
            ],
            // TODO "m.foci"
        });
    }

    private removeMemberStateEvent(): Promise<ISendEventResponse> {
        return this.updateMemberCallState(undefined);
    }

    private async updateMemberCallState(memberCallState?: IGroupCallRoomMemberCallState): Promise<ISendEventResponse> {
        const localUserId = this.client.getUserId();

        const currentStateEvent = this.room.currentState.getStateEvents(EventType.GroupCallMemberPrefix, localUserId);
        const memberStateEvent = currentStateEvent?.getContent<IGroupCallRoomMemberState>();

        let calls: IGroupCallRoomMemberCallState[] = [];

        // Sanitize existing member state event
        if (memberStateEvent && Array.isArray(memberStateEvent["m.calls"])) {
            calls = memberStateEvent["m.calls"].filter((call) => !!call);
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
        };

        return this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, content, localUserId);
    }

    public onMemberStateChanged = (event: MatrixEvent) => {
        // The member events may be received for another room, which we will ignore.
        if (event.getRoomId() !== this.room.roomId) {
            return;
        }

        const member = this.room.getMember(event.getStateKey());

        if (!member) {
            return;
        }

        let callsState = event.getContent<IGroupCallRoomMemberState>()["m.calls"];

        if (Array.isArray(callsState)) {
            callsState = callsState.filter((call) => !!call);
        }

        if (!Array.isArray(callsState) || callsState.length === 0) {
            logger.warn(`Ignoring member state from ${member.userId} member not in any calls.`);
            this.removeParticipant(member);
            return;
        }

        // Currently we only support a single call per room. So grab the first call.
        const callState = callsState[0];

        const callId = callState["m.call_id"];

        if (!callId) {
            logger.warn(`Room member ${member.userId} does not have a valid m.call_id set. Ignoring.`);
            this.removeParticipant(member);
            return;
        }

        if (callId !== this.groupCallId) {
            logger.warn(`Call id ${callId} does not match group call id ${this.groupCallId}, ignoring.`);
            this.removeParticipant(member);
            return;
        }

        this.addParticipant(member);

        // Don't process your own member.
        const localUserId = this.client.getUserId();

        if (member.userId === localUserId) {
            return;
        }

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        // Only initiate a call with a user who has a userId that is lexicographically
        // less than your own. Otherwise, that user will call you.
        if (member.userId < localUserId) {
            logger.log(`Waiting for ${member.userId} to send call invite.`);
            return;
        }

        const opponentDevice = this.getDeviceForMember(member.userId);

        if (!opponentDevice) {
            logger.warn(`No opponent device found for ${member.userId}, ignoring.`);
            this.emit(
                GroupCallEvent.Error,
                new GroupCallError(
                    GroupCallErrorCode.UnknownDevice,
                    `Outgoing Call: No opponent device found for ${member.userId}, ignoring.`,
                ),
            );
            return;
        }

        const existingCall = this.getCallByUserId(member.userId);

        if (
            existingCall &&
            existingCall.getOpponentSessionId() === opponentDevice.session_id
        ) {
            return;
        }

        const newCall = createNewMatrixCall(
            this.client,
            this.room.roomId,
            {
                invitee: member.userId,
                opponentDeviceId: opponentDevice.device_id,
                opponentSessionId: opponentDevice.session_id,
                groupCallId: this.groupCallId,
            },
        );

        const requestScreenshareFeed = opponentDevice.feeds.some(
            (feed) => feed.purpose === SDPStreamMetadataPurpose.Screenshare);

        // Safari can't send a MediaStream to multiple sources, so clone it
        newCall.placeCallWithCallFeeds(this.getLocalFeeds().map(feed => feed.clone()), requestScreenshareFeed);

        if (this.dataChannelsEnabled) {
            newCall.createDataChannel("datachannel", this.dataChannelOptions);
        }

        if (existingCall) {
            this.replaceCall(existingCall, newCall, CallErrorCode.NewSession);
        } else {
            this.addCall(newCall);
        }
    };

    public getDeviceForMember(userId: string): IGroupCallRoomMemberDevice {
        const memberStateEvent = this.room.currentState.getStateEvents(EventType.GroupCallMemberPrefix, userId);

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
        const roomState = this.room.currentState;
        const memberStateEvents = roomState.getStateEvents(EventType.GroupCallMemberPrefix);

        for (const event of memberStateEvents) {
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

        const {
            onCallFeedsChanged,
            onCallStateChanged,
            onCallHangup,
            onCallReplaced,
        } = this.callHandlers.get(opponentMemberId);

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
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot change call feeds without user id");
        }

        const currentUserMediaFeed = this.getUserMediaFeedByUserId(opponentMemberId);
        const remoteUsermediaFeed = call.remoteUsermediaFeed;
        const remoteFeedChanged = remoteUsermediaFeed !== currentUserMediaFeed;

        if (remoteFeedChanged) {
            if (!currentUserMediaFeed && remoteUsermediaFeed) {
                this.addUserMediaFeed(remoteUsermediaFeed);
            } else if (currentUserMediaFeed && remoteUsermediaFeed) {
                this.replaceUserMediaFeed(currentUserMediaFeed, remoteUsermediaFeed);
            } else if (currentUserMediaFeed && !remoteUsermediaFeed) {
                this.removeUserMediaFeed(currentUserMediaFeed);
            }
        }

        const currentScreenshareFeed = this.getScreenshareFeedByUserId(opponentMemberId);
        const remoteScreensharingFeed = call.remoteScreensharingFeed;
        const remoteScreenshareFeedChanged = remoteScreensharingFeed !== currentScreenshareFeed;

        if (remoteScreenshareFeedChanged) {
            if (!currentScreenshareFeed && remoteScreensharingFeed) {
                this.addScreenshareFeed(remoteScreensharingFeed);
            } else if (currentScreenshareFeed && remoteScreensharingFeed) {
                this.replaceScreenshareFeed(currentScreenshareFeed, remoteScreensharingFeed);
            } else if (currentScreenshareFeed && !remoteScreensharingFeed) {
                this.removeScreenshareFeed(currentScreenshareFeed);
            }
        }
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

    private replaceUserMediaFeed(existingFeed: CallFeed, replacementFeed: CallFeed) {
        const feedIndex = this.userMediaFeeds.findIndex((feed) => feed.userId === existingFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find user media feed to replace");
        }

        this.userMediaFeeds.splice(feedIndex, 1, replacementFeed);

        existingFeed.dispose();
        replacementFeed.measureVolumeActivity(true);
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

    private replaceScreenshareFeed(existingFeed: CallFeed, replacementFeed: CallFeed) {
        const feedIndex = this.screenshareFeeds.findIndex((feed) => feed.userId === existingFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find screenshare feed to replace");
        }

        this.screenshareFeeds.splice(feedIndex, 1, replacementFeed);

        existingFeed.dispose();
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
        this.client.emit("GroupCall.participants", this.participants, this);
    }

    private removeParticipant(member: RoomMember) {
        const index = this.participants.findIndex((m) => m.userId === member.userId);

        if (index === -1) {
            return;
        }

        this.participants.splice(index, 1);

        this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        this.client.emit("GroupCall.participants", this.participants, this);
    }
}
